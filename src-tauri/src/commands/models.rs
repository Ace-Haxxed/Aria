//! The built-in model catalogue, and getting a model onto this machine.
//!
//! Every model here is redistributable — MIT or Apache-2.0 — so an offline
//! bundle can legally ship one. They are downloaded rather than bundled
//! because a 2 GB installer is not something anyone wants to host or fetch
//! twice, and most users only ever need one.
//!
//! Downloads resume. A 2 GB transfer over a domestic connection will be
//! interrupted eventually, and starting again from zero each time is the
//! difference between a feature that works and one that gets abandoned.

use crate::util::{JResult, AriaError};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Which candle loader reads this GGUF.
///
/// Not interchangeable: each loader looks up metadata under its own prefix
/// (`llama.attention.head_count`, `qwen2.attention.head_count`, …), so pointing
/// the wrong one at a file fails outright rather than degrading. The value
/// here is a hint — the real architecture is read from the file's own
/// `general.architecture` field at load time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Architecture {
    /// Llama, and Mistral GGUFs, which are published with `llama.*` metadata.
    Llama,
    Phi3,
    Qwen2,
    Qwen3,
}

impl Architecture {
    /// Map a GGUF `general.architecture` string onto a loader.
    pub fn from_gguf_name(name: &str) -> Option<Self> {
        match name.trim().to_lowercase().as_str() {
            "llama" | "mistral" => Some(Architecture::Llama),
            "phi3" => Some(Architecture::Phi3),
            "qwen2" => Some(Architecture::Qwen2),
            "qwen3" => Some(Architecture::Qwen3),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// HuggingFace repo holding the GGUF.
    pub repo: &'static str,
    pub filename: &'static str,
    /// Repo holding `tokenizer.json`. Quantized GGUFs do not always carry a
    /// tokenizer candle can read, so it is fetched from the source model.
    pub tokenizer_repo: &'static str,
    pub architecture: Architecture,
    /// Approximate download size, for the UI. The real size comes from the
    /// server; this is only so a choice can be made before starting.
    pub size_mb: u32,
    /// Minimum RAM to run comfortably, used to warn before a bad choice.
    pub needs_ram_gb: u32,
    pub license: &'static str,
}

/// Models offered in the picker, best default first.
pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "phi-3.5-mini",
        name: "Phi-3.5 Mini",
        description: "Best balance of quality and speed. Recommended.",
        repo: "microsoft/Phi-3.5-mini-instruct-gguf",
        filename: "Phi-3.5-mini-instruct-Q4_K_M.gguf",
        tokenizer_repo: "microsoft/Phi-3.5-mini-instruct",
        architecture: Architecture::Phi3,
        size_mb: 2_200,
        needs_ram_gb: 6,
        license: "MIT",
    },
    ModelSpec {
        id: "llama-3.2-3b",
        name: "Llama 3.2 3B",
        description: "Good all-rounder from Meta.",
        repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
        filename: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        tokenizer_repo: "meta-llama/Llama-3.2-3B-Instruct",
        architecture: Architecture::Llama,
        size_mb: 2_000,
        needs_ram_gb: 6,
        license: "Llama 3.2 Community License",
    },
    ModelSpec {
        id: "qwen2.5-1.5b",
        name: "Qwen 2.5 1.5B",
        description: "Smallest and fastest. Weaker at reasoning.",
        repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        tokenizer_repo: "Qwen/Qwen2.5-1.5B-Instruct",
        architecture: Architecture::Qwen2,
        size_mb: 1_000,
        needs_ram_gb: 4,
        license: "Apache-2.0",
    },
    ModelSpec {
        id: "mistral-7b",
        name: "Mistral 7B",
        description: "Highest quality here, but needs more memory.",
        repo: "TheBloke/Mistral-7B-Instruct-v0.2-GGUF",
        filename: "mistral-7b-instruct-v0.2.Q4_K_M.gguf",
        tokenizer_repo: "mistralai/Mistral-7B-Instruct-v0.2",
        architecture: Architecture::Llama,
        size_mb: 4_100,
        needs_ram_gb: 10,
        license: "Apache-2.0",
    },
];

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|m| m.id == id)
}

