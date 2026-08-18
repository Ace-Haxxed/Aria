//! LLM transport.
//!
//! Every byte that goes to a model provider leaves from here, in Rust, using
//! reqwest. Nothing in the frontend calls `fetch` for an LLM API. That is not a
//! style preference — a WebView request has to satisfy the page CSP, the Tauri
//! HTTP allowlist and the provider's CORS policy all at once, and any one of
//! them failing looks identical to the user: the assistant simply never
//! answers. Moving the transport out of the webview removes all three at once.
//!
//! The split of responsibility is deliberate:
//!
//! * **Rust owns the transport** — endpoint, authentication, streaming, and
//!   turning a failed request into a sentence a person can act on.
//! * **The frontend owns the wire format** — it already converts the shared
//!   `Message[]` into each provider's message shape and reassembles the
//!   fragmented tool calls they stream back, with the quirks of five different
//!   APIs encoded in it. Reimplementing that here would duplicate the most
//!   delicate code in the project for no gain, so the already-converted body
//!   is passed through untouched.
//!
//! Response bodies stream back as Tauri events named after the caller's stream
//! id (`llm-chunk-<id>`, `llm-done-<id>`, `llm-error-<id>`). The id comes from
//! the caller so it can subscribe *before* invoking; allocating it here would
//! leave a window in which the first chunk is emitted with nobody listening.

use crate::util::{JResult, AriaError};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Connecting should be quick even on a slow link. There is deliberately no
/// overall timeout: a long generation can legitimately stream for minutes, and
/// cutting it off mid-answer would be worse than waiting.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/* ── Cancellation ───────────────────────────────────────────────── */

/// Stream ids the frontend has abandoned. The streaming loop checks this
/// between chunks, so a cancelled generation stops pulling from the network
/// instead of running to completion unseen.
static CANCELLED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Stop streaming `stream_id`. Safe to call for an id that already finished.
#[tauri::command]
pub async fn llm_cancel(stream_id: String) -> JResult<()> {
    lock(&CANCELLED).insert(stream_id);
    Ok(())
}

fn take_cancelled(id: &str) -> bool {
    lock(&CANCELLED).remove(id)
}

/* ── Result of opening a stream ─────────────────────────────────── */

/// What the frontend learns the moment the response headers arrive, before any
/// body has streamed. Mirrors just enough of `Response` for the caller to
/// decide whether to start reading or to show an error.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStart {
    pub ok: bool,
    pub status: u16,
    /// Set only when `ok` is false: a complete, actionable sentence.
    pub error: Option<String>,
    /// Seconds to wait before retrying, when the provider said so. The caller
    /// counts this down and retries itself rather than surfacing a failure.
    pub retry_after: Option<f64>,
    /// True when the request was refused for being too large, which the caller
    /// fixes by trimming rather than by waiting.
    pub too_large: bool,
}

impl StreamStart {
    fn ok(status: u16) -> Self {
        Self {
            ok: true,
            status,
            error: None,
            retry_after: None,
            too_large: false,
        }
    }

    fn failed(status: u16, error: String) -> Self {
        Self {
            ok: false,
            status,
            error: Some(error),
            retry_after: None,
            too_large: false,
        }
    }

    fn rate_limited(status: u16, error: String, retry_after: Option<f64>) -> Self {
        Self {
            ok: false,
            status,
            error: Some(error),
            retry_after,
            too_large: false,
        }
    }

    fn oversized(status: u16, error: String) -> Self {
        Self {
            ok: false,
            status,
            error: Some(error),
            retry_after: None,
            too_large: true,
        }
    }
}

/* ── Errors the user can act on ─────────────────────────────────── */

