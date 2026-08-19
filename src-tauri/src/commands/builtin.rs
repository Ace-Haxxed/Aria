//! The built-in language model, running in this process.
//!
//! No Ollama, no sidecar, no network. A quantized GGUF is memory-mapped, and
//! generation happens on a worker thread inside the NOVA binary, which is
//! what makes the app work on a machine that has nothing else installed and no
//! internet connection.
//!
//! The model stays resident between messages. Loading a 2 GB model takes
//! seconds, and paying that on every question would make the built-in backend
//! useless however fast the generation itself is.

use crate::util::{JResult, NovaError};
use candle_core::quantized::gguf_file;
use candle_core::{Device, Tensor};
use candle_transformers::generation::LogitsProcessor;
use candle_transformers::models::quantized_llama::ModelWeights as LlamaWeights;
use candle_transformers::models::quantized_phi3::ModelWeights as Phi3Weights;
use candle_transformers::models::quantized_qwen2::ModelWeights as Qwen2Weights;
use candle_transformers::models::quantized_qwen3::ModelWeights as Qwen3Weights;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokenizers::Tokenizer;

use super::models::{model_path, spec, tokenizer_path, Architecture, ModelSpec};

/// The GGUF families candle can load, behind one interface.
enum Weights {
    Llama(LlamaWeights),
    Phi3(Phi3Weights),
    Qwen2(Qwen2Weights),
    Qwen3(Qwen3Weights),
}

impl Weights {
    fn forward(&mut self, input: &Tensor, position: usize) -> candle_core::Result<Tensor> {
        match self {
            Weights::Llama(m) => m.forward(input, position),
            Weights::Phi3(m) => m.forward(input, position),
            Weights::Qwen2(m) => m.forward(input, position),
            Weights::Qwen3(m) => m.forward(input, position),
        }
    }
}

struct Loaded {
    weights: Weights,
    tokenizer: Tokenizer,
    spec: &'static ModelSpec,
    /// Read from the GGUF, which may differ from the catalogue's guess.
    architecture: Architecture,
    device: Device,
    context_length: usize,
    /// Rolling average, for the status readout.
    last_tokens_per_sec: f32,
}

/// The resident model. A `Mutex` rather than a channel because generation is
/// inherently serialised — one model, one KV cache, one request at a time.
static MODEL: OnceLock<Mutex<Option<Loaded>>> = OnceLock::new();

fn model_slot() -> &'static Mutex<Option<Loaded>> {
    MODEL.get_or_init(|| Mutex::new(None))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Set while a generation should stop early.
static CANCEL: AtomicBool = AtomicBool::new(false);