/// The model chosen when the user has expressed no preference.
pub const DEFAULT_MODEL: &str = "phi-3.5-mini";

/* ── Paths ──────────────────────────────────────────────────────── */

pub fn models_dir() -> JResult<PathBuf> {
    crate::util::data_subdir("models")
}

pub fn model_path(spec: &ModelSpec) -> JResult<PathBuf> {
    Ok(models_dir()?.join(format!("{}.gguf", spec.id)))
}

pub fn tokenizer_path(spec: &ModelSpec) -> JResult<PathBuf> {
    Ok(models_dir()?.join(format!("{}.tokenizer.json", spec.id)))
}

/* ── Catalogue status ───────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    #[serde(flatten)]
    pub spec: ModelSpec,
    pub installed: bool,
    /// Bytes on disk — a partial download shows as progress in the picker.
    pub downloaded_bytes: u64,
    pub path: String,
}

#[tauri::command]
pub async fn list_builtin_models() -> JResult<Vec<CatalogEntry>> {
    let mut out = Vec::new();
    for spec in CATALOG {
        let path = model_path(spec)?;
        let partial = path.with_extension("gguf.part");

        // A finished file and a part-file are different states: one is usable,
        // the other is a download to resume.
        let (installed, downloaded_bytes) = if path.exists() {
            (true, std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0))
        } else {
            (
                false,
                std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0),
            )
        };

        out.push(CatalogEntry {
            spec: spec.clone(),
            installed,
            downloaded_bytes,
            path: path.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

/* ── Download ───────────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
    /// Bytes per second over the last window, not the whole transfer — an
    /// average over a long download stops reflecting the current connection.
    pub bytes_per_sec: f64,
    pub eta_seconds: u64,
    pub phase: String,
    pub done: bool,
    pub error: Option<String>,
}

fn emit(app: &AppHandle, progress: DownloadProgress) {
    let _ = app.emit("model-download", progress);
}

/// Cancellation flag, set by `cancel_model_download`.
static CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub async fn cancel_model_download() -> JResult<()> {
    CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Ask HuggingFace for the digest it publishes for this file.
///
/// The expected checksum is fetched rather than hard-coded. A constant in the
/// source is a promise about a file on someone else's server: if they re-quantise
/// and re-upload, every install starts failing verification with no way for the
/// user to tell a corrupted download from a stale constant.
async fn expected_sha256(repo: &str, filename: &str) -> Option<String> {
    let reply = super::llm::http_request(
        "GET".into(),
        format!("https://huggingface.co/api/models/{repo}/tree/main"),
        None,
        None,
        Some(15_000),
    )
    .await
    .ok()?;
    if !reply.ok {
        return None;
    }

    let entries: serde_json::Value = serde_json::from_str(&reply.body).ok()?;
    entries.as_array()?.iter().find_map(|entry| {
        if entry.get("path")?.as_str()? != filename {
            return None;
        }
        // Only LFS-backed files carry a digest; small files do not.
        entry
            .get("lfs")?
            .get("oid")?
            .as_str()
            .map(|s| s.to_lowercase())
    })
}

fn hf_url(repo: &str, filename: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/main/{filename}?download=true")
}

/// Download a model, resuming a previous attempt if one was interrupted.
#[tauri::command]
pub async fn download_builtin_model(app: AppHandle, model_id: String) -> JResult<String> {
    let spec = spec(&model_id)
        .ok_or_else(|| AriaError::msg(format!("`{model_id}` is not a model ARIA offers.")))?;

    CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);

    let target = model_path(spec)?;
    if target.exists() {
        emit(
            &app,
            DownloadProgress {
                model_id: model_id.clone(),
                downloaded: 0,
                total: 0,
                percent: 100.0,
                bytes_per_sec: 0.0,
                eta_seconds: 0,
                phase: "already installed".into(),
                done: true,
                error: None,
            },
        );
        return Ok(target.to_string_lossy().to_string());
    }

    // The tokenizer is small and quick; fetching it first means a completed
    // GGUF is never left unusable because the second file failed.
    fetch_tokenizer(spec).await?;

    let digest = expected_sha256(spec.repo, spec.filename).await;
    let result = download_with_resume(&app, spec, digest).await;

    match result {
        Ok(path) => {
            emit(
                &app,
                DownloadProgress {
                    model_id,
                    downloaded: 0,
                    total: 0,
                    percent: 100.0,
                    bytes_per_sec: 0.0,
                    eta_seconds: 0,
                    phase: "ready".into(),
                    done: true,
                    error: None,
                },
            );
            Ok(path)
        }
        Err(e) => {
            emit(
                &app,
                DownloadProgress {
                    model_id,
                    downloaded: 0,
                    total: 0,
                    percent: 0.0,
                    bytes_per_sec: 0.0,
                    eta_seconds: 0,
                    phase: "failed".into(),
                    done: true,
                    error: Some(e.to_string()),
                },
            );
            Err(e)
        }
    }
}

async fn fetch_tokenizer(spec: &ModelSpec) -> JResult<()> {
    let path = tokenizer_path(spec)?;
    if path.exists() {
        return Ok(());
    }

    let reply = super::llm::http_request(
        "GET".into(),
        hf_url(spec.tokenizer_repo, "tokenizer.json"),
        None,
        None,
        Some(60_000),
    )
    .await?;

    if !reply.ok {
        return Err(AriaError::msg(
            "Could not download the tokenizer for this model. Check your internet connection and try again.",
        ));
    }
    std::fs::write(&path, reply.body)?;
    Ok(())
}

async fn download_with_resume(
    app: &AppHandle,
    spec: &ModelSpec,
    expected: Option<String>,
) -> JResult<String> {
    let target = model_path(spec)?;
    let partial = target.with_extension("gguf.part");

    // Anything already fetched is kept and the request continues from there.
    let mut existing = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AriaError::msg(format!("could not start the download: {e}")))?;

    let mut request = client.get(hf_url(spec.repo, spec.filename));
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }

    let response = request.send().await.map_err(|_| {
        AriaError::msg(
            "Could not reach the model host. Check your internet connection and try again.",
        )
    })?;

    let status = response.status();
    if !status.is_success() {
        // A server that ignores Range answers 200 with the whole file; that is
        // usable, it just means starting over.
        if status.as_u16() == 416 {
            let _ = std::fs::remove_file(&partial);
            return Err(AriaError::msg(
                "The partial download could not be resumed. Press Retry to start it again.",
            ));
        }
        return Err(AriaError::msg(format!(
            "The model host refused the download (HTTP {}). Try again shortly.",
            status.as_u16()
        )));
    }
    if existing > 0 && status.as_u16() != 206 {
        // Range was not honoured — restart cleanly rather than corrupting.
        existing = 0;
        let _ = std::fs::remove_file(&partial);
    }

    let total = response
        .content_length()
        .map(|len| len + existing)
        .unwrap_or(spec.size_mb as u64 * 1_000_000);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&partial)?;

    let mut downloaded = existing;
    let mut stream = response.bytes_stream();

    // Speed is measured over a sliding window so the figure shown reflects the
    // connection now, not an average dragged down by a slow start.
    let mut window_start = Instant::now();
    let mut window_bytes = 0u64;
    let mut speed = 0.0f64;
    let mut last_emit = Instant::now();

    while let Some(chunk) = stream.next().await {
        if CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
            // The part-file is deliberately kept: cancelling should not throw
            // away a gigabyte the user already waited for.
            return Err(AriaError::msg("Download paused. Press Resume to continue."));
        }

        let bytes = chunk.map_err(|_| {
            AriaError::msg("The download was interrupted. Press Resume to continue where it stopped.")
        })?;
        file.write_all(&bytes)?;

        downloaded += bytes.len() as u64;
        window_bytes += bytes.len() as u64;

        let elapsed = window_start.elapsed();
        if elapsed >= Duration::from_millis(500) {
            speed = window_bytes as f64 / elapsed.as_secs_f64();
            window_start = Instant::now();
            window_bytes = 0;
        }

        // Four updates a second is plenty for a progress bar and keeps the
        // event channel from becoming the bottleneck on a fast connection.
        if last_emit.elapsed() >= Duration::from_millis(250) {
            last_emit = Instant::now();
            let remaining = total.saturating_sub(downloaded);
            emit(
                app,
                DownloadProgress {
                    model_id: spec.id.to_string(),
                    downloaded,
                    total,
                    percent: (downloaded as f64 / total.max(1) as f64 * 100.0).clamp(0.0, 100.0),
                    bytes_per_sec: speed,
                    eta_seconds: if speed > 1.0 {
                        (remaining as f64 / speed) as u64
                    } else {
                        0
                    },
                    phase: "downloading".into(),
                    done: false,
                    error: None,
                },
            );
        }
    }

    file.flush()?;
    drop(file);

    if let Some(expected) = expected {
        emit(
            app,
            DownloadProgress {
                model_id: spec.id.to_string(),
                downloaded,
                total,
                percent: 100.0,
                bytes_per_sec: 0.0,
                eta_seconds: 0,
                phase: "verifying".into(),
                done: false,
                error: None,
            },
        );

        let actual = sha256_file(&partial)?;
        if actual != expected {
            // A file that fails its digest is worse than no file: it would
            // load as garbage or crash the loader.
            let _ = std::fs::remove_file(&partial);
            return Err(AriaError::msg(
                "The downloaded model was corrupted in transit and has been discarded. Press Retry to download it again.",
            ));
        }
    }

    std::fs::rename(&partial, &target)?;
    Ok(target.to_string_lossy().to_string())
}

/// Hash a file in chunks — a 2 GB read into memory would be a needless spike.
fn sha256_file(path: &std::path::Path) -> JResult<String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];

    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Remove a downloaded model and its tokenizer.
#[tauri::command]
pub async fn delete_builtin_model(model_id: String) -> JResult<()> {
    let spec = spec(&model_id)
        .ok_or_else(|| AriaError::msg(format!("`{model_id}` is not a model ARIA offers.")))?;

    for path in [model_path(spec)?, tokenizer_path(spec)?] {
        if path.exists() {
            // To the trash: a 2 GB re-download is a harsh penalty for a
            // mis-click.
            trash::delete(&path)
                .map_err(|e| AriaError::msg(format!("Could not remove the model: {e}")))?;
        }
    }
    let partial = model_path(spec)?.with_extension("gguf.part");
    let _ = std::fs::remove_file(partial);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_model_is_in_the_catalogue() {
        assert!(spec(DEFAULT_MODEL).is_some());
    }

    #[test]
    fn catalogue_ids_are_unique() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "two models share an id");
    }

    #[test]
    fn every_model_declares_a_license() {
        // These are redistributed to users; shipping one with unclear terms
        // would be a legal problem, not a cosmetic one.
        for model in CATALOG {
            assert!(!model.license.is_empty(), "{} has no license", model.id);
            assert!(model.size_mb > 0, "{} has no size", model.id);
            assert!(model.needs_ram_gb > 0, "{} has no RAM figure", model.id);
        }
    }

    #[test]
    fn gguf_architecture_names_map_to_loaders() {
        // Getting this wrong is not a soft failure: the loader cannot find its
        // metadata and refuses the file.
        assert_eq!(Architecture::from_gguf_name("qwen2"), Some(Architecture::Qwen2));
        assert_eq!(Architecture::from_gguf_name("phi3"), Some(Architecture::Phi3));
        assert_eq!(Architecture::from_gguf_name("llama"), Some(Architecture::Llama));
        // Mistral GGUFs are published with llama metadata.
        assert_eq!(Architecture::from_gguf_name("mistral"), Some(Architecture::Llama));
        assert_eq!(Architecture::from_gguf_name("LLaMA"), Some(Architecture::Llama));
        assert_eq!(Architecture::from_gguf_name("something-new"), None);
    }

    #[test]
    fn download_urls_are_well_formed() {
        for model in CATALOG {
            let url = hf_url(model.repo, model.filename);
            assert!(url.starts_with("https://huggingface.co/"), "{url}");
            assert!(url.contains("/resolve/main/"), "{url}");
            assert!(!url.contains(" "), "{url}");
        }
    }

    #[test]
    fn sha256_matches_a_known_vector() {
        let dir = std::env::temp_dir().join(format!("jarvis-sha-{}", std::process::id()));
        std::fs::write(&dir, b"abc").unwrap();
        assert_eq!(
            sha256_file(&dir).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_file(&dir);
    }
}
