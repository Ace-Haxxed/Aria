//! Offline speech-to-text and text-to-speech via the whisper.cpp and piper
//! sidecars, with OS-native engines as the fallback.
//!
//! The models are not bundled in the installer — that would add ~140 MB to
//! every download for users who pick a cloud backend anyway. `download-models.sh`
//! and the setup wizard fetch them into the app data directory on demand, and
//! everything here resolves them at runtime.

use crate::util::{expand_path, first_available, run_owned, run_with_stdin, JResult, AriaError};
use base64::Engine;
use serde::Serialize;

/// Where the setup wizard puts downloaded models and sidecar binaries.
///
/// This is the legacy location. New downloads go to [`whisper_dir`], under the
/// same data directory as every other model, but this is still searched so a
/// model fetched by an older build is not stranded.
pub fn models_dir() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| expand_path("~/.local/share"))
        .join("aria")
        .join("models")
}

/// Where whisper models live now: alongside the LLM weights, under the data
/// directory that already honours an existing `~/.jarvis`.
///
/// Deliberately not a fixed `~/.aria/models` path — `data_subdir` prefers a
/// `~/.jarvis` that already exists, and hardcoding the new name would strand
/// the gigabyte of models sitting there.
pub fn whisper_dir() -> JResult<std::path::PathBuf> {
    crate::util::data_subdir("models/whisper")
}

/// The model files ARIA knows how to use, smallest first.
///
/// `base.en` is the download offered in the UI: `tiny.en` is noticeably worse
/// at proper nouns and command words, which is most of what gets dictated
/// here, and `small.en` is three times the size for a marginal gain.
const WHISPER_MODELS: [&str; 3] = ["ggml-base.en.bin", "ggml-tiny.en.bin", "ggml-small.en.bin"];

/// The whisper.cpp executable, under whichever name it was built with.
const WHISPER_BINARIES: [&str; 4] = ["whisper-cli", "whisper.cpp", "whisper", "main"];