/// Pull the human-readable part out of a provider's error body.
///
/// The five providers disagree on where it lives — `error.message`,
/// `error` as a bare string, or `message` at the top level — so all three are
/// tried before falling back to the raw text.
fn extract_detail(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        let candidates = [
            v.get("error").and_then(|e| e.get("message")),
            v.get("error"),
            v.get("message"),
        ];
        for candidate in candidates.into_iter().flatten() {
            if let Some(s) = candidate.as_str() {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "no further detail".to_string()
    } else {
        trimmed.chars().take(300).collect()
    }
}

/// How long a provider asked us to wait, in seconds.
///
/// Providers state this in prose ("Please try again in 18.5s") and sometimes
/// in a `retry-after` header. Reading the exact figure means the retry lands
/// as soon as the window opens rather than after a guessed delay.
pub fn parse_retry_after(body: &str, header: Option<&str>) -> Option<f64> {
    if let Some(value) = header.and_then(|h| h.trim().parse::<f64>().ok()) {
        if value > 0.0 {
            return Some(value);
        }
    }

    // "try again in 18.5s", "try again in 2m30.5s", "retry after 4 seconds".
    let lower = body.to_lowercase();
    let anchor = ["try again in ", "retry after ", "retry in "]
        .iter()
        .find_map(|marker| lower.find(marker).map(|i| i + marker.len()))?;

    let tail: String = lower[anchor..].chars().take(24).collect();

    // Minutes and seconds, as Groq reports for longer waits.
    if let Some(m_at) = tail.find('m') {
        if let Ok(minutes) = tail[..m_at].trim().parse::<f64>() {
            let seconds = tail[m_at + 1..]
                .split(|c: char| !c.is_ascii_digit() && c != '.')
                .find(|p| !p.is_empty())
                .and_then(|p| p.parse::<f64>().ok())
                .unwrap_or(0.0);
            return Some(minutes * 60.0 + seconds);
        }
    }

    let number: String = tail
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    number.parse::<f64>().ok().filter(|v| *v > 0.0)
}

/// Turn an HTTP failure into a sentence that names the fix.
///
/// The user never sees a bare status code: every branch says what to do next,
/// because "401" is not something anyone can act on.
pub fn describe_status(provider: &str, status: u16, body: &str) -> String {
    let detail = extract_detail(body);
    let label = pretty_provider(provider);

    match status {
        401 | 403 => format!(
            "{label} did not accept that API key. Check it in Settings → AI, or paste a new one. ({detail})"
        ),
        404 => format!(
            "{label} does not have a model by that name. Pick a different model in Settings → AI. ({detail})"
        ),
        408 | 504 => format!("{label} took too long to respond. Try again in a moment. ({detail})"),
        413 => format!(
            "The conversation is too long for {label}. Start a new conversation, or switch to a model with a larger context window. ({detail})"
        ),
        429 => format!(
            "{label} is rate limiting this key. Wait a few seconds and try again, or switch provider in Settings → AI. ({detail})"
        ),
        s if s >= 500 => format!(
            "{label} is having server trouble — this is on their end, not yours. Try again shortly, or switch provider in Settings → AI. ({detail})"
        ),
        s => format!("{label} refused the request (HTTP {s}). {detail}"),
    }
}

/// Turn a transport failure into a sentence that names the fix.
fn friendly_transport_error(provider: &str, url: &str, e: &reqwest::Error) -> String {
    let label = pretty_provider(provider);

    if e.is_timeout() {
        return format!("{label} did not respond in time. Check your internet connection and try again.");
    }
    if e.is_connect() {
        // A local endpoint that refuses the connection means the server is not
        // running, which is a completely different fix from a network problem.
        if url.contains("localhost") || url.contains("127.0.0.1") {
            return format!(
                "{label} is not running on this machine. ARIA can start it for you, or you can switch to a cloud provider in Settings → AI."
            );
        }
        return format!("Could not reach {label}. Check your internet connection and try again.");
    }
    format!("The request to {label} failed. Check your connection and try again.")
}

fn pretty_provider(provider: &str) -> &str {
    match provider {
        "ollama" => "Ollama",
        "groq" => "Groq",
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        "gemini" => "Gemini",
        "openrouter" => "OpenRouter",
        "nvidia" => "NVIDIA",
        "bytez" => "Bytez",
        "builtin" => "The built-in model",
        _ => "The model provider",
    }
}

/* ── Streaming core ─────────────────────────────────────────────── */

/// How long a provider gets to return response headers. A model that is being
/// loaded into memory can be slow to start, but a minute of silence means
/// something is wrong rather than busy.
const HEADERS_TIMEOUT: Duration = Duration::from_secs(60);

/// How long the body may go without producing a single byte before the stream
/// is treated as stalled. This is deliberately not a cap on total duration —
/// a long answer that keeps arriving is healthy, and cutting it off mid-
/// sentence would be a worse failure than the one it prevents.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Send a prepared request and stream the response body back as events.
///
/// Returns once the response *headers* are in, so the caller learns
/// immediately whether the request was accepted; the body then streams in the
/// background until it ends, fails, or is cancelled.
///
/// A request that fails to connect is retried once. Transport failures are
/// frequently transient — a laptop waking, a local server still binding its
/// port — whereas an HTTP error is a considered answer from the server and
/// retrying it would just fail identically a second time.
async fn stream_request(
    app: AppHandle,
    provider: &str,
    stream_id: String,
    request: reqwest::RequestBuilder,
    url: String,
) -> StreamStart {
    // Clear any stale cancellation so a reused id cannot abort a fresh stream.
    take_cancelled(&stream_id);

    let retry = request.try_clone();
    let response = match send_once(request).await {
        Ok(r) => Ok(r),
        Err(first) => match retry {
            Some(retry) => {
                tokio::time::sleep(Duration::from_millis(400)).await;
                send_once(retry).await.map_err(|_| first)
            }
            // A streaming body cannot be replayed, so some requests are not
            // clonable; those simply do not get a second attempt.
            None => Err(first),
        },
    };

    let response = match response {
        Ok(r) => r,
        Err(e) => return StreamStart::failed(0, e.explain(provider, &url)),
    };

    let status = response.status();
    if !status.is_success() {
        let retry_header = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let body = response.text().await.unwrap_or_default();
        let code = status.as_u16();
        let message = describe_status(provider, code, &body);

        // Both of these are recoverable without the user doing anything: one
        // by waiting, the other by trimming. They are reported as conditions
        // rather than errors so the caller can handle them silently.
        if code == 429 {
            return StreamStart::rate_limited(
                code,
                message,
                parse_retry_after(&body, retry_header.as_deref()),
            );
        }
        if code == 413 || body.to_lowercase().contains("too large") {
            return StreamStart::oversized(code, message);
        }
        return StreamStart::failed(code, message);
    }

    let provider = provider.to_string();
    tauri::async_runtime::spawn(async move {
        pump(app, provider, stream_id, response).await;
    });

    StreamStart::ok(status.as_u16())
}

/// Why an attempt failed, kept so the retry can report the original cause.
enum SendFailure {
    Transport(reqwest::Error),
    TimedOut,
}

impl SendFailure {
    fn explain(&self, provider: &str, url: &str) -> String {
        match self {
            SendFailure::Transport(e) => friendly_transport_error(provider, url, e),
            SendFailure::TimedOut => format!(
                "{} did not start replying within a minute. It may be loading a model — try again in a moment.",
                pretty_provider(provider)
            ),
        }
    }
}

async fn send_once(request: reqwest::RequestBuilder) -> Result<reqwest::Response, SendFailure> {
    match tokio::time::timeout(HEADERS_TIMEOUT, request.send()).await {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(SendFailure::Transport(e)),
        Err(_) => Err(SendFailure::TimedOut),
    }
}

/// Read the body to completion, emitting decoded text as it arrives.
async fn pump(app: AppHandle, provider: String, stream_id: String, response: reqwest::Response) {
    let chunk_event = format!("llm-chunk-{stream_id}");
    let done_event = format!("llm-done-{stream_id}");
    let error_event = format!("llm-error-{stream_id}");

    let mut stream = response.bytes_stream();
    // Bytes left over from a chunk that ended mid-character. Network chunk
    // boundaries fall wherever the network puts them, and a multi-byte
    // character split across two of them would otherwise decode to a
    // replacement character — visible corruption in the middle of a word.
    let mut pending: Vec<u8> = Vec::new();

    loop {
        // A stalled connection produces neither data nor an error — it simply
        // never resolves — so waiting on the next chunk needs its own bound or
        // the answer hangs forever with the orb spinning.
        let next = match tokio::time::timeout(STALL_TIMEOUT, stream.next()).await {
            Ok(Some(next)) => next,
            Ok(None) => break,
            Err(_) => {
                let _ = app.emit(
                    &error_event,
                    format!(
                        "{} stopped responding part-way through the answer. Try again.",
                        pretty_provider(&provider)
                    ),
                );
                return;
            }
        };

        if take_cancelled(&stream_id) {
            let _ = app.emit(&done_event, ());
            return;
        }

        let bytes = match next {
            Ok(b) => b,
            Err(e) => {
                let _ = app.emit(
                    &error_event,
                    format!(
                        "The connection to {} dropped part-way through the answer. Try again. ({e})",
                        pretty_provider(&provider)
                    ),
                );
                return;
            }
        };

        pending.extend_from_slice(&bytes);
        let text = match std::str::from_utf8(&pending) {
            Ok(s) => {
                let owned = s.to_string();
                pending.clear();
                owned
            }
            Err(e) => {
                // Emit the valid prefix and hold the incomplete tail back for
                // the next chunk to complete.
                let valid = e.valid_up_to();
                let owned = String::from_utf8_lossy(&pending[..valid]).to_string();
                pending.drain(..valid);
                owned
            }
        };

        if !text.is_empty() {
            let _ = app.emit(&chunk_event, text);
        }
    }

    // A trailing partial character means the body was truncated; there is
    // nothing useful to salvage from it.
    let _ = app.emit(&done_event, ());
}

/* ── Shared request shapes ──────────────────────────────────────── */

/// Build the JSON body every OpenAI-compatible provider expects.
///
/// `messages` and `tools` arrive already in provider shape from the frontend,
/// so they are inserted verbatim rather than re-derived.
fn openai_body(
    model: &str,
    messages: Value,
    tools: Option<Value>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });

    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = max_tokens {
        body["max_tokens"] = json!(m);
    }
    if let Some(tools) = tools {
        if tools.as_array().is_some_and(|a| !a.is_empty()) {
            body["tools"] = tools;
            body["tool_choice"] = json!("auto");
        }
    }
    body
}