/* ── Hardware ───────────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acceleration {
    /// "cuda", "metal" or "cpu".
    pub backend: String,
    pub detail: String,
    pub threads: usize,
}

/// Pick the fastest device this build can actually use.
///
/// CUDA and Metal are compile-time features of candle. Asking for one that was
/// not compiled in fails at runtime, so the request is only made when the
/// feature is present — and it still falls back if the hardware is absent.
fn best_device() -> (Device, String, String) {
    #[cfg(feature = "cuda")]
    {
        if let Ok(device) = Device::new_cuda(0) {
            return (device, "cuda".into(), "NVIDIA GPU".into());
        }
    }
    #[cfg(feature = "metal")]
    {
        if let Ok(device) = Device::new_metal(0) {
            return (device, "metal".into(), "Apple GPU".into());
        }
    }
    (
        Device::Cpu,
        "cpu".into(),
        format!("{} threads", inference_threads()),
    )
}

/// Physical cores, not logical.
///
/// Matrix multiply is memory-bandwidth bound; running two hyperthreads per
/// core contends for the same cache and usually costs throughput rather than
/// adding it.
fn inference_threads() -> usize {
    let info = sysinfo::System::new_all();
    let physical = info.physical_core_count().unwrap_or(0);
    if physical > 0 {
        return physical.max(1);
    }
    (std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        / 2)
    .max(1)
}

/// Context window sized to available memory.
///
/// The KV cache grows linearly with context, and a machine that starts
/// swapping generates at a fraction of its normal speed — a smaller window
/// that fits is faster than a larger one that does not.
fn context_for_ram() -> usize {
    let info = sysinfo::System::new_all();
    let gb = info.total_memory() / 1_000_000_000;
    if gb >= 16 {
        8192
    } else {
        4096
    }
}

#[tauri::command]
pub async fn detect_acceleration() -> JResult<Acceleration> {
    let (_, backend, detail) = best_device();
    Ok(Acceleration {
        backend,
        detail,
        threads: inference_threads(),
    })
}

/* ── Status ─────────────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinStatus {
    pub loaded: bool,
    pub model_id: String,
    pub model_name: String,
    pub model_path: String,
    pub context_total: u32,
    pub tokens_per_sec: f32,
    pub backend: String,
    pub threads: u32,
    /// Whether the default model is on disk, so the UI knows to offer a
    /// download rather than a load.
    pub downloaded: bool,
}

#[tauri::command]
pub async fn builtin_status() -> JResult<BuiltinStatus> {
    let guard = lock(model_slot());
    let acceleration = {
        let (_, backend, _) = best_device();
        backend
    };

    if let Some(loaded) = guard.as_ref() {
        return Ok(BuiltinStatus {
            loaded: true,
            model_id: loaded.spec.id.to_string(),
            model_name: loaded.spec.name.to_string(),
            model_path: model_path(loaded.spec)?.to_string_lossy().to_string(),
            context_total: loaded.context_length as u32,
            tokens_per_sec: loaded.last_tokens_per_sec,
            backend: acceleration,
            threads: inference_threads() as u32,
            downloaded: true,
        });
    }
    drop(guard);

    // Nothing loaded: report whether the default could be.
    let default = spec(super::models::DEFAULT_MODEL);
    let downloaded = default
        .and_then(|s| model_path(s).ok())
        .map(|p| p.exists())
        .unwrap_or(false);

    Ok(BuiltinStatus {
        loaded: false,
        model_id: String::new(),
        model_name: String::new(),
        model_path: String::new(),
        context_total: 0,
        tokens_per_sec: 0.0,
        backend: acceleration,
        threads: inference_threads() as u32,
        downloaded,
    })
}

/* ── Loading ────────────────────────────────────────────────────── */

/// Load a model into memory, replacing whatever was resident.
#[tauri::command]
pub async fn builtin_load_model(model_id: String) -> JResult<BuiltinStatus> {
    let target = spec(&model_id)
        .ok_or_else(|| NovaError::msg(format!("`{model_id}` is not a model NOVA offers.")))?;

    // Loading is seconds of blocking CPU and file IO; it must not run on the
    // async runtime or every other command stalls behind it.
    tokio::task::spawn_blocking(move || load_blocking(target))
        .await
        .map_err(|e| NovaError::msg(format!("the model could not be loaded: {e}")))??;

    builtin_status().await
}

fn load_blocking(target: &'static ModelSpec) -> JResult<()> {
    let path = model_path(target)?;
    if !path.exists() {
        return Err(NovaError::msg(format!(
            "{} has not been downloaded yet.",
            target.name
        )));
    }

    let tok_path = tokenizer_path(target)?;
    if !tok_path.exists() {
        return Err(NovaError::msg(format!(
            "The tokenizer for {} is missing. Download the model again.",
            target.name
        )));
    }

    let tokenizer = Tokenizer::from_file(&tok_path)
        .map_err(|e| NovaError::msg(format!("the tokenizer could not be read: {e}")))?;

    let (device, _, _) = best_device();

    let mut file = std::fs::File::open(&path)?;
    let content = gguf_file::Content::read(&mut file).map_err(|e| {
        NovaError::msg(format!(
            "{} is not a readable GGUF file ({e}). Download it again.",
            target.name
        ))
    })?;

    // Trust the file over the catalogue. Each loader reads metadata under its
    // own prefix, so a mislabelled entry does not degrade — it fails to load
    // with a message about a missing metadata key that means nothing to a user.
    let declared = content
        .metadata
        .get("general.architecture")
        .and_then(|v| v.to_string().ok())
        .and_then(|name| Architecture::from_gguf_name(name));

    let architecture = declared.unwrap_or(target.architecture);

    let weights = match architecture {
        Architecture::Phi3 => Weights::Phi3(
            Phi3Weights::from_gguf(false, content, &mut file, &device)
                .map_err(|e| load_error(target, e))?,
        ),
        Architecture::Llama => Weights::Llama(
            LlamaWeights::from_gguf(content, &mut file, &device)
                .map_err(|e| load_error(target, e))?,
        ),
        Architecture::Qwen2 => Weights::Qwen2(
            Qwen2Weights::from_gguf(content, &mut file, &device)
                .map_err(|e| load_error(target, e))?,
        ),
        Architecture::Qwen3 => Weights::Qwen3(
            Qwen3Weights::from_gguf(content, &mut file, &device)
                .map_err(|e| load_error(target, e))?,
        ),
    };

    *lock(model_slot()) = Some(Loaded {
        weights,
        tokenizer,
        spec: target,
        architecture,
        device,
        context_length: context_for_ram(),
        last_tokens_per_sec: 0.0,
    });
    Ok(())
}