/// Find a whisper model in either the current or the legacy location.
fn find_whisper_model() -> Option<std::path::PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = whisper_dir() {
        roots.push(dir);
    }
    roots.push(models_dir());

    for root in roots {
        for name in WHISPER_MODELS {
            let path = root.join(name);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn bin_dir() -> std::path::PathBuf {
    models_dir().parent().unwrap().join("bin")
}

/// Find a sidecar: prefer the copy ARIA downloaded, then fall back to PATH.
fn find_sidecar(names: &[&str]) -> Option<String> {
    for n in names {
        let local = bin_dir().join(n);
        if local.is_file() {
            return Some(local.to_string_lossy().to_string());
        }
    }
    first_available(names)
}

fn find_model(candidates: &[&str]) -> Option<std::path::PathBuf> {
    candidates
        .iter()
        .map(|c| models_dir().join(c))
        .find(|p| p.is_file())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub whisper_binary: Option<String>,
    pub whisper_model: Option<String>,
    pub piper_binary: Option<String>,
    pub piper_voice: Option<String>,
    pub native_tts: Option<String>,
    pub models_dir: String,
}

#[tauri::command]
pub async fn voice_status() -> JResult<VoiceStatus> {
    Ok(VoiceStatus {
        whisper_binary: find_sidecar(&["whisper-cli", "whisper.cpp", "whisper", "main"]),
        whisper_model: find_model(&["ggml-tiny.en.bin", "ggml-base.en.bin", "ggml-small.en.bin"])
            .map(|p| p.to_string_lossy().to_string()),
        piper_binary: find_sidecar(&["piper"]),
        piper_voice: find_model(&["en_US-ryan-high.onnx", "en_US-lessac-medium.onnx"])
            .map(|p| p.to_string_lossy().to_string()),
        native_tts: native_tts_binary(),
        models_dir: models_dir().to_string_lossy().to_string(),
    })
}

fn native_tts_binary() -> Option<String> {
    if cfg!(target_os = "macos") {
        return first_available(&["say"]);
    }
    if cfg!(target_os = "windows") {
        return first_available(&["powershell"]);
    }
    first_available(&["espeak-ng", "espeak", "spd-say"])
}

/* ── Speech to text ─────────────────────────────────────────────── */

/// Which engine will actually handle the next dictation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SttMethod {
    /// whisper.cpp on this machine. Nothing leaves the device.
    Offline,
    /// OpenAI's hosted Whisper, billed to the user's own key.
    Api,
    /// Neither is available; dictation cannot work.
    None,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    pub method: SttMethod,
    pub binary: Option<String>,
    pub model: Option<String>,
    /// Where a downloaded model is written.
    pub model_dir: String,
    /// True when an OpenAI key is stored, so the hosted route is usable.
    pub has_openai_key: bool,
    /// Whether `cmake` and `git` are present to build the sidecar.
    pub can_build: bool,
    /// One line explaining the current state, written for the user.
    pub detail: String,
}

/// What ARIA would use to transcribe right now, and why.
#[tauri::command]
pub async fn stt_status() -> JResult<SttStatus> {
    let binary = find_sidecar(&WHISPER_BINARIES);
    let model = find_whisper_model();
    let has_openai_key = !super::keys::key_for("openai").is_empty();
    let can_build = first_available(&["cmake"]).is_some() && first_available(&["git"]).is_some();

    let (method, detail) = match (&binary, &model) {
        (Some(_), Some(_)) => (
            SttMethod::Offline,
            "Offline — whisper.cpp on this machine. Nothing leaves the device.".to_string(),
        ),
        (Some(_), None) => {
            if has_openai_key {
                (
                    SttMethod::Api,
                    "Using OpenAI Whisper — the sidecar is built but has no model. \
                     Download one below to go fully offline."
                        .to_string(),
                )
            } else {
                (
                    SttMethod::None,
                    "whisper.cpp is built but has no model. Download one below.".to_string(),
                )
            }
        }
        (None, _) => {
            if has_openai_key {
                (
                    SttMethod::Api,
                    "Using OpenAI Whisper — your key, your cost. Build the offline \
                     sidecar below to stop sending audio off this machine."
                        .to_string(),
                )
            } else if can_build {
                (
                    SttMethod::None,
                    "No speech-to-text available. Build the offline sidecar below, \
                     or add an OpenAI key in Settings → Keys."
                        .to_string(),
                )
            } else {
                (
                    SttMethod::None,
                    "No speech-to-text available. Building the offline sidecar needs \
                     cmake and git; otherwise add an OpenAI key in Settings → Keys."
                        .to_string(),
                )
            }
        }
    };

    Ok(SttStatus {
        method,
        binary,
        model: model.map(|p| p.to_string_lossy().to_string()),
        model_dir: whisper_dir()
            .unwrap_or_else(|_| models_dir())
            .to_string_lossy()
            .to_string(),
        has_openai_key,
        can_build,
        detail,
    })
}

/// Transcribe 16-bit PCM WAV audio supplied as base64.
///
/// Offline first, then the user's own OpenAI key, then a message that names
/// the two ways to fix it. There is deliberately no browser fallback:
/// WebKitGTK does not implement `SpeechRecognition`, so on the platform this
/// runs on it was never a fallback, only a silent failure.
#[tauri::command]
pub async fn transcribe(audio_base64: String) -> JResult<String> {
    // Strip a data-URL prefix if the frontend sent one.
    let payload = audio_base64
        .split_once("base64,")
        .map(|(_, b)| b)
        .unwrap_or(&audio_base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| AriaError::msg(format!("invalid audio payload: {e}")))?;

    match (find_sidecar(&WHISPER_BINARIES), find_whisper_model()) {
        (Some(binary), Some(model)) => transcribe_offline(&binary, &model, &bytes).await,
        _ => {
            let key = super::keys::key_for("openai");
            if key.is_empty() {
                return Err(AriaError::msg(
                    "No speech-to-text is available. Open Settings → Voice to build the \
                     offline whisper.cpp sidecar and download a model, or add an OpenAI \
                     key in Settings → Keys to use hosted Whisper.",
                ));
            }
            transcribe_openai(&key, &bytes).await
        }
    }
}

/// Hosted Whisper, billed to the user's own OpenAI key.
///
/// The multipart body is assembled by hand rather than with reqwest's
/// `multipart` feature: enabling it would pull new transitive dependencies
/// into a build whose dependency set is deliberately audited, and the format
/// is four fixed fields.
async fn transcribe_openai(key: &str, wav: &[u8]) -> JResult<String> {
    const BOUNDARY: &str = "----ariaform7f3d9c2b1a084e6f";

    let mut body: Vec<u8> = Vec::with_capacity(wav.len() + 512);
    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    };
    field("model", "whisper-1");
    field("language", "en");
    field("response_format", "text");

    body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
    body.extend_from_slice(wav);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| AriaError::msg(e.to_string()))?
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(super::llm::clean_key(key))
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|_| {
            AriaError::msg("Could not reach OpenAI to transcribe. Check your connection.")
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AriaError::msg(super::llm::describe_status(
            "openai",
            status.as_u16(),
            &body,
        )));
    }
    Ok(body.trim().to_string())
}

