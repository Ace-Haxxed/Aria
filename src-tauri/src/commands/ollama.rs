//! Ollama lifecycle: detect it, start it, install it, and pull a model.
//!
//! Ollama is the only backend that has to be *managed* rather than merely
//! called — it is a local server that may be absent, installed but stopped, or
//! running without the model the user picked. Each of those is a different
//! problem with a different fix, so they are detected separately and each one
//! is repaired without the user opening a terminal.

use crate::platform::detect::{OsKind, PackageManager};
use crate::util::{has, run, spawn_detached, JResult, AriaError};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";

/// How long to wait for a freshly started server to accept connections, and
/// how often to ask. Ollama loads its model index at startup, so a cold start
/// on a machine with many models is not instant.
const START_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Which model to reach for when the user has not chosen, best first.
///
/// Ordered by usefulness for an assistant that has to call tools: the 8B
/// Llama 3.1 builds handle function calling reliably, plain `llama3` less so,
/// and Mistral is the best of the remaining common downloads. Anything else
/// installed is still better than refusing to run.
const MODEL_PREFERENCE: &[&str] = &["llama3.1:8b", "llama3:8b", "llama3", "mistral"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    /// Is the server answering right now?
    pub running: bool,
    /// Is the `ollama` binary present at all? Distinguishes "start it" from
    /// "install it", which are very different asks of the user.
    pub installed: bool,
    /// Models already pulled, so the UI never offers one that is absent.
    pub models: Vec<String>,
    /// The best installed model, or `None` when nothing is pulled. The UI
    /// selects this rather than assuming a name that may not exist.
    pub preferred: Option<String>,
    /// Round-trip time of the probe, shown next to the connection status.
    pub latency_ms: u64,
}

/// Pick the best model from what is actually installed.
///
/// Matching is prefix-based because Ollama tags everything: a machine with
/// `llama3.1:8b-instruct-q4_0` should still be recognised as having the model
/// we prefer, rather than being told to download a second copy of it.
pub fn preferred_model(models: &[String]) -> Option<String> {
    for wanted in MODEL_PREFERENCE {
        // Exact match first, so `llama3.1:8b` beats `llama3.1:8b-q4_0`.
        if let Some(hit) = models.iter().find(|m| m.as_str() == *wanted) {
            return Some(hit.clone());
        }
        if let Some(hit) = models
            .iter()
            .find(|m| m.starts_with(wanted) || m.starts_with(&format!("{wanted}:")))
        {
            return Some(hit.clone());
        }
    }
    models.first().cloned()
}