/// Release the model and its memory.
#[tauri::command]
pub async fn builtin_unload_model() -> JResult<()> {
    *lock(model_slot()) = None;
    Ok(())
}

/* ── Generation ─────────────────────────────────────────────────── */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEvent {
    pub token: String,
    pub done: bool,
    pub tokens_per_sec: f32,
    pub total_tokens: u32,
    pub elapsed_ms: u32,
    pub error: Option<String>,
}

/// Render a conversation into the prompt format the model was trained on.
///
/// Chat templates are not interchangeable: feeding Phi-3's format to a Llama
/// model produces confident nonsense, because the model has never seen those
/// delimiters and treats them as content.
fn build_prompt(architecture: Architecture, messages: &[ChatMessage]) -> String {
    let mut out = String::new();

    match architecture {
        Architecture::Phi3 => {
            for m in messages {
                let role = match m.role.as_str() {
                    "assistant" => "assistant",
                    "system" => "system",
                    _ => "user",
                };
                out.push_str(&format!("<|{role}|>\n{}<|end|>\n", m.content));
            }
            out.push_str("<|assistant|>\n");
        }
        Architecture::Llama => {
            out.push_str("<|begin_of_text|>");
            for m in messages {
                let role = match m.role.as_str() {
                    "assistant" => "assistant",
                    "system" => "system",
                    _ => "user",
                };
                out.push_str(&format!(
                    "<|start_header_id|>{role}<|end_header_id|>\n\n{}<|eot_id|>",
                    m.content
                ));
            }
            out.push_str("<|start_header_id|>assistant<|end_header_id|>\n\n");
        }
        // Qwen uses ChatML, shared by both its generations.
        Architecture::Qwen2 | Architecture::Qwen3 => {
            for m in messages {
                let role = match m.role.as_str() {
                    "assistant" => "assistant",
                    "system" => "system",
                    _ => "user",
                };
                out.push_str(&format!("<|im_start|>{role}\n{}<|im_end|>\n", m.content));
            }
            out.push_str("<|im_start|>assistant\n");
        }
    }
    out
}

/// Sequences that mean "the model has finished its turn".
fn stop_sequences(architecture: Architecture) -> &'static [&'static str] {
    match architecture {
        Architecture::Phi3 => &["<|end|>", "<|user|>", "<|system|>"],
        Architecture::Llama => &["<|eot_id|>", "<|start_header_id|>"],
        Architecture::Qwen2 | Architecture::Qwen3 => &["<|im_end|>", "<|endoftext|>", "<|im_start|>"],
    }
}

#[tauri::command]
pub async fn builtin_cancel() -> JResult<()> {
    CANCEL.store(true, Ordering::Relaxed);
    Ok(())
}