/// whisper.cpp on this machine.
async fn transcribe_offline(
    binary: &str,
    model: &std::path::Path,
    bytes: &[u8],
) -> JResult<String> {
    let wav = std::env::temp_dir().join(format!("aria-stt-{}.wav", std::process::id()));
    std::fs::write(&wav, bytes)?;

    let args: Vec<String> = vec![
        "-m".into(),
        model.to_string_lossy().to_string(),
        "-f".into(),
        wav.to_string_lossy().to_string(),
        "--no-timestamps".into(),
        "--no-prints".into(),
        "--language".into(),
        "en".into(),
    ];

    let out = run_owned(binary, &args).await;
    let _ = std::fs::remove_file(&wav);
    let out = out?;

    if !out.ok() {
        return Err(AriaError::msg(format!(
            "transcription failed: {}",
            out.stderr.trim()
        )));
    }

    // whisper.cpp prints the transcript plus occasional bracketed markers
    // like [BLANK_AUDIO]; drop those so they never reach the model.
    let text = out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !(l.starts_with('[') && l.ends_with(']')))
        .collect::<Vec<_>>()
        .join(" ");

    Ok(text.trim().to_string())
}

/* ── Provisioning the offline engine ────────────────────────────── */

/// Progress for both the model download and the sidecar build.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperProgress {
    /// `"downloading"`, `"building"`, `"done"` or `"error"`.
    pub phase: String,
    pub percent: f64,
    pub downloaded: u64,
    pub total: u64,
    /// What is happening, in words, for the line under the bar.
    pub detail: String,
    pub done: bool,
    pub error: Option<String>,
}

fn emit_whisper(app: &tauri::AppHandle, progress: WhisperProgress) {
    use tauri::Emitter;
    let _ = app.emit("whisper-progress", progress);
}

/// The model ARIA offers to download.
///
/// `base.en` at ~148 MB is the smallest model that reliably gets command words
/// and proper nouns right; `tiny.en` saves 70 MB and misses enough of them to
/// be frustrating for dictation that is mostly instructions.
const WHISPER_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const WHISPER_MODEL_NAME: &str = "ggml-base.en.bin";

/// Download the whisper model, reporting progress as it goes.
#[tauri::command]
pub async fn download_whisper_model(app: tauri::AppHandle) -> JResult<String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let dir = whisper_dir()?;
    let target = dir.join(WHISPER_MODEL_NAME);
    if target.is_file() {
        return Ok(target.to_string_lossy().to_string());
    }

    emit_whisper(
        &app,
        WhisperProgress {
            phase: "downloading".into(),
            percent: 0.0,
            downloaded: 0,
            total: 0,
            detail: format!("Fetching {WHISPER_MODEL_NAME}"),
            done: false,
            error: None,
        },
    );

    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1_800))
        .build()
        .map_err(|e| AriaError::msg(e.to_string()))?
        .get(WHISPER_MODEL_URL)
        .send()
        .await
        .map_err(|_| {
            AriaError::msg("Could not reach huggingface.co. Check your connection.")
        })?;

    if !response.status().is_success() {
        return Err(AriaError::msg(format!(
            "The model download failed with HTTP {}.",
            response.status().as_u16()
        )));
    }

    let total = response.content_length().unwrap_or(148_000_000);

    // Written to a part-file and renamed, so an interrupted download cannot
    // leave a truncated model that whisper would load as garbage.
    let partial = target.with_extension("bin.part");
    let mut file = std::fs::File::create(&partial)?;
    let mut downloaded = 0u64;
    let mut stream = response.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let bytes =
            chunk.map_err(|_| AriaError::msg("The model download was interrupted."))?;
        file.write_all(&bytes)?;
        downloaded += bytes.len() as u64;

        // Four updates a second is plenty for a progress bar.
        if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
            last_emit = std::time::Instant::now();
            emit_whisper(
                &app,
                WhisperProgress {
                    phase: "downloading".into(),
                    percent: (downloaded as f64 / total.max(1) as f64 * 100.0).clamp(0.0, 100.0),
                    downloaded,
                    total,
                    detail: format!(
                        "{:.0} MB of {:.0} MB",
                        downloaded as f64 / 1e6,
                        total as f64 / 1e6
                    ),
                    done: false,
                    error: None,
                },
            );
        }
    }

    file.flush()?;
    drop(file);
    std::fs::rename(&partial, &target)?;

    emit_whisper(
        &app,
        WhisperProgress {
            phase: "done".into(),
            percent: 100.0,
            downloaded,
            total,
            detail: "Model ready".into(),
            done: true,
            error: None,
        },
    );

    Ok(target.to_string_lossy().to_string())
}

