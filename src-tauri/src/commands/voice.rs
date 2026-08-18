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
pub fn models_dir() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| expand_path("~/.local/share"))
        .join("aria")
        .join("models")
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

/// Transcribe 16-bit PCM WAV audio supplied as base64.
#[tauri::command]
pub async fn transcribe(audio_base64: String) -> JResult<String> {
    let binary =
        find_sidecar(&["whisper-cli", "whisper.cpp", "whisper", "main"]).ok_or_else(|| {
            AriaError::missing(
                "whisper-cli",
                "Offline transcription needs the whisper.cpp sidecar. \
                 Run `bash scripts/download-models.sh`, or switch the STT engine \
                 to the browser engine in Settings → Voice.",
            )
        })?;

    let model = find_model(&["ggml-tiny.en.bin", "ggml-base.en.bin", "ggml-small.en.bin"])
        .ok_or_else(|| {
            AriaError::msg(
                "No whisper model was found. Run `bash scripts/download-models.sh` \
                 to fetch ggml-tiny.en.bin.",
            )
        })?;

    // Strip a data-URL prefix if the frontend sent one.
    let payload = audio_base64
        .split_once("base64,")
        .map(|(_, b)| b)
        .unwrap_or(&audio_base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| AriaError::msg(format!("invalid audio payload: {e}")))?;

    let wav = std::env::temp_dir().join(format!("jarvis-stt-{}.wav", std::process::id()));
    std::fs::write(&wav, &bytes)?;

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

    let out = run_owned(&binary, &args).await;
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
        return Ok(out.ok());
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
        return Ok(out.ok());
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