/// Generate a reply, streaming tokens as `builtin-token` events.
#[tauri::command]
pub async fn builtin_chat(
    app: AppHandle,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<usize>,
) -> JResult<()> {
    CANCEL.store(false, Ordering::Relaxed);

    tokio::task::spawn_blocking(move || {
        let result = generate(&app, messages, temperature, max_tokens);
        if let Err(e) = result {
            let _ = app.emit(
                "builtin-token",
                TokenEvent {
                    token: String::new(),
                    done: true,
                    tokens_per_sec: 0.0,
                    total_tokens: 0,
                    elapsed_ms: 0,
                    error: Some(e.to_string()),
                },
            );
        }
    })
    .await
    .map_err(|e| NovaError::msg(format!("generation did not start: {e}")))?;

    Ok(())
}

fn generate(
    app: &AppHandle,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<usize>,
) -> JResult<()> {
    let mut guard = lock(model_slot());
    let loaded = guard
        .as_mut()
        .ok_or_else(|| NovaError::msg("No built-in model is loaded yet."))?;

    let architecture = loaded.architecture;
    let prompt = build_prompt(architecture, &messages);

    let encoding = loaded
        .tokenizer
        .encode(prompt, true)
        .map_err(|e| NovaError::msg(format!("the prompt could not be tokenised: {e}")))?;
    let mut tokens = encoding.get_ids().to_vec();

    // Leave room to answer: a prompt filling the whole window has nowhere to
    // generate into.
    let budget = max_tokens.unwrap_or(512);
    let ceiling = loaded.context_length.saturating_sub(budget).max(256);
    if tokens.len() > ceiling {
        // Keep the tail — the most recent turns are what the reply responds to.
        tokens = tokens[tokens.len() - ceiling..].to_vec();
    }

    let mut sampler = LogitsProcessor::new(
        // Seeded from the clock: a fixed seed makes every session produce the
        // same wording for the same question, which reads as broken.
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        Some(temperature.unwrap_or(0.7)),
        Some(0.9),
    );

    let started = Instant::now();
    let mut generated = 0u32;
    let mut text = String::new();
    let mut position = 0usize;

    // The prompt is processed in one pass, then one token at a time.
    let mut next = {
        let input = Tensor::new(tokens.as_slice(), &loaded.device)
            .and_then(|t| t.unsqueeze(0))
            .map_err(candle_err)?;
        let logits = loaded.weights.forward(&input, 0).map_err(candle_err)?;
        let logits = logits.squeeze(0).map_err(candle_err)?;
        let logits = last_row(&logits)?;
        position += tokens.len();
        sampler.sample(&logits).map_err(candle_err)?
    };

    let stops = stop_sequences(architecture);

    for _ in 0..budget {
        if CANCEL.load(Ordering::Relaxed) {
            break;
        }

        let piece = loaded
            .tokenizer
            .decode(&[next], false)
            .unwrap_or_else(|_| String::new());

        text.push_str(&piece);
        generated += 1;

        // A stop sequence can straddle two tokens, so the accumulated text is
        // what gets checked rather than the piece alone.
        if let Some(cut) = stops.iter().find_map(|s| text.find(s)) {
            text.truncate(cut);
            break;
        }

        if !piece.is_empty() {
            let elapsed = started.elapsed();
            let _ = app.emit(
                "builtin-token",
                TokenEvent {
                    token: piece,
                    done: false,
                    tokens_per_sec: generated as f32 / elapsed.as_secs_f32().max(0.001),
                    total_tokens: generated,
                    elapsed_ms: elapsed.as_millis() as u32,
                    error: None,
                },
            );
        }

        let input = Tensor::new(&[next], &loaded.device)
            .and_then(|t| t.unsqueeze(0))
            .map_err(candle_err)?;
        let logits = loaded
            .weights
            .forward(&input, position)
            .map_err(candle_err)?;
        let logits = logits.squeeze(0).map_err(candle_err)?;
        let logits = last_row(&logits)?;
        position += 1;
        next = sampler.sample(&logits).map_err(candle_err)?;
    }

    let elapsed = started.elapsed();
    let rate = generated as f32 / elapsed.as_secs_f32().max(0.001);
    loaded.last_tokens_per_sec = rate;

    let _ = app.emit(
        "builtin-token",
        TokenEvent {
            token: String::new(),
            done: true,
            tokens_per_sec: rate,
            total_tokens: generated,
            elapsed_ms: elapsed.as_millis() as u32,
            error: None,
        },
    );
    Ok(())
}