/// Build the whisper.cpp sidecar from source.
///
/// There is no official prebuilt binary to fetch, so this is the only way to
/// get offline transcription. It needs `git` and `cmake`; without them the
/// only route is the user's own OpenAI key, and [`stt_status`] says so.
#[tauri::command]
pub async fn build_whisper_sidecar(app: tauri::AppHandle) -> JResult<String> {
    if let Some(existing) = find_sidecar(&WHISPER_BINARIES) {
        return Ok(existing);
    }
    if first_available(&["git"]).is_none() || first_available(&["cmake"]).is_none() {
        return Err(AriaError::msg(
            "Building the offline engine needs git and cmake. Install them, or add an \
             OpenAI key in Settings → Keys to use hosted Whisper instead.",
        ));
    }

    let bin = bin_dir();
    std::fs::create_dir_all(&bin)?;
    let build = std::env::temp_dir().join("aria-whisper-build");
    let _ = std::fs::remove_dir_all(&build);

    let steps: [(&str, Vec<String>, &str); 3] = [
        (
            "git",
            vec![
                "clone".into(),
                "--depth".into(),
                "1".into(),
                "https://github.com/ggerganov/whisper.cpp".into(),
                build.to_string_lossy().to_string(),
            ],
            "Fetching whisper.cpp source",
        ),
        (
            "cmake",
            vec![
                "-B".into(),
                build.join("build").to_string_lossy().to_string(),
                "-S".into(),
                build.to_string_lossy().to_string(),
                "-DCMAKE_BUILD_TYPE=Release".into(),
            ],
            "Configuring the build",
        ),
        (
            "cmake",
            vec![
                "--build".into(),
                build.join("build").to_string_lossy().to_string(),
                "--config".into(),
                "Release".into(),
                "-j".into(),
            ],
            "Compiling — this takes a few minutes",
        ),
    ];

    for (index, (program, args, detail)) in steps.iter().enumerate() {
        emit_whisper(
            &app,
            WhisperProgress {
                phase: "building".into(),
                // Coarse thirds: the compile dominates, and a fake smooth bar
                // would be less honest than three real milestones.
                percent: (index as f64 / steps.len() as f64) * 100.0,
                downloaded: 0,
                total: 0,
                detail: (*detail).into(),
                done: false,
                error: None,
            },
        );

        let out = run_owned(program, args).await?;
        if !out.ok() {
            let _ = std::fs::remove_dir_all(&build);
            return Err(AriaError::msg(format!(
                "{detail} failed: {}",
                out.stderr.trim().lines().last().unwrap_or("unknown error")
            )));
        }
    }

    // The executable has moved around between releases; take the first that
    // exists rather than assuming one layout.
    let built = ["build/bin/whisper-cli", "build/bin/main", "build/whisper-cli"]
        .iter()
        .map(|c| build.join(c))
        .find(|p| p.is_file())
        .ok_or_else(|| AriaError::msg("The build finished but produced no whisper binary."))?;

    let installed = bin.join("whisper-cli");
    std::fs::copy(&built, &installed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o755))?;
    }
    let _ = std::fs::remove_dir_all(&build);

    emit_whisper(
        &app,
        WhisperProgress {
            phase: "done".into(),
            percent: 100.0,
            downloaded: 0,
            total: 0,
            detail: "Offline engine ready".into(),
            done: true,
            error: None,
        },
    );

    Ok(installed.to_string_lossy().to_string())
}