fn base_url(custom: Option<String>) -> String {
    custom
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Ask the server which models it has. Doubles as the liveness probe: a
/// successful reply is proof it is up *and* tells us what it can run.
async fn fetch_models(base: &str) -> Option<Vec<String>> {
    // Short: this runs on every launch and must never delay the UI.
    fetch_models_with_timeout(base, 2_500).await
}

async fn fetch_models_with_timeout(base: &str, timeout_ms: u64) -> Option<Vec<String>> {
    let reply = super::llm::http_request(
        "GET".into(),
        format!("{base}/api/tags"),
        None,
        None,
        Some(timeout_ms),
    )
    .await
    .ok()?;

    if !reply.ok {
        return None;
    }

    let parsed: Value = serde_json::from_str(&reply.body).ok()?;
    Some(
        parsed
            .get("models")
            .and_then(|m| m.as_array())
            .map(|models| {
                models
                    .iter()
                    .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
                    .filter(|name| is_runnable_locally(name))
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// Can this entry actually run on this machine?
///
/// Ollama lists cloud-hosted models (`minimax-m3:cloud` and friends) alongside
/// local ones in `/api/tags`, but they are proxied to Ollama's servers and need
/// a signed-in account. Offering one as a "local, private, offline" model would
/// be wrong on all three counts, and picking one automatically would fail with
/// an authentication error the user has no way to interpret.
fn is_runnable_locally(name: &str) -> bool {
    // Two spellings are in use: a bare `:cloud` tag (`minimax-m3:cloud`) and a
    // size-qualified one (`gpt-oss:120b-cloud`). Both mark the same thing, so
    // the check is on the tag rather than on the whole name.
    let tag = name.rsplit_once(':').map(|(_, tag)| tag).unwrap_or("");
    !(tag == "cloud" || tag.ends_with("-cloud"))
}

/// Is Ollama running, and what can it run?
#[tauri::command]
pub async fn check_ollama(base_url_override: Option<String>) -> JResult<OllamaStatus> {
    let base = base_url(base_url_override);
    let started = std::time::Instant::now();
    let models = fetch_models(&base).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    Ok(OllamaStatus {
        running: models.is_some(),
        // A remote endpoint has no local binary, so a running server counts as
        // installed regardless of what is on this machine's PATH.
        installed: has("ollama") || models.is_some(),
        preferred: models.as_deref().and_then(preferred_model),
        models: models.unwrap_or_default(),
        latency_ms,
    })
}

/// Does this server actually have `model`?
///
/// Called before a conversation starts. Ollama answers a chat request for an
/// unknown model with a 404 that reads like a server fault, so checking first
/// turns a confusing failure into a silent switch to something installed.
#[tauri::command]
pub async fn ollama_has_model(model: String, base_url_override: Option<String>) -> JResult<bool> {
    let base = base_url(base_url_override);
    let reply = super::llm::http_request(
        "POST".into(),
        format!("{base}/api/show"),
        None,
        Some(serde_json::json!({ "model": model }).to_string()),
        Some(5_000),
    )
    .await?;
    Ok(reply.ok)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointTest {
    pub ok: bool,
    pub latency_ms: u64,
    pub models: Vec<String>,
    /// Always populated: a confirmation, or a reason with a next step.
    pub message: String,
}

/// Check an Ollama endpoint before the user commits to it.
///
/// Supports a LAN address or a hosted server as readily as localhost — the
/// only difference is how long it takes to answer, so nothing here assumes the
/// server is local.
#[tauri::command]
pub async fn test_ollama_endpoint(url: String) -> JResult<EndpointTest> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(EndpointTest {
            ok: false,
            latency_ms: 0,
            models: Vec::new(),
            message: "Enter an address, for example http://localhost:11434".into(),
        });
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Ok(EndpointTest {
            ok: false,
            latency_ms: 0,
            models: Vec::new(),
            message: "The address needs to start with http:// or https://".into(),
        });
    }

    let base = base_url(Some(trimmed.to_string()));
    let started = std::time::Instant::now();
    let models = fetch_models_with_timeout(&base, 8_000).await;
    let latency_ms = started.elapsed().as_millis() as u64;

    match models {
        Some(models) if models.is_empty() => Ok(EndpointTest {
            ok: true,
            latency_ms,
            models,
            message: format!("Reached in {latency_ms} ms, but no models are installed there yet."),
        }),
        Some(models) => Ok(EndpointTest {
            message: format!(
                "Connected in {latency_ms} ms — {} model{} available.",
                models.len(),
                if models.len() == 1 { "" } else { "s" }
            ),
            ok: true,
            latency_ms,
            models,
        }),
        None => Ok(EndpointTest {
            ok: false,
            latency_ms,
            models: Vec::new(),
            message: "Nothing answered at that address. Check it is running and reachable from this machine.".into(),
        }),
    }
}

/// Try to get Ollama running, and report what happened.
///
/// Start strategies are tried cheapest-first: it may already be up; a systemd
/// unit may exist; otherwise the server is launched directly. Each is followed
/// by polling, because none of them are synchronous — `systemctl start`
/// returns before the socket is listening.
#[tauri::command]
pub async fn check_ollama_and_start(
    app: AppHandle,
    base_url_override: Option<String>,
) -> JResult<OllamaStatus> {
    let base = base_url(base_url_override.clone());
    let started = std::time::Instant::now();

    // Already running is the overwhelmingly common case; do not pay for the
    // rest of this function on every launch.
    if let Some(models) = fetch_models(&base).await {
        return Ok(OllamaStatus {
            running: true,
            installed: true,
            preferred: preferred_model(&models),
            models,
            latency_ms: started.elapsed().as_millis() as u64,
        });
    }

    // Nothing to start for a server that is not on this machine.
    if !has("ollama") {
        return Ok(OllamaStatus {
            running: false,
            installed: false,
            models: Vec::new(),
            preferred: None,
            latency_ms: started.elapsed().as_millis() as u64,
        });
    }

    let _ = app.emit("ollama-starting", "Starting local AI…");

    if crate::platform::info().os == OsKind::Linux {
        // A user unit is the common packaging on Linux and needs no privilege.
        // The system unit is tried too, but only if it is already enabled —
        // starting it would need root, and a GUI app must not prompt for that
        // silently.
        let _ = run("systemctl", &["--user", "start", "ollama"]).await;
        if fetch_models(&base).await.is_none() {
            let _ = run("systemctl", &["start", "--no-ask-password", "ollama"]).await;
        }
    }

    // Fall back to running the server ourselves. Detached, so it outlives
    // ARIA: a user who quits the app should not lose their model server.
    if fetch_models(&base).await.is_none() {
        let _ = spawn_detached("ollama", &["serve"]);
    }

    let deadline = std::time::Instant::now() + START_TIMEOUT;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(POLL_INTERVAL).await;
        if let Some(models) = fetch_models(&base).await {
            let _ = app.emit("ollama-ready", ());
            return Ok(OllamaStatus {
                running: true,
                installed: true,
                preferred: preferred_model(&models),
                models,
                latency_ms: started.elapsed().as_millis() as u64,
            });
        }
    }

    // Give up rather than block: the caller falls through to the next backend
    // in the chain, which is a better outcome than waiting indefinitely.
    Ok(OllamaStatus {
        running: false,
        installed: true,
        models: Vec::new(),
        preferred: None,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

/// Install Ollama with the machine's own package manager.
///
/// The upstream instructions pipe a script from the network into a root shell.
/// That is not something ARIA will do on a user's behalf: it cannot be
/// audited before it runs, and it needs a password on a terminal this app does
/// not have. The distro package is used instead, through the same polkit
/// prompt every other install in ARIA goes through, so the user sees a
/// normal system authentication dialog and can decline.
#[tauri::command]
pub async fn install_ollama() -> JResult<String> {
    if has("ollama") {
        return Ok("Ollama is already installed.".into());
    }

    let info = crate::platform::info();
    let package = match info.package_manager {
        PackageManager::Pacman | PackageManager::Dnf | PackageManager::Apt => "ollama",
        PackageManager::Brew => "ollama",
        PackageManager::Winget => "Ollama.Ollama",
        PackageManager::None => {
            return Err(AriaError::msg(
                "ARIA could not find a package manager to install Ollama with. \
                 Download it from https://ollama.com/download, then press Retry.",
            ))
        }
    };

    super::linux::install_package(package.to_string())
        .await
        .map_err(|e| {
            AriaError::msg(format!(
                "Ollama could not be installed automatically: {e} You can install it \
                 from https://ollama.com/download, or use a cloud provider instead."
            ))
        })?;

    if !has("ollama") {
        return Err(AriaError::msg(
            "The install finished but Ollama is still not on this system. \
             Download it from https://ollama.com/download, or use a cloud provider instead.",
        ));
    }

    Ok("Ollama installed.".into())
}

/// Progress of a model download, as the UI needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    /// Ollama's own phase description, e.g. "pulling manifest".
    pub status: String,
    pub completed: u64,
    pub total: u64,
    /// 0-100, already clamped so the bar cannot overshoot.
    pub percent: f64,
    pub done: bool,
    pub error: Option<String>,
}

/// Download a model, streaming progress to the UI.
///
/// This uses Ollama's HTTP API rather than shelling out to `ollama pull`,
/// because the API reports byte counts as structured JSON. The CLI renders a
/// progress bar with terminal escape codes, which cannot be parsed into a
/// usable percentage.
#[tauri::command]
pub async fn ollama_pull(
    app: AppHandle,
    model: String,
    base_url_override: Option<String>,
) -> JResult<()> {
    use futures_util::StreamExt;

    let base = base_url(base_url_override);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| AriaError::msg(format!("could not start the download: {e}")))?;

    let response = client
        .post(format!("{base}/api/pull"))
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|_| {
            AriaError::msg(
                "Ollama is not responding, so the model could not be downloaded. \
                 Make sure it is running and try again.",
            )
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let message = if status == 404 || body.contains("not found") {
            format!("Ollama does not have a model called `{model}`. Check the name and try again.")
        } else {
            format!("The download failed (HTTP {status}). Check your connection and try again.")
        };
        let _ = app.emit(
            "ollama-pull",
            PullProgress {
                status: "failed".into(),
                completed: 0,
                total: 0,
                percent: 0.0,
                done: true,
                error: Some(message.clone()),
            },
        );
        return Err(AriaError::msg(message));
    }

    let mut stream = response.bytes_stream();
    // The API emits newline-delimited JSON, and an object can straddle two
    // network chunks, so lines are reassembled rather than parsed per chunk.
    let mut buffer = String::new();
    let mut last_percent = -1.0_f64;

    while let Some(next) = stream.next().await {
        let bytes = match next {
            Ok(b) => b,
            Err(_) => {
                let message =
                    "The download was interrupted. Check your connection and try again.".to_string();
                let _ = app.emit(
                    "ollama-pull",
                    PullProgress {
                        status: "failed".into(),
                        completed: 0,
                        total: 0,
                        percent: 0.0,
                        done: true,
                        error: Some(message.clone()),
                    },
                );
                return Err(AriaError::msg(message));
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(newline) = buffer.find('\n') {
            let line: String = buffer.drain(..=newline).collect();
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }

            let Ok(parsed) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            if let Some(err) = parsed.get("error").and_then(|e| e.as_str()) {
                let _ = app.emit(
                    "ollama-pull",
                    PullProgress {
                        status: "failed".into(),
                        completed: 0,
                        total: 0,
                        percent: 0.0,
                        done: true,
                        error: Some(format!("The model could not be downloaded: {err}")),
                    },
                );
                return Err(AriaError::msg(err.to_string()));
            }

            let status = parsed
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("downloading")
                .to_string();
            let completed = parsed.get("completed").and_then(|c| c.as_u64()).unwrap_or(0);
            let total = parsed.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
            let percent = if total > 0 {
                (completed as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            };

            // Ollama emits progress far faster than a UI can use. Throttling
            // to whole percent changes keeps the event channel from becoming
            // the bottleneck during a multi-gigabyte download.
            let changed = (percent - last_percent).abs() >= 1.0;
            let is_phase_change = total == 0;
            if changed || is_phase_change {
                last_percent = percent;
                let _ = app.emit(
                    "ollama-pull",
                    PullProgress {
                        status,
                        completed,
                        total,
                        percent,
                        done: false,
                        error: None,
                    },
                );
            }
        }
    }

    let _ = app.emit(
        "ollama-pull",
        PullProgress {
            status: "success".into(),
            completed: 0,
            total: 0,
            percent: 100.0,
            done: true,
            error: None,
        },
    );
    Ok(())
}

/// Load a model into memory before the user needs it.
///
/// Ollama unloads models after a few minutes idle, and the first request after
/// that pays several seconds of load time attributed to "ARIA being slow".
/// An empty generation at launch moves that cost to a moment nobody is
/// waiting.
#[tauri::command]
pub async fn warmup_model(model: String, base_url_override: Option<String>) -> JResult<()> {
    let base = base_url(base_url_override);

    // Fire and forget: a failed warmup is not worth reporting, because the
    // real request that follows will report its own failure properly.
    let _ = super::llm::http_request(
        "POST".into(),
        format!("{base}/api/generate"),
        None,
        Some(
            serde_json::json!({
                "model": model,
                // No prompt and no prediction: this loads the weights and
                // returns, rather than generating anything.
                "prompt": "",
                "stream": false,
                "keep_alive": "10m",
                "options": { "num_predict": 0 },
            })
            .to_string(),
        ),
        Some(60_000),
    )
    .await;

    Ok(())
}

/// Generation options tuned for this machine.
///
/// Ollama's defaults are conservative: a 2048-token context and no GPU
/// offload. Both are measurable slowdowns on hardware that can do better, and
/// neither is something a user should have to discover and configure.
pub fn performance_options(gpu_layers: u32, threads: u32, context: u32) -> serde_json::Value {
    serde_json::json!({
        "num_ctx": context,
        "num_gpu": gpu_layers,
        "num_thread": threads,
        "repeat_penalty": 1.1,
        "temperature": 0.7,
        "top_p": 0.9,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn performance_options_carry_every_tuning_knob() {
        let opts = performance_options(99, 8, 4096);
        assert_eq!(opts["num_gpu"], 99);
        assert_eq!(opts["num_thread"], 8);
        assert_eq!(opts["num_ctx"], 4096);
        assert!(opts.get("repeat_penalty").is_some());
    }

    #[test]
    fn base_url_falls_back_to_the_default() {
        assert_eq!(base_url(None), DEFAULT_BASE_URL);
        assert_eq!(base_url(Some("   ".into())), DEFAULT_BASE_URL);
    }

    #[test]
    fn cloud_hosted_models_are_not_offered_as_local() {
        // These appear in /api/tags but are proxied to Ollama's servers and
        // need an account, so they are neither local nor offline.
        assert!(!is_runnable_locally("minimax-m3:cloud"));
        assert!(!is_runnable_locally("gpt-oss:120b-cloud"));
        assert!(!is_runnable_locally("deepseek-v3.1:671b-cloud"));
        assert!(is_runnable_locally("llama3.1:8b"));
        assert!(is_runnable_locally("llava:latest"));
        // A local model whose name merely contains the word must survive.
        assert!(is_runnable_locally("cloudy-llm:7b"));
        assert!(is_runnable_locally("bare-name-no-tag"));
    }

    #[test]
    fn preference_order_is_respected() {
        let installed: Vec<String> = ["mistral", "llama3", "llama3.1:8b"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        // Not the first installed, the best installed.
        assert_eq!(preferred_model(&installed).as_deref(), Some("llama3.1:8b"));
    }

    #[test]
    fn a_tagged_build_still_matches_the_preference() {
        // A quantised build is the same model; demanding an exact tag would
        // tell a user with llama3.1:8b-q4_0 to download it again.
        let installed = vec!["llava:latest".to_string(), "llama3.1:8b-instruct-q4_0".to_string()];
        assert_eq!(
            preferred_model(&installed).as_deref(),
            Some("llama3.1:8b-instruct-q4_0")
        );
    }

    #[test]
    fn an_exact_match_beats_a_tagged_one() {
        let installed = vec!["llama3.1:8b-q4_0".to_string(), "llama3.1:8b".to_string()];
        assert_eq!(preferred_model(&installed).as_deref(), Some("llama3.1:8b"));
    }

    #[test]
    fn anything_installed_beats_nothing() {
        let installed = vec!["some-exotic-model:latest".to_string()];
        assert_eq!(
            preferred_model(&installed).as_deref(),
            Some("some-exotic-model:latest")
        );
        assert_eq!(preferred_model(&[]), None);
    }

    #[test]
    fn base_url_normalises_a_custom_value() {
        assert_eq!(base_url(Some("http://box:11434/".into())), "http://box:11434");
        assert_eq!(base_url(Some("http://box:11434".into())), "http://box:11434");
    }
}