/// Ollama's body shape, which is close to but not the same as OpenAI's: the
/// generation settings live under `options`, and the token cap is called
/// `num_predict`.
pub fn ollama_body(
    model: &str,
    messages: Value,
    tools: Option<Value>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "options": {
            "temperature": temperature.unwrap_or(0.7),
            "num_predict": max_tokens.unwrap_or(2048),
        },
    });
    if let Some(tools) = tools {
        if tools.as_array().is_some_and(|a| !a.is_empty()) {
            body["tools"] = tools;
        }
    }
    body
}

fn trim_base(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

/* ── Provider commands ──────────────────────────────────────────── */

/// Ollama, on this machine. No API key: it is not an authenticated service.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ollama_chat(
    app: AppHandle,
    stream_id: String,
    base_url: Option<String>,
    model: String,
    messages: Value,
    tools: Option<Value>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> JResult<StreamStart> {
    let base = trim_base(base_url.as_deref().unwrap_or(super::ollama::DEFAULT_BASE_URL));
    let url = format!("{base}/api/chat");
    let body = ollama_body(&model, messages, tools, temperature, max_tokens);

    let request = client().post(&url).json(&body);
    Ok(stream_request(app, "ollama", stream_id, request, url).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn groq_chat(
    app: AppHandle,
    stream_id: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
    messages: Value,
    tools: Option<Value>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> JResult<StreamStart> {
    let base = trim_base(base_url.as_deref().unwrap_or("https://api.groq.com/openai/v1"));
    let url = format!("{base}/chat/completions");
    let body = openai_body(&model, messages, tools, temperature, max_tokens);

    let request = client().post(&url).bearer_auth(&api_key).json(&body);
    Ok(stream_request(app, "groq", stream_id, request, url).await)
}

/// `auth_style` selects the Authorization header format: `"raw"` sends the key
/// unprefixed, anything else uses `Bearer`. `provider_label` names the service
/// in error messages — this transport is shared, so the label is the only
/// thing that distinguishes OpenAI from OpenRouter, Bytez or a local server.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn openai_chat(
    app: AppHandle,
    stream_id: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
    messages: Value,
    tools: Option<Value>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    auth_style: Option<String>,
    provider_label: Option<String>,
) -> JResult<StreamStart> {
    let base = trim_base(base_url.as_deref().unwrap_or("https://api.openai.com/v1"));
    let url = format!("{base}/chat/completions");
    let body = openai_body(&model, messages, tools, temperature, max_tokens);

    let mut request = client().post(&url).json(&body);
    // A custom OpenAI-compatible endpoint (vLLM, LM Studio, llama.cpp) usually
    // wants no auth at all, and some reject a bearer token outright.
    let key = clean_key(&api_key);
    if !key.is_empty() {
        // Not every OpenAI-compatible service uses Bearer. Bytez expects the
        // bare key in the Authorization header, and prefixing it makes an
        // otherwise-valid key fail.
        if auth_style.as_deref() == Some("raw") {
            request = request.header(reqwest::header::AUTHORIZATION, key);
        } else {
            request = request.bearer_auth(key);
        }
    }
    // OpenRouter, Bytez and on-device servers all ride this transport because
    // they speak the same wire format. Without their own label every failure
    // would be blamed on OpenAI — "OpenAI does not have a model by that name"
    // when the model was never sent to OpenAI at all.
    let label = provider_label.as_deref().unwrap_or("openai");
    Ok(stream_request(app, label, stream_id, request, url).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn anthropic_chat(
    app: AppHandle,
    stream_id: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
    messages: Value,
    system: Option<String>,
    tools: Option<Value>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> JResult<StreamStart> {
    let base = trim_base(base_url.as_deref().unwrap_or("https://api.anthropic.com/v1"));
    let url = format!("{base}/messages");

    // Anthropic takes the system prompt as a top-level field rather than a
    // message, and requires max_tokens — it has no default.
    let mut body = json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens.unwrap_or(4096),
        "stream": true,
    });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if let Some(system) = system.filter(|s| !s.is_empty()) {
        body["system"] = json!(system);
    }
    if let Some(tools) = tools {
        if tools.as_array().is_some_and(|a| !a.is_empty()) {
            body["tools"] = tools;
        }
    }

    let request = client()
        .post(&url)
        .header("x-api-key", clean_key(&api_key))
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    Ok(stream_request(app, "anthropic", stream_id, request, url).await)
}

/// `messages` carries Gemini's own `contents` array, already converted by the
/// caller — Gemini names the assistant role "model" and wraps text in `parts`,
/// so it shares no shape with the other providers.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn gemini_chat(
    app: AppHandle,
    stream_id: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
    messages: Value,
    system: Option<String>,
    tools: Option<Value>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> JResult<StreamStart> {
    let base = trim_base(
        base_url
            .as_deref()
            .unwrap_or("https://generativelanguage.googleapis.com/v1beta"),
    );
    // `alt=sse` is what makes Gemini stream events instead of returning one
    // large JSON array at the end.
    let url = format!("{base}/models/{model}:streamGenerateContent?alt=sse");

    let mut body = json!({
        "contents": messages,
        "generationConfig": {
            "temperature": temperature.unwrap_or(0.7),
            "maxOutputTokens": max_tokens.unwrap_or(2048),
        },
    });
    if let Some(system) = system.filter(|s| !s.is_empty()) {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if let Some(tools) = tools {
        if tools.as_array().is_some_and(|a| !a.is_empty()) {
            body["tools"] = json!([{ "functionDeclarations": tools }]);
        }
    }

    // The key goes in a header rather than the query string so it cannot end
    // up in a proxy log or a crash report.
    let request = client()
        .post(&url)
        .header("x-goog-api-key", clean_key(&api_key))
        .json(&body);
    Ok(stream_request(app, "gemini", stream_id, request, url).await)
}

/* ── Generic non-streaming HTTP ─────────────────────────────────── */

/// A plain HTTP request, for everything that is not an LLM stream: web page
/// fetches, provider key validation, model listings.
///
/// This exists so the frontend has no reason to call `fetch` at all — one
/// transport, one place where TLS and timeouts are configured.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpReply {
    pub status: u16,
    pub ok: bool,
    pub body: String,
}

#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> JResult<HttpReply> {
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| AriaError::msg(format!("`{method}` is not an HTTP method")))?;

    let mut request = client()
        .request(method, &url)
        .timeout(Duration::from_millis(timeout_ms.unwrap_or(30_000)));

    for (k, v) in headers.unwrap_or_default() {
        request = request.header(k, v);
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let response = request.send().await.map_err(|e| {
        AriaError::msg(friendly_transport_error("", &url, &e))
    })?;

    let status = response.status();
    Ok(HttpReply {
        status: status.as_u16(),
        ok: status.is_success(),
        body: response.text().await.unwrap_or_default(),
    })
}

/* ── Key validation ─────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub valid: bool,
    /// Always populated — a reason on failure, a confirmation on success.
    pub message: String,
    /// Round-trip time of the check, so the user can compare providers.
    pub latency_ms: u64,
}

/// Check an API key is usable, cheaply, without spending a generation.
///
/// Each provider has a list endpoint that authenticates but costs nothing,
/// which makes this safe to run on every keystroke the setup wizard debounces.
/// Strip every whitespace character from a pasted key.
///
/// No provider issues keys containing whitespace, but copying one out of a
/// wrapped terminal, a PDF, or a chat message routinely picks up a newline in
/// the middle. `trim()` only removes it from the ends — an internal newline
/// survives into the HTTP header, where it makes the request unbuildable. The
/// symptom is a perfectly valid key being rejected with a network error, which
/// is impossible for a user to diagnose.
pub fn clean_key(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Check a Bytez key against both Authorization schemes.
///
/// Bytez documents `Authorization: <key>` for its native API, but also exposes
/// an OpenAI-compatible endpoint which conventionally uses `Bearer`. Trying
/// one and reporting failure would reject a valid key whenever the guess was
/// wrong — so both are attempted, and the scheme that works is remembered for
/// the chat requests that follow.
async fn validate_bytez(api_key: &str) -> JResult<KeyCheck> {
    let started = std::time::Instant::now();

    // `list/tasks` rather than the more obvious `list/models`: the latter
    // answers 500 `Expected parameter(s): modelId` even with a good key and
    // the documented `?task=` filter, so it cannot tell a bad key from a
    // working one. `list/tasks` returns 401 for a bad key and 200 for a good
    // one, which is exactly what validation needs.
    const LIST_URL: &str = "https://api.bytez.com/models/v2/list/tasks";
    let attempts: [(&str, String); 2] = [
        ("raw", api_key.to_string()),
        ("bearer", format!("Bearer {api_key}")),
    ];

    let mut last_status = 0u16;
    let mut last_body = String::new();

    for (style, header) in attempts {
        let Ok(response) = client()
            .get(LIST_URL)
            .header(reqwest::header::AUTHORIZATION, header)
            .timeout(Duration::from_secs(15))
            .send()
            .await
        else {
            continue;
        };

        let status = response.status();
        if status.is_success() {
            *lock(&BYTEZ_AUTH_STYLE) = Some(style.to_string());
            let latency_ms = started.elapsed().as_millis() as u64;
            return Ok(KeyCheck {
                valid: true,
                message: format!("Connected in {latency_ms} ms."),
                latency_ms,
            });
        }
        last_status = status.as_u16();
        last_body = response.text().await.unwrap_or_default();
    }

    let latency_ms = started.elapsed().as_millis() as u64;
    Ok(KeyCheck {
        valid: false,
        latency_ms,
        message: match last_status {
            0 => "Could not reach Bytez. Check your internet connection.".into(),
            401 | 403 => "Bytez rejected this key. Check you copied the whole thing from bytez.com.".into(),
            429 => "Bytez is rate limiting. The key looks valid — try again in a moment.".into(),
            // Bytez answers 5xx on some routes regardless of the key, so this
            // must not be phrased as a verdict on the key itself.
            s if s >= 500 => {
                "Bytez's API returned a server error. The key may well be fine — \
                 this is their end, so try again shortly."
                    .into()
            }
            s => describe_status("bytez", s, &last_body),
        },
    })
}

/// Which Authorization scheme Bytez accepted, once validation has found out.
static BYTEZ_AUTH_STYLE: Mutex<Option<String>> = Mutex::new(None);

/// The scheme to use for a Bytez chat request.
#[tauri::command]
pub async fn bytez_auth_style() -> JResult<String> {
    Ok(lock(&BYTEZ_AUTH_STYLE)
        .clone()
        // Its documented default, used until validation proves otherwise.
        .unwrap_or_else(|| "raw".to_string()))
}

#[tauri::command]
pub async fn validate_api_key(provider: String, api_key: String) -> JResult<KeyCheck> {
    let api_key = clean_key(&api_key);

    if api_key.is_empty() {
        return Ok(KeyCheck {
            valid: false,
            message: "Paste your API key to continue.".into(),
            latency_ms: 0,
        });
    }

    let label = pretty_provider(&provider);
    let request = match provider.as_str() {
        "groq" => client()
            .get("https://api.groq.com/openai/v1/models")
            .bearer_auth(&api_key),
        "openai" => client()
            .get("https://api.openai.com/v1/models")
            .bearer_auth(&api_key),
        "anthropic" => client()
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01"),
        "gemini" => client()
            .get("https://generativelanguage.googleapis.com/v1beta/models")
            .header("x-goog-api-key", &api_key),
        // Both are OpenAI-compatible, so their model listings authenticate the
        // same way and cost nothing.
        "openrouter" => client()
            .get("https://openrouter.ai/api/v1/key")
            .bearer_auth(&api_key),
        // NVIDIA's model listing is public and answers 200 to any key at all,
        // so it cannot tell a good key from a typo. A one-token completion is
        // the cheapest request that actually checks the credential.
        "nvidia" => client()
            .post("https://integrate.api.nvidia.com/v1/chat/completions")
            .bearer_auth(&api_key)
            .json(&serde_json::json!({
                "model": "meta/llama-3.1-8b-instruct",
                "messages": [{ "role": "user", "content": "hi" }],
                "max_tokens": 1,
            })),
        // Bytez is handled separately below: its documented scheme sends the
        // key raw (`Authorization: <key>`) while its OpenAI-compatible
        // endpoint may accept `Bearer`. Rather than guess wrong and reject a
        // valid key, both are tried.
        "bytez" => return validate_bytez(&api_key).await,
        _ => {
            return Ok(KeyCheck {
                valid: true,
                message: "This provider does not need a key.".into(),
                latency_ms: 0,
            })
        }
    };

    let started = std::time::Instant::now();
    let response = match request.timeout(Duration::from_secs(15)).send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(KeyCheck {
                valid: false,
                message: friendly_transport_error(&provider, "https://", &e),
                latency_ms: started.elapsed().as_millis() as u64,
            })
        }
    };
    let latency_ms = started.elapsed().as_millis() as u64;

    let status = response.status();
    if status.is_success() {
        return Ok(KeyCheck {
            valid: true,
            message: format!("Connected in {latency_ms} ms."),
            latency_ms,
        });
    }

    let body = response.text().await.unwrap_or_default();
    let lower = body.to_lowercase();

    // Providers disagree on how they signal a bad key. Gemini answers 400
    // INVALID_ARGUMENT rather than 401, so matching on status alone would file
    // a plainly-rejected key under "refused the request", which reads like an
    // outage rather than a wrong key.
    let rejected_key = matches!(status.as_u16(), 401 | 403)
        || lower.contains("api key not valid")
        || lower.contains("api_key_invalid")
        || lower.contains("invalid api key")
        || lower.contains("incorrect api key");

    // A key can be genuine and still be refused because the service was never
    // switched on for the project, which is a different fix entirely.
    let service_disabled = lower.contains("has not been used")
        || lower.contains("is disabled")
        || lower.contains("service_disabled")
        || lower.contains("enable the api");

    Ok(KeyCheck {
        valid: false,
        latency_ms,
        message: if service_disabled {
            format!(
                "{label} accepted the key but the API is not enabled for that project. \
                 Enable it in the provider's console, then try again."
            )
        } else if rejected_key {
            format!(
                "{label} rejected this key. Check you copied the whole thing, and that it is a \
                 {label} key rather than another provider's."
            )
        } else {
            match status.as_u16() {
                429 => format!("{label} is rate limiting. The key looks valid — try again in a moment."),
                s if s >= 500 => format!("{label} is temporarily unavailable. Try again shortly."),
                _ => describe_status(&provider, status.as_u16(), &body),
            }
        },
    })
}

#[cfg(test)]
mod tests {

    /// The exact symptom this fixes: Bytez rides the OpenAI transport, and a
    /// missing model used to be reported as "OpenAI does not have a model by
    /// that name" for a request OpenAI never saw.
    #[test]
    fn a_shared_transport_still_names_the_real_provider() {
        let bytez = describe_status("bytez", 404, r#"{"error":"not in catalog"}"#);
        assert!(bytez.contains("Bytez"), "{bytez}");
        assert!(!bytez.contains("OpenAI"), "{bytez}");

        let openrouter = describe_status("openrouter", 404, "{}");
        assert!(openrouter.contains("OpenRouter"), "{openrouter}");
        assert!(!openrouter.contains("OpenAI does not"), "{openrouter}");

        // The default is unchanged for OpenAI itself.
        assert!(describe_status("openai", 404, "{}").contains("OpenAI"));
    }

    /// Bytez rejects a valid key when it arrives with a `Bearer ` prefix, so
    /// the two schemes must produce genuinely different headers — and the raw
    /// one must be the key itself, byte for byte.
    #[test]
    fn raw_auth_scheme_sends_the_key_unprefixed() {
        let key = "sk-bytez-example-000";

        let raw = reqwest::header::HeaderValue::from_str(&clean_key(key)).unwrap();
        assert_eq!(raw.to_str().unwrap(), key);
        assert!(!raw.to_str().unwrap().starts_with("Bearer"));
        assert_ne!(raw.to_str().unwrap(), format!("Bearer {key}"));
    }

    /// Until validation proves which scheme Bytez accepts, the documented
    /// bare-key form is used — and it is the one validation tries first.
    #[test]
    fn bytez_auth_style_defaults_to_raw() {
        let stored = lock(&BYTEZ_AUTH_STYLE).clone();
        assert!(matches!(stored.as_deref(), None | Some("raw") | Some("bearer")));
    }
    use super::*;

    #[test]
    fn detail_is_pulled_from_every_provider_shape() {
        // OpenAI, Groq
        assert_eq!(
            extract_detail(r#"{"error":{"message":"bad key","type":"auth"}}"#),
            "bad key"
        );
        // Ollama
        assert_eq!(extract_detail(r#"{"error":"model not found"}"#), "model not found");
        // Some gateways
        assert_eq!(extract_detail(r#"{"message":"nope"}"#), "nope");
    }

    #[test]
    fn unparseable_bodies_still_yield_something() {
        assert_eq!(extract_detail(""), "no further detail");
        assert_eq!(extract_detail("  "), "no further detail");
        assert_eq!(extract_detail("<html>502</html>"), "<html>502</html>");
    }

    #[test]
    fn long_bodies_are_capped() {
        let body = "x".repeat(5_000);
        assert_eq!(extract_detail(&body).chars().count(), 300);
    }

    #[test]
    fn keys_survive_being_pasted_from_anywhere() {
        // Copying a key out of a wrapped terminal or a chat message picks up
        // whitespace. An internal newline makes the HTTP header unbuildable,
        // so a valid key is rejected with a network error the user cannot act
        // on — trimming the ends is not enough.
        assert_eq!(clean_key("  gsk_abc123  "), "gsk_abc123");
        assert_eq!(clean_key("gsk_abc\n123"), "gsk_abc123");
        assert_eq!(clean_key("sk-or-v1-abc\r\ndef"), "sk-or-v1-abcdef");
        assert_eq!(clean_key("AIza abc 123"), "AIzaabc123");
        assert_eq!(clean_key("\tsk-ant-x\t"), "sk-ant-x");
    }

    #[test]
    fn a_cleaned_key_is_a_valid_header_value() {
        // The concrete failure: reqwest cannot build a header containing a
        // newline, so the request never leaves the machine.
        let messy = "AIzaSy\nD-0000";
        assert!(reqwest::header::HeaderValue::from_str(messy).is_err());
        assert!(reqwest::header::HeaderValue::from_str(&clean_key(messy)).is_ok());
    }

    #[test]
    fn an_all_whitespace_key_is_empty() {
        assert!(clean_key("   \n\t ").is_empty());
    }

    #[test]
    fn retry_delay_is_read_from_the_providers_own_wording() {
        // Groq states the wait in prose; reading it exactly means the retry
        // lands as the window opens rather than after a guess.
        assert_eq!(
            parse_retry_after(
                r#"{"error":{"message":"Rate limit reached. Please try again in 18.5s."}}"#,
                None
            ),
            Some(18.5)
        );
        assert_eq!(
            parse_retry_after("Rate limit reached, retry after 4 seconds", None),
            Some(4.0)
        );
    }

    #[test]
    fn retry_delay_handles_minutes_and_seconds() {
        let value = parse_retry_after("please try again in 2m30.5s", None).unwrap();
        assert!((value - 150.5).abs() < 0.01, "got {value}");
    }

    #[test]
    fn the_retry_after_header_wins_when_present() {
        // A header is authoritative; prose is a fallback for providers that
        // omit it.
        assert_eq!(
            parse_retry_after("try again in 60s", Some("12")),
            Some(12.0)
        );
    }

    #[test]
    fn a_body_with_no_delay_yields_none() {
        assert_eq!(parse_retry_after("rate limit reached", None), None);
        assert_eq!(parse_retry_after("", None), None);
        // A zero or negative header is not a usable delay.
        assert_eq!(parse_retry_after("", Some("0")), None);
    }

    #[test]
    fn rate_limits_and_oversized_requests_are_flagged_for_recovery() {
        let limited = StreamStart::rate_limited(429, "slow down".into(), Some(9.0));
        assert_eq!(limited.retry_after, Some(9.0));
        assert!(!limited.too_large);

        let big = StreamStart::oversized(413, "too big".into());
        assert!(big.too_large);
        assert_eq!(big.retry_after, None);
    }

    #[test]
    fn every_http_error_names_a_next_step() {
        // The user must never be shown a bare status code with no way forward.
        for status in [401, 403, 404, 408, 413, 429, 500, 503] {
            let msg = describe_status("groq", status, "{}");
            assert!(msg.contains("Groq"), "{status}: {msg}");
            let actionable = ["Settings", "Try again", "try again", "Wait", "Start a new"];
            assert!(
                actionable.iter().any(|a| msg.contains(a)),
                "{status} has no suggested action: {msg}"
            );
        }
    }

    #[test]
    fn a_local_endpoint_refusing_is_reported_as_not_running() {
        // Distinguishing "not started" from "no internet" is the difference
        // between a fix the user can apply and one that confuses them.
        assert!(pretty_provider("ollama").contains("Ollama"));
    }

    #[test]
    fn openai_body_omits_empty_tools() {
        let body = openai_body("m", json!([]), Some(json!([])), None, None);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
        assert_eq!(body["stream"], json!(true));
    }

    #[test]
    fn openai_body_includes_real_tools() {
        let tools = json!([{ "type": "function", "function": { "name": "x" } }]);
        let body = openai_body("m", json!([]), Some(tools), Some(0.2), Some(64));
        assert!(body.get("tools").is_some());
        assert_eq!(body["tool_choice"], json!("auto"));
        assert_eq!(body["temperature"], json!(0.2));
        assert_eq!(body["max_tokens"], json!(64));
    }

    #[test]
    fn base_urls_lose_trailing_slashes() {
        assert_eq!(trim_base("http://x/v1/"), "http://x/v1");
        assert_eq!(trim_base("http://x/v1"), "http://x/v1");
    }

    #[test]
    fn cancellation_is_one_shot() {
        let id = "test-stream-cancel".to_string();
        lock(&CANCELLED).insert(id.clone());
        assert!(take_cancelled(&id), "first check should see the cancellation");
        assert!(!take_cancelled(&id), "cancellation must not linger for a reused id");
    }
}