/* ── Text to speech ─────────────────────────────────────────────── */

/// Synthesise speech and return WAV audio as a base64 data URL.
#[tauri::command]
pub async fn synthesize(text: String, speed: Option<f32>) -> JResult<String> {
    if text.trim().is_empty() {
        return Err(AriaError::msg("nothing to speak"));
    }

    let out_path = std::env::temp_dir().join(format!(
        "jarvis-tts-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));
    let out_str = out_path.to_string_lossy().to_string();

    let produced = match (
        find_sidecar(&["piper"]),
        find_model(&["en_US-ryan-high.onnx", "en_US-lessac-medium.onnx"]),
    ) {
        (Some(piper), Some(voice)) => {
            // piper's length_scale is inverse to speed.
            let length_scale = 1.0 / speed.unwrap_or(1.0).clamp(0.5, 2.0);
            let args: Vec<String> = vec![
                "--model".into(),
                voice.to_string_lossy().to_string(),
                "--output_file".into(),
                out_str.clone(),
                "--length_scale".into(),
                format!("{length_scale:.3}"),
            ];
            let out = run_with_stdin(&piper, &args, &text).await?;
            if !out.ok() && !out_path.exists() {
                return Err(AriaError::msg(format!(
                    "piper failed: {}",
                    out.stderr.trim()
                )));
            }
            true
        }
        _ => native_tts(&text, &out_str, speed.unwrap_or(1.0)).await?,
    };

    if !produced || !out_path.exists() {
        return Err(AriaError::msg(
            "No speech engine is available. Install piper (`bash scripts/download-models.sh`) \
             or espeak-ng, or switch TTS to the browser engine in Settings → Voice.",
        ));
    }

    let bytes = std::fs::read(&out_path)?;
    let _ = std::fs::remove_file(&out_path);

    Ok(format!(
        "data:audio/wav;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// Fall back to whatever the OS ships. Returns false when nothing is installed.
async fn native_tts(text: &str, out_path: &str, speed: f32) -> JResult<bool> {
    #[cfg(target_os = "macos")]
    {
        // `say` writes AIFF by default; --data-format forces linear PCM WAV.
        let rate = (175.0 * speed).round() as i32;
        let args: Vec<String> = vec![
            "-o".into(),
            out_path.to_string(),
            "--data-format=LEI16@22050".into(),
            "-r".into(),
            rate.to_string(),
            text.to_string(),
        ];
        let out = run_owned("say", &args).await?;
        Ok(out.ok())
    }

    #[cfg(target_os = "windows")]
    {
        // SAPI rate is -10..10 where 0 is normal.
        let rate = ((speed - 1.0) * 10.0).clamp(-10.0, 10.0).round() as i32;
        let escaped = text.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Speech; \
             $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
             $s.Rate = {rate}; \
             $s.SetOutputToWaveFile('{}'); \
             $s.Speak('{escaped}'); \
             $s.Dispose()",
            out_path.replace('\'', "''")
        );
        let args: Vec<String> = vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            script,
        ];
        let out = run_owned("powershell", &args).await?;
        Ok(out.ok())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let Some(bin) = first_available(&["espeak-ng", "espeak"]) else {
            return Ok(false);
        };
        let wpm = (175.0 * speed).round() as i32;
        let args: Vec<String> = vec![
            "-w".into(),
            out_path.to_string(),
            "-s".into(),
            wpm.to_string(),
            text.to_string(),
        ];
        let out = run_owned(&bin, &args).await?;
        Ok(out.ok())
    }
}

/// Speak directly through the system's audio output, bypassing the WebView.
/// Used by the setup wizard's "test speaker" step.
#[tauri::command]
pub async fn speak_native(text: String) -> JResult<()> {
    let bin = native_tts_binary().ok_or_else(|| {
        AriaError::missing("espeak-ng", "No system speech engine is installed.")
    })?;

    let args: Vec<String> = if cfg!(target_os = "windows") {
        vec![
            "-NoProfile".into(),
            "-Command".into(),
            format!(
                "Add-Type -AssemblyName System.Speech; \
                 (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{}')",
                text.replace('\'', "''")
            ),
        ]
    } else {
        vec![text]
    };

    run_owned(&bin, &args).await?;
    Ok(())
}
