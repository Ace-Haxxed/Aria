//! The single source of truth for provider credentials.
//!
//! One file, `~/.config/aria/keys.json`, read once at startup and held in
//! memory for the life of the process. Every later read is a lock and a clone,
//! so sending the first message never waits on disk or on a keyring daemon.
//!
//! The file is written `0600`. That is weaker than the OS keychain this
//! replaced — anything running as this user can read it — but it removes the
//! keyring daemon from the startup path entirely, which is the point.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

use crate::util::{AriaError, JResult};

/// Providers the config always carries, so the settings UI has a stable set of
/// tabs whether or not a key has ever been saved for one.
pub const PROVIDERS: [&str; 6] = ["openai", "anthropic", "gemini", "groq", "openrouter", "bytez"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyConfig {
    #[serde(default = "default_provider")]
    pub active_provider: String,
    #[serde(default)]
    pub keys: BTreeMap<String, String>,
    /// The model in use right now, for whichever provider is active.
    #[serde(default = "default_model")]
    pub model: String,
    /// The OpenRouter model the user picked from the live list.
    ///
    /// Remembered separately from `model` so switching to another provider and
    /// back restores the choice instead of silently resetting it — OpenRouter
    /// ids are long and picked from a 400-entry catalogue, so losing one is
    /// more annoying than losing, say, a Groq default.
    #[serde(default = "default_openrouter_model")]
    pub openrouter_model: String,
}

fn default_openrouter_model() -> String {
    // Deliberately empty. OpenRouter's catalogue changes under us — every
    // model id that has been hardcoded here so far was withdrawn — so the
    // default is resolved from the live list at startup instead. Until that
    // resolves there is no OpenRouter model, and the UI says so rather than
    // pointing at an id that may no longer exist.
    String::new()
}

/// Smallest context window worth defaulting to.
const MIN_CONTEXT: u32 = 32_000;

fn default_provider() -> String {
    "bytez".into()
}

fn default_model() -> String {
    default_model_for(&default_provider())
}

/// A model each provider actually serves.
///
/// Provider and model have to move together. Adopting a key without also
/// adopting a model that provider hosts leaves a config that authenticates
/// fine and then 404s on the first message — which reads as a broken key
/// rather than a mismatched model.
pub fn default_model_for(provider: &str) -> String {
    match provider {
        // Resolved from the live catalogue, never hardcoded.
        "openrouter" => "",
        "groq" => "llama-3.1-8b-instant",
        "openai" => "gpt-4o-mini",
        "anthropic" => "claude-sonnet-4-5",
        "gemini" => "gemini-2.5-flash",
        "bytez" => "google/gemma-2-9b-it",
        _ => "google/gemma-4-26b-a4b-it:free",
    }
    .into()
}

impl Default for KeyConfig {
    fn default() -> Self {
        Self {
            active_provider: default_provider(),
            keys: PROVIDERS.iter().map(|p| ((*p).into(), String::new())).collect(),
            model: default_model(),
            openrouter_model: default_openrouter_model(),
        }
    }
}

impl KeyConfig {
    /// Guarantee an entry for every known provider, so the UI never has to
    /// distinguish "no key" from "no such field".
    fn fill(mut self) -> Self {
        for p in PROVIDERS {
            self.keys.entry(p.into()).or_default();
        }
        self
    }

    /// The key for the active provider, if one is set.
    pub fn active_key(&self) -> Option<&str> {
        self.keys.get(&self.active_provider).map(String::as_str).filter(|k| !k.is_empty())
    }
}

/// `~/.config/aria/`, honouring `XDG_CONFIG_HOME`.
pub fn config_dir() -> JResult<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .ok_or_else(|| AriaError::msg("ARIA could not locate your config directory."))?;
    Ok(base.join("aria"))
}

pub fn config_path() -> JResult<PathBuf> {
    Ok(config_dir()?.join("keys.json"))
}

/// The in-memory copy. Written through to disk on every change.
static CONFIG: RwLock<Option<KeyConfig>> = RwLock::new(None);

