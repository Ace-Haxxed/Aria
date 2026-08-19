//! Driving the fine-tuning sidecar.
//!
//! Training runs in Python because nothing in the Rust ecosystem can do LoRA
//! on quantised weights. This spawns `scripts/finetune.py`, reads the JSON
//! events it prints, and forwards them to the UI — so the loss curve the user
//! watches is the trainer's real output, not an animation.
//!
//! The process is detached from the request that started it: training takes
//! minutes to an hour, and the app stays usable throughout.

use crate::util::{JResult, NovaError};
use serde::Serialize;
use serde_json::Value;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

/// PID of the running trainer, so it can be stopped.
static RUNNING_PID: AtomicU32 = AtomicU32::new(0);
/// Where the script lives, resolved once.
static SCRIPT: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Find `finetune.py`.
///
/// Checked in the order that puts a developer's checkout first and the
/// installed copy second, so running from source does not pick up a stale
/// bundled script.
fn script_path() -> JResult<std::path::PathBuf> {
    if let Some(cached) = lock(&SCRIPT).clone() {
        if cached.exists() {
            return Ok(cached);
        }
    }

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // Alongside the executable, which is where the bundle puts it.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("scripts/finetune.py"));
            candidates.push(dir.join("finetune.py"));
            // A cargo target directory sits three levels below the crate root.
            candidates.push(dir.join("../../../scripts/finetune.py"));
            candidates.push(dir.join("../../../../scripts/finetune.py"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts/finetune.py"));
        candidates.push(cwd.join("../scripts/finetune.py"));
    }

    for candidate in candidates {
        if candidate.exists() {
            let resolved = candidate.canonicalize().unwrap_or(candidate);
            *lock(&SCRIPT) = Some(resolved.clone());
            return Ok(resolved);
        }
    }

    Err(NovaError::msg(
        "The training script is missing from this installation. Reinstall NOVA, or run it from a source checkout.",
    ))
}

/// Which Python to use.
///
/// A virtualenv beside the script is preferred: training pulls in several
/// gigabytes of libraries, and putting those in the user's system Python is
/// rude. Falls back to whatever `python3` resolves to.
fn python() -> String {
    if let Ok(script) = script_path() {
        if let Some(dir) = script.parent() {
            for candidate in [
                dir.join("../.venv/bin/python3"),
                dir.join(".venv/bin/python3"),
            ] {
                if candidate.exists() {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
    }
    if cfg!(target_os = "windows") {
        "python".to_string()
    } else {
        "python3".to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingReadiness {
    pub python_available: bool,
    pub python_version: String,
    pub gpu: bool,
    pub device: String,
    /// "unsloth", "transformers", or null when nothing is installed yet.
    pub backend: Option<String>,
    /// True when training could start right now.
    pub ready: bool,
    pub pairs: u32,
    pub estimated_minutes: u32,
    /// Populated when Python itself is missing, which is the one problem the
    /// app cannot fix for the user.
    pub problem: Option<String>,
}

/// Ask the script what this machine can do.
#[tauri::command]
pub async fn check_finetune_support() -> JResult<TrainingReadiness> {
    let script = match script_path() {
        Ok(path) => path,
        Err(e) => {
            return Ok(TrainingReadiness {
                python_available: false,
                python_version: String::new(),
                gpu: false,
                device: String::new(),
                backend: None,
                ready: false,
                pairs: 0,
                estimated_minutes: 0,
                problem: Some(e.to_string()),
            })
        }
    };

    let data = super::training::dataset_path()?;
    let output = tokio::process::Command::new(python())
        .arg(&script)
        .arg("--check")
        .arg("--data")
        .arg(&data)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;

    let Ok(output) = output else {
        return Ok(TrainingReadiness {
            python_available: false,
            python_version: String::new(),
            gpu: false,
            device: String::new(),
            backend: None,
            ready: false,
            pairs: 0,
            estimated_minutes: 0,
            problem: Some(
                "Python 3 is not installed. Fine-tuning needs it; everything else in NOVA works without it."
                    .into(),
            ),
        });
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let parsed: Option<Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v.get("event").and_then(|e| e.as_str()) == Some("check"));

    let Some(check) = parsed else {
        return Ok(TrainingReadiness {
            python_available: false,
            python_version: String::new(),
            gpu: false,
            device: String::new(),
            backend: None,
            ready: false,
            pairs: 0,
            estimated_minutes: 0,
            problem: Some("The training script did not report its status.".into()),
        });
    };

    Ok(TrainingReadiness {
        python_available: true,
        python_version: check["python"].as_str().unwrap_or_default().to_string(),
        gpu: check["gpu"].as_bool().unwrap_or(false),
        device: check["device"].as_str().unwrap_or_default().to_string(),
        backend: check["backend"].as_str().map(String::from),
        ready: check["ready"].as_bool().unwrap_or(false),
        pairs: check["pairs"].as_u64().unwrap_or(0) as u32,
        estimated_minutes: check["estimated_minutes"].as_u64().unwrap_or(0) as u32,
        problem: None,
    })
}

/// Where trained adapters live.
pub fn adapters_dir() -> JResult<std::path::PathBuf> {
    let dir = super::models::models_dir()?.join("adapters");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub name: String,
    pub path: String,
    /// Unix seconds, for "trained 3 days ago".
    pub trained_at: u64,
    pub size_bytes: u64,
}

#[tauri::command]
pub async fn list_adapters() -> JResult<Vec<Adapter>> {
    let dir = adapters_dir()?;
    let mut out = Vec::new();

    for entry in std::fs::read_dir(&dir)?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        // A directory without adapter weights is a cancelled or failed run.
        let has_weights = ["adapter_model.safetensors", "adapter_model.bin"]
            .iter()
            .any(|f| path.join(f).exists());
        if !has_weights {
            continue;
        }

        let metadata = entry.metadata().ok();
        let trained_at = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        out.push(Adapter {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            trained_at,
            size_bytes: directory_size(&path),
        });
    }

    // Newest first.
    out.sort_by_key(|a| std::cmp::Reverse(a.trained_at));
    Ok(out)
}

fn directory_size(path: &std::path::Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Start a training run. Returns as soon as it is underway.
#[tauri::command]
pub async fn start_finetuning(
    app: AppHandle,
    name: String,
    base_model: Option<String>,
    epochs: Option<u32>,
    learning_rate: Option<f64>,
    auto_install: Option<bool>,
) -> JResult<String> {
    if RUNNING_PID.load(Ordering::Relaxed) != 0 {
        return Err(NovaError::msg("A fine-tune is already running."));
    }

    let script = script_path()?;
    let data = super::training::dataset_path()?;
    if !data.exists() {
        return Err(NovaError::msg(
            "There are no saved conversations to train on yet. Turn on training capture in Settings → Privacy.",
        ));
    }

    // Sanitise: this becomes a directory name.
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let safe = if safe.trim_matches('-').is_empty() {
        format!("my-nova-{}", chrono::Utc::now().format("%Y%m%d"))
    } else {
        safe
    };

    let output = adapters_dir()?.join(&safe);

    let mut command = tokio::process::Command::new(python());
    command
        .arg(&script)
        .arg("--data")
        .arg(&data)
        .arg("--output")
        .arg(&output)
        .arg("--epochs")
        .arg(epochs.unwrap_or(3).to_string())
        .arg("--learning-rate")
        .arg(learning_rate.unwrap_or(2e-4).to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    if let Some(model) = base_model.filter(|m| !m.is_empty()) {
        command.arg("--model").arg(model);
    }
    if auto_install.unwrap_or(false) {
        command.arg("--auto-install");
    }

    // Unbuffered, so progress arrives as it happens rather than at exit.
    command.env("PYTHONUNBUFFERED", "1");

    let mut child = command.spawn().map_err(|e| {
        NovaError::msg(format!(
            "Python could not be started ({e}). Fine-tuning needs Python 3; the rest of NOVA does not."
        ))
    })?;

    RUNNING_PID.store(child.id().unwrap_or(0), Ordering::Relaxed);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let output_path = output.to_string_lossy().to_string();

    tauri::async_runtime::spawn(async move {
        // stderr is drained separately: pip and torch write warnings there,
        // and a full pipe would block the child mid-training.
        if let Some(stderr) = stderr {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(_)) = lines.next_line().await {}
            });
        }

        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // Every meaningful line is one JSON event. Anything else is a
                // library writing to stdout and is ignored rather than shown.
                if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                    let _ = app.emit("finetune-progress", value);
                }
            }
        }

        let status = child.wait().await;
        RUNNING_PID.store(0, Ordering::Relaxed);

        let ok = status.map(|s| s.success()).unwrap_or(false);
        let _ = app.emit(
            "finetune-progress",
            serde_json::json!({
                "event": if ok { "finished" } else { "failed" },
                "output": output_path,
            }),
        );
    });

    Ok(output.to_string_lossy().to_string())
}

/// Stop a run in progress. The partial adapter is discarded.
#[tauri::command]
pub async fn cancel_finetuning() -> JResult<()> {
    let pid = RUNNING_PID.swap(0, Ordering::Relaxed);
    if pid == 0 {
        return Ok(());
    }

    #[cfg(unix)]
    {
        // SIGTERM: the script catches KeyboardInterrupt and exits cleanly,
        // which lets it release the GPU rather than being killed holding it.
        let _ = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_adapter(name: String) -> JResult<()> {
    let path = adapters_dir()?.join(&name);
    if !path.exists() {
        return Ok(());
    }
    // Confirm it is inside the adapters directory before removing anything.
    let base = adapters_dir()?.canonicalize()?;
    let target = path.canonicalize()?;
    if !target.starts_with(&base) {
        return Err(NovaError::msg("That is not a NOVA adapter."));
    }

    trash::delete(&target)
        .map_err(|e| NovaError::msg(format!("Could not remove the model: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_names_cannot_escape_the_directory() {
        // The name becomes a path, so traversal has to be impossible.
        let hostile = "../../etc/passwd";
        let safe: String = hostile
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
        assert!(!safe.contains('/'));
        assert!(!safe.contains(".."));
    }

    #[test]
    fn an_empty_name_gets_a_dated_default() {
        let name = "///";
        let safe: String = name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
        assert!(safe.trim_matches('-').is_empty(), "should fall through to the default");
    }

    #[test]
    fn python_is_resolved_per_platform() {
        let interpreter = python();
        assert!(
            interpreter.contains("python"),
            "unexpected interpreter: {interpreter}"
        );
    }
}