/// Take the logits for the final position.
///
/// The prompt pass returns one row per input token; only the last predicts the
/// next word. Single-token steps already return one row, which this leaves
/// alone.
fn last_row(logits: &Tensor) -> JResult<Tensor> {
    match logits.dims() {
        [_rows, _vocab] => {
            let rows = logits.dim(0).map_err(candle_err)?;
            logits.narrow(0, rows - 1, 1).map_err(candle_err)?.squeeze(0).map_err(candle_err)
        }
        _ => Ok(logits.clone()),
    }
}

fn load_error(target: &ModelSpec, e: candle_core::Error) -> NovaError {
    NovaError::msg(format!(
        "{} could not be loaded ({e}). The file may be incomplete — try downloading it again.",
        target.name
    ))
}

fn candle_err(e: candle_core::Error) -> NovaError {
    NovaError::msg(format!("the built-in model failed while generating: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
        }
    }

    #[test]
    fn phi3_prompt_uses_its_own_delimiters() {
        let prompt = build_prompt(
            Architecture::Phi3,
            &[msg("system", "Be brief."), msg("user", "Hello")],
        );
        assert!(prompt.contains("<|system|>\nBe brief.<|end|>"), "{prompt}");
        assert!(prompt.contains("<|user|>\nHello<|end|>"), "{prompt}");
        // It must end handing the turn to the assistant, or the model
        // continues the user's message instead of replying to it.
        assert!(prompt.ends_with("<|assistant|>\n"), "{prompt}");
    }

    #[test]
    fn llama_prompt_uses_header_ids() {
        let prompt = build_prompt(Architecture::Llama, &[msg("user", "Hello")]);
        assert!(prompt.starts_with("<|begin_of_text|>"), "{prompt}");
        assert!(prompt.contains("<|start_header_id|>user<|end_header_id|>"), "{prompt}");
        assert!(prompt.ends_with("<|start_header_id|>assistant<|end_header_id|>\n\n"), "{prompt}");
    }

    #[test]
    fn the_two_templates_do_not_collide() {
        // Feeding one model the other's format yields fluent nonsense, so the
        // formats must stay distinguishable.
        let phi = build_prompt(Architecture::Phi3, &[msg("user", "x")]);
        let llama = build_prompt(Architecture::Llama, &[msg("user", "x")]);
        let qwen = build_prompt(Architecture::Qwen2, &[msg("user", "x")]);
        assert_ne!(phi, llama);
        assert_ne!(llama, qwen);
        assert_ne!(phi, qwen);
        assert!(!phi.contains("<|start_header_id|>"));
        assert!(!llama.contains("<|assistant|>\n"));
        assert!(!qwen.contains("<|start_header_id|>"));
    }

    #[test]
    fn unknown_roles_are_treated_as_user() {
        // A tool result must not be silently dropped from the prompt.
        let prompt = build_prompt(Architecture::Phi3, &[msg("tool", "result: 42")]);
        assert!(prompt.contains("result: 42"), "{prompt}");
    }

    #[test]
    fn qwen_prompt_uses_chatml() {
        let prompt = build_prompt(Architecture::Qwen2, &[msg("user", "Hello")]);
        assert!(prompt.contains("<|im_start|>user\nHello<|im_end|>"), "{prompt}");
        assert!(prompt.ends_with("<|im_start|>assistant\n"), "{prompt}");
    }

    #[test]
    fn every_architecture_declares_stop_sequences() {
        for arch in [
            Architecture::Phi3,
            Architecture::Llama,
            Architecture::Qwen2,
            Architecture::Qwen3,
        ] {
            assert!(
                !stop_sequences(arch).is_empty(),
                "{arch:?} would generate until it hit the token limit"
            );
        }
    }

    #[test]
    fn thread_count_is_sane() {
        let threads = inference_threads();
        assert!(threads >= 1);
        assert!(threads <= 256);
    }

    #[test]
    fn context_matches_memory() {
        let ctx = context_for_ram();
        assert!(ctx == 4096 || ctx == 8192, "unexpected context {ctx}");
    }
}