fn read_from_disk() -> KeyConfig {
    let Ok(path) = config_path() else {
        return KeyConfig::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return KeyConfig::default();
    };
    // A corrupt or hand-edited file must not stop ARIA from starting; the
    // defaults let the user re-enter a key rather than face a dead app.
    serde_json::from_str::<KeyConfig>(&text).map(KeyConfig::fill).unwrap_or_default()
}

/// Read the config into memory. Called once, before the window is shown.
///
/// Returns whether a usable key was found, which the UI uses to decide between
/// the chat view and the key prompt without a second round trip.
pub fn load() -> bool {
    let mut config = read_from_disk();

    // First run after upgrading from the keychain build: adopt whatever was
    // stored there so existing users are not silently logged out.
    if config.keys.values().all(String::is_empty) {
        let mut adopted = false;
        for provider in PROVIDERS {
            if let Some(key) = keychain_key(provider) {
                config.keys.insert(provider.into(), key);
                adopted = true;
            }
        }
        if adopted {
            if let Some(p) = PROVIDERS.iter().find(|p| {
                config.keys.get(**p).is_some_and(|k| !k.is_empty())
            }) {
                config.active_provider = (*p).into();
                // The model has to follow the provider, or the adopted key
                // points at a model that provider has never heard of.
                config.model = default_model_for(p);
            }
            let _ = write_to_disk(&config);
        }
    }

    let has_key = config.active_key().is_some();
    *CONFIG.write().unwrap() = Some(config);
    has_key
}

/// Read one key out of the old keychain store, ignoring every failure — a
/// missing keyring daemon is the normal case on a fresh machine.
fn keychain_key(provider: &str) -> Option<String> {
    keyring::Entry::new("ai.aria.assistant", provider)
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.trim().is_empty())
}

fn current() -> KeyConfig {
    if let Some(c) = CONFIG.read().unwrap().clone() {
        return c;
    }
    // A command arriving before setup ran: load rather than serve defaults.
    load();
    CONFIG.read().unwrap().clone().unwrap_or_default()
}

fn write_to_disk(config: &KeyConfig) -> JResult<()> {
    let dir = config_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = config_path()?;

    let json = serde_json::to_string_pretty(config)
        .map_err(|e| AriaError::msg(format!("could not encode the key file: {e}")))?;

    // Write to a temporary file and rename, so an interrupted write cannot
    // leave a half-written file where the keys used to be.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    restrict(&tmp)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Owner-only permissions. The file holds live credentials in plain text.
#[cfg(unix)]
fn restrict(path: &std::path::Path) -> JResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict(_path: &std::path::Path) -> JResult<()> {
    Ok(())
}


/* ── OpenRouter's free catalogue ────────────────────────────────── */

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeModel {
    pub id: String,
    pub name: String,
    pub context: u32,
    /// Total parameters in billions, when the id or name states them.
    pub params_b: Option<f32>,
    /// `"Smart"`, `"Balanced"` or `"Fast"`; `None` when the size is unknown.
    pub tier: Option<String>,
    pub vision: bool,
}

/// Parameter count in billions, read from a model id or display name.
///
/// OpenRouter's `/models` response has no parameter field, so the only source
/// is the name itself. Mixture-of-experts ids state both totals and active
/// experts (`gemma-4-26b-a4b`, `nemotron-3-ultra-550b-a55b`); the `aNNb` part
/// is the active count and is skipped, because the headline number users
/// recognise — and the one that tracks capability — is the total.
pub fn params_billions(id: &str, name: &str) -> Option<f32> {
    for text in [id, name] {
        let bytes = text.as_bytes();
        let lower = text.to_ascii_lowercase();
        let chars: Vec<char> = lower.chars().collect();

        let mut i = 0;
        while i < chars.len() {
            if !chars[i].is_ascii_digit() {
                i += 1;
                continue;
            }
            // A digit run preceded by a letter is part of a word such as
            // `a4b` (active experts) or `v2`, not a standalone size.
            let preceded_by_letter = i > 0 && chars[i - 1].is_ascii_alphabetic();

            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let ends_with_b = i < chars.len() && chars[i] == 'b';
            // `26b-` yes, `26bit` no.
            let boundary_after = i + 1 >= chars.len() || !chars[i + 1].is_ascii_alphanumeric();

            if ends_with_b && boundary_after && !preceded_by_letter {
                if let Ok(v) = lower[start..i].parse::<f32>() {
                    if v > 0.0 {
                        return Some(v);
                    }
                }
            }
            let _ = bytes;
        }
    }
    None
}

/// Bucket a size into the label shown beside the model.
///
/// The bands quoted in the brief leave 3–7B and 30–70B unlabelled; those gaps
/// are closed here rather than leaving real models with no tier at all.
pub fn tier_for(params_b: Option<f32>) -> Option<String> {
    let p = params_b?;
    Some(
        if p >= 70.0 {
            "Smart"
        } else if p >= 3.0 {
            "Balanced"
        } else {
            "Fast"
        }
        .to_string(),
    )
}

/// Parse OpenRouter's `/models` payload into the free models only.
///
/// Split out from the request so the filtering and labelling can be tested
/// against a fixed payload, with no network involved.
pub fn parse_free_models(body: &str) -> Vec<FreeModel> {
    let Ok(root) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let Some(items) = root.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut out: Vec<FreeModel> = items
        .iter()
        .filter(|m| {
            let id = m.get("id").and_then(Value::as_str).unwrap_or_default();
            if !id.ends_with(":free") {
                return false;
            }

            let context = m.get("context_length").and_then(Value::as_u64).unwrap_or(0);
            if context < MIN_CONTEXT as u64 {
                return false;
            }

            // The obvious "is it a chat model" field, `architecture.
            // instruct_type`, is null on every free model — it names a prompt
            // template for raw-completion models, so a model served through a
            // chat API has none. Filtering on it non-null selects zero models.
            //
            // `supported_parameters` containing `tools` is the signal that
            // actually matters here: ARIA is an agent, and a model that cannot
            // take tool definitions cannot run its loop at all.
            m.get("supported_parameters")
                .and_then(Value::as_array)
                .is_some_and(|p| p.iter().any(|x| x.as_str() == Some("tools")))
        })
        .filter_map(|m| {
            let id = m.get("id").and_then(Value::as_str)?.to_string();
            let name = m
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let context = m
                .get("context_length")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            let vision = m
                .get("architecture")
                .and_then(|a| a.get("input_modalities"))
                .and_then(Value::as_array)
                .is_some_and(|v| v.iter().any(|x| x.as_str() == Some("image")));

            let params_b = params_billions(&id, &name);
            Some(FreeModel {
                tier: tier_for(params_b),
                id,
                name,
                context,
                params_b,
                vision,
            })
        })
        .collect();

    // Largest context window first, ties broken alphabetically. The same
    // ordering picks the default and fills the dropdown, so the model at the
    // top of the list is always the one a fresh install would choose.
    out.sort_by(|a, b| b.context.cmp(&a.context).then(a.id.cmp(&b.id)));
    out
}

/// The model a fresh install should use, given a catalogue payload.
///
/// `None` when nothing qualifies — better to have no OpenRouter model and say
/// so than to point at an id that may have been withdrawn.
pub fn pick_default_model(body: &str) -> Option<String> {
    parse_free_models(body).first().map(|m| m.id.clone())
}

/// The free models OpenRouter is serving right now.
///
/// Returns an empty list rather than an error when the fetch fails: the
/// settings page falls back to the built-in default, and a dropdown that
/// cannot load is not a reason to fail opening settings.
/// Fetch the raw catalogue, authenticated with the stored OpenRouter key.
///
/// The endpoint is public, but sending the key lets OpenRouter scope the
/// response to what this account may actually call.
async fn fetch_catalogue() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;

    let mut request = client.get("https://openrouter.ai/api/v1/models");
    let key = current().keys.get("openrouter").cloned().unwrap_or_default();
    if !key.is_empty() {
        request = request.bearer_auth(super::llm::clean_key(&key));
    }

    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

/// The free models OpenRouter is serving right now.
///
/// Returns an empty list rather than an error when the fetch fails: a
/// dropdown that cannot load is not a reason to fail opening settings.
#[tauri::command]
pub async fn openrouter_free_models() -> JResult<Vec<FreeModel>> {
    Ok(match fetch_catalogue().await {
        Some(body) => parse_free_models(&body),
        None => Vec::new(),
    })
}

/// Bring the stored OpenRouter model in line with the live catalogue.
///
/// Runs after start-up rather than during it: this is a network round trip,
/// and the window must not wait on it. Only writes when something actually
/// needs to change — either nothing is saved, or what is saved has been
/// withdrawn, which is how every previously hardcoded default failed.
#[tauri::command]
pub async fn reconcile_openrouter_model() -> JResult<Option<String>> {
    let Some(body) = fetch_catalogue().await else {
        return Ok(None);
    };
    let models = parse_free_models(&body);
    if models.is_empty() {
        return Ok(None);
    }

    let config = current();
    let saved = &config.openrouter_model;
    let still_listed = !saved.is_empty() && models.iter().any(|m| &m.id == saved);
    if still_listed {
        return Ok(None);
    }

    let Some(chosen) = models.first().map(|m| m.id.clone()) else {
        return Ok(None);
    };

    let mut config = config;
    config.openrouter_model = chosen.clone();
    // Only move the live model if OpenRouter is the provider in use; another
    // provider's model must not be replaced with an OpenRouter id.
    if config.active_provider == "openrouter" {
        config.model = chosen.clone();
    }
    write_to_disk(&config)?;
    *CONFIG.write().unwrap() = Some(config);

    Ok(Some(chosen))
}

/* ── Commands ───────────────────────────────────────────────────── */

/// Whether ARIA was started with `aria --keys`, so the UI can open straight
/// to the key settings instead of the chat view.
#[tauri::command]
pub async fn open_keys_requested() -> JResult<bool> {
    Ok(std::env::var("ARIA_OPEN_KEYS").is_ok())
}

/// The scripted demo, or `None` when ARIA was not started with `--demo`.
///
/// The steps live here rather than in the frontend so `--demo` is a property
/// of how the binary was invoked: the window asks once, on load, and a normal
/// launch gets nothing back.
#[tauri::command]
pub async fn demo_script() -> JResult<Option<Vec<String>>> {
    if std::env::var("ARIA_DEMO").is_err() {
        return Ok(None);
    }
    Ok(Some(vec![
        "what is currently on my screen?".into(),
        "open firefox".into(),
        "what time is it".into(),
    ]))
}

#[tauri::command]
pub async fn key_config() -> JResult<KeyConfig> {
    Ok(current())
}

#[tauri::command]
pub async fn set_key(provider: String, key: String) -> JResult<()> {
    let mut config = current();
    // Stripped of all whitespace: a key copied out of a wrapped terminal
    // carries a newline that makes the request header unbuildable.
    config.keys.insert(provider, super::llm::clean_key(&key));
    write_to_disk(&config)?;
    *CONFIG.write().unwrap() = Some(config);
    Ok(())
}

#[tauri::command]
pub async fn set_active_provider(provider: String) -> JResult<()> {
    let mut config = current();
    // Switching provider carries the model with it unless the current one is
    // plausibly shared — keeping the old id would point at a model the new
    // provider does not serve.
    if config.active_provider != provider {
        config.model = if provider == "openrouter" {
            // Restore what was picked from the live list last time.
            config.openrouter_model.clone()
        } else {
            default_model_for(&provider)
        };
    }
    config.active_provider = provider;
    write_to_disk(&config)?;
    *CONFIG.write().unwrap() = Some(config);
    Ok(())
}

#[tauri::command]
pub async fn set_active_model(model: String) -> JResult<()> {
    let mut config = current();
    // Remember an OpenRouter choice separately, so it survives a trip through
    // another provider.
    if config.active_provider == "openrouter" {
        config.openrouter_model = model.clone();
    }
    config.model = model;
    write_to_disk(&config)?;
    *CONFIG.write().unwrap() = Some(config);
    Ok(())
}

/// Delete every stored key and reset to defaults. Backs `aria --reset`.
#[tauri::command]
pub async fn reset_key_config() -> JResult<()> {
    let config = KeyConfig::default();
    write_to_disk(&config)?;
    *CONFIG.write().unwrap() = Some(config);
    Ok(())
}

#[derive(Serialize)]
pub struct KeyCheck {
    pub ok: bool,
    pub message: String,
    pub latency_ms: u64,
}

/// The cheapest authenticated request each provider offers.
///
/// These are list or metadata endpoints rather than completions: they cost
/// nothing, and a completion would bill the user for testing a key.
fn probe(provider: &str, key: &str) -> Option<reqwest::RequestBuilder> {
    let client = reqwest::Client::builder()
        // The budget is 2s end to end, so the request itself gets slightly less.
        .timeout(Duration::from_millis(1_800))
        .build()
        .ok()?;
    let key = super::llm::clean_key(key);

    Some(match provider {
        "openai" => client.get("https://api.openai.com/v1/models").bearer_auth(key),
        "anthropic" => client
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        "gemini" => client
            .get("https://generativelanguage.googleapis.com/v1beta/models")
            .header("x-goog-api-key", key),
        "groq" => client.get("https://api.groq.com/openai/v1/models").bearer_auth(key),
        "openrouter" => client.get("https://openrouter.ai/api/v1/key").bearer_auth(key),
        // Bytez wants the bare key, and `list/models` answers 500 even for a
        // good key — `list/tasks` is the one that actually discriminates.
        "bytez" => client
            .get("https://api.bytez.com/models/v2/list/tasks")
            .header(reqwest::header::AUTHORIZATION, key),
        _ => return None,
    })
}

#[tauri::command]
pub async fn validate_key(provider: String, key: String) -> JResult<KeyCheck> {
    let started = std::time::Instant::now();

    if key.trim().is_empty() {
        return Ok(KeyCheck { ok: false, message: "No key entered.".into(), latency_ms: 0 });
    }

    let Some(request) = probe(&provider, &key) else {
        return Ok(KeyCheck {
            ok: false,
            message: format!("{provider} is not a provider ARIA can check."),
            latency_ms: 0,
        });
    };

    let outcome = request.send().await;
    let latency_ms = started.elapsed().as_millis() as u64;

    Ok(match outcome {
        Ok(r) if r.status().is_success() => {
            KeyCheck { ok: true, message: format!("Connected in {latency_ms} ms."), latency_ms }
        }
        Ok(r) => {
            let status = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            KeyCheck {
                ok: false,
                latency_ms,
                message: match status {
                    401 | 403 => "That key was refused. Check you copied all of it.".into(),
                    429 => "Rate limited — the key looks valid. Try again shortly.".into(),
                    s => super::llm::describe_status(&provider, s, &body),
                },
            }
        }
        Err(e) if e.is_timeout() => KeyCheck {
            ok: false,
            latency_ms,
            message: "The provider did not answer within 2 seconds.".into(),
        },
        Err(_) => KeyCheck {
            ok: false,
            latency_ms,
            message: "Could not reach the provider. Check your internet connection.".into(),
        },
    })
}

#[cfg(test)]
mod tests {

    /// Real ids from OpenRouter's catalogue. The `aNNb` suffix is the active
    /// expert count on a mixture-of-experts model and must not be mistaken for
    /// the model's size.
    #[test]
    fn parameter_counts_come_from_the_model_id() {
        assert_eq!(params_billions("google/gemma-4-26b-a4b-it:free", ""), Some(26.0));
        assert_eq!(params_billions("nvidia/nemotron-3-ultra-550b-a55b:free", ""), Some(550.0));
        assert_eq!(params_billions("nvidia/nemotron-nano-9b-v2:free", ""), Some(9.0));
        assert_eq!(params_billions("openai/gpt-oss-20b:free", ""), Some(20.0));
        assert_eq!(params_billions("liquid/lfm-2.5-2.6b:free", ""), Some(2.6));
        assert_eq!(params_billions("nvidia/nemotron-3-super-120b-a12b:free", ""), Some(120.0));
    }

    #[test]
    fn a_model_with_no_stated_size_reports_none() {
        // Better to show no label than to invent one.
        assert_eq!(params_billions("z-ai/glm-5.2:free", ""), None);
        assert_eq!(params_billions("cohere/north-mini-code:free", ""), None);
        assert_eq!(params_billions("openrouter/free", ""), None);
    }

    #[test]
    fn tiers_cover_the_whole_range_with_no_gaps() {
        assert_eq!(tier_for(Some(2.6)).as_deref(), Some("Fast"));
        assert_eq!(tier_for(Some(3.0)).as_deref(), Some("Balanced"));
        assert_eq!(tier_for(Some(26.0)).as_deref(), Some("Balanced"));
        // The brief left 30-70B unspecified; it must still land somewhere.
        assert_eq!(tier_for(Some(45.0)).as_deref(), Some("Balanced"));
        assert_eq!(tier_for(Some(70.0)).as_deref(), Some("Smart"));
        assert_eq!(tier_for(Some(550.0)).as_deref(), Some("Smart"));
        assert_eq!(tier_for(None), None);
    }




    /// Each clause of the filter, proven by a model that fails only it.
    #[test]
    fn the_filter_requires_free_plus_context_plus_tool_support() {
        let body = r#"{"data":[
          {"id":"ok/keeper-9b:free","context_length":128000,
           "supported_parameters":["tools","temperature"]},
          {"id":"no/not-free-9b","context_length":128000,
           "supported_parameters":["tools"]},
          {"id":"no/too-small-9b:free","context_length":8000,
           "supported_parameters":["tools"]},
          {"id":"no/no-tools-9b:free","context_length":128000,
           "supported_parameters":["temperature"]}
        ]}"#;
        let ids: Vec<_> = parse_free_models(body).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["ok/keeper-9b:free"]);
    }

    /// `architecture.instruct_type` is null on every model OpenRouter serves
    /// through its chat API — it names a prompt template for raw-completion
    /// models. Requiring it non-null would select nothing at all, so a chat
    /// model must survive regardless of what that field says.
    #[test]
    fn a_null_instruct_type_does_not_exclude_a_chat_model() {
        let body = r#"{"data":[{"id":"a/chat-9b:free","context_length":128000,
          "architecture":{"instruct_type":null},
          "supported_parameters":["tools"]}]}"#;
        assert_eq!(parse_free_models(body).len(), 1);
    }

    #[test]
    fn ranking_is_largest_context_then_alphabetical() {
        let body = r#"{"data":[
          {"id":"b/mid:free","context_length":200000,"supported_parameters":["tools"]},
          {"id":"z/big:free","context_length":900000,"supported_parameters":["tools"]},
          {"id":"a/big:free","context_length":900000,"supported_parameters":["tools"]}
        ]}"#;
        let ids: Vec<_> = parse_free_models(body).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["a/big:free", "z/big:free", "b/mid:free"]);
        assert_eq!(pick_default_model(body).as_deref(), Some("a/big:free"));
    }

    #[test]
    fn nothing_qualifying_means_no_default_rather_than_a_guess() {
        assert_eq!(pick_default_model(r#"{"data":[]}"#), None);
        assert_eq!(pick_default_model("garbage"), None);
    }

    #[test]
    fn vision_and_context_survive_parsing() {
        let body = r#"{"data":[{"id":"x/seer-9b:free","name":"Seer 9b",
          "context_length":262144,
          "architecture":{"input_modalities":["text","image"]},
          "supported_parameters":["tools"]}]}"#;
        let m = &parse_free_models(body)[0];
        assert!(m.vision);
        assert_eq!(m.context, 262_144);
        assert_eq!(m.params_b, Some(9.0));
    }

    #[test]
    fn a_malformed_payload_yields_no_models_rather_than_panicking() {
        assert!(parse_free_models("not json").is_empty());
        assert!(parse_free_models(r#"{"unexpected":1}"#).is_empty());
        assert!(parse_free_models(r#"{"data":"wrong type"}"#).is_empty());
    }

    /// Hits OpenRouter for real and checks the catalogue still contains free
    /// models, and that the id ARIA falls back to is one of them.
    ///
    /// This is the test that catches a default going stale — exactly how the
    /// previous default was found to have been withdrawn. It skips rather than
    /// fails when the network is unavailable, because "no internet" is not the
    /// same finding as "the model is gone".
    #[test]
    fn the_live_catalogue_still_has_free_models() {
        let Ok(runtime) = tokio::runtime::Runtime::new() else {
            eprintln!("skipping: no tokio runtime");
            return;
        };

        let fetched = runtime.block_on(async {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .ok()?;
            let response = client
                .get("https://openrouter.ai/api/v1/models")
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            response.text().await.ok()
        });

        let Some(body) = fetched else {
            eprintln!("skipping: OpenRouter unreachable");
            return;
        };

        let models = parse_free_models(&body);
        assert!(!models.is_empty(), "OpenRouter listed no free models at all");
        assert!(
            models.iter().any(|m| m.id.ends_with(":free")),
            "no `:free` model in the catalogue"
        );
        // Whatever the ranking picks must itself be in the catalogue. There is
        // no hardcoded id left to go stale, so this checks the property that
        // every hardcoded default eventually violated.
        let chosen = pick_default_model(&body).expect("a default should be pickable");
        assert!(models.iter().any(|m| m.id == chosen), "picked {chosen}, not listed");
        assert!(
            models.iter().all(|m| m.context >= MIN_CONTEXT),
            "a model below the {MIN_CONTEXT}-token floor was listed"
        );
    }

    /// Provider and model must never diverge: every provider needs a default
    /// model, and it must not be another provider's.
    #[test]
    fn every_provider_has_its_own_default_model() {
        let mut seen = std::collections::HashSet::new();
        for p in PROVIDERS {
            let m = default_model_for(p);
            if p == "openrouter" {
                // Resolved live; a static default here is what kept breaking.
                assert!(m.is_empty());
                continue;
            }
            assert!(!m.is_empty(), "{p} has no default model");
            seen.insert(m);
        }
        // Bytez and OpenRouter both use `vendor/model` ids, so a collision
        // here would mean one provider inherited the other's default.
        assert!(seen.len() >= PROVIDERS.len() - 1, "defaults collide: {seen:?}");
    }

    #[test]
    fn adopting_a_key_also_adopts_that_providers_model() {
        // The exact failure this prevents: an OpenRouter key adopted from the
        // keychain while the model stayed at the Bytez default.
        assert_ne!(default_model_for("openrouter"), default_model_for("bytez"));
        // OpenRouter alone has no static default — it is resolved from the
        // live catalogue, because every id hardcoded here was withdrawn.
        assert!(default_model_for("openrouter").is_empty());
    }
    use super::*;

    #[test]
    fn every_provider_has_a_slot() {
        let config = KeyConfig::default();
        for p in PROVIDERS {
            assert!(config.keys.contains_key(p), "{p} missing");
        }
    }

    #[test]
    fn a_partial_file_still_parses() {
        // Hand-edited configs are normal; a missing field must not be fatal.
        let config: KeyConfig =
            serde_json::from_str(r#"{"keys":{"groq":"gsk_x"}}"#).unwrap();
        let config = config.fill();
        assert_eq!(config.active_provider, "bytez");
        assert_eq!(config.keys.get("groq").unwrap(), "gsk_x");
        assert_eq!(config.keys.get("openai").unwrap(), "");
    }

    #[test]
    fn a_corrupt_file_falls_back_to_defaults() {
        assert!(serde_json::from_str::<KeyConfig>("{not json").is_err());
    }

    #[test]
    fn an_empty_key_is_not_an_active_key() {
        let mut config = KeyConfig::default();
        assert!(config.active_key().is_none());
        config.keys.insert("bytez".into(), "abc".into());
        assert_eq!(config.active_key(), Some("abc"));
    }

    #[test]
    fn every_provider_has_a_probe() {
        for p in PROVIDERS {
            assert!(probe(p, "test-key").is_some(), "{p} has no validation endpoint");
        }
        assert!(probe("nonesuch", "k").is_none());
    }

    #[test]
    fn the_config_path_sits_under_aria() {
        let path = config_path().unwrap();
        assert!(path.ends_with("aria/keys.json"), "{path:?}");
    }
}
