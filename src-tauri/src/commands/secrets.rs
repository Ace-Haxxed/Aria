//! API keys, stored in the OS keychain.
//!
//! Secret Service on Linux, Keychain on macOS, Credential Manager on Windows.
//! Keys never touch the settings file or the database, so backing up a profile
//! or exporting the action log cannot leak them.

use crate::util::{JResult, AriaError};

const SERVICE: &str = "ai.aria.assistant";

fn entry(provider: &str) -> JResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, provider)
        .map_err(|e| AriaError::msg(format!("could not open the keychain: {e}")))
}

#[tauri::command]
pub async fn set_api_key(provider: String, key: String) -> JResult<()> {
    let e = entry(&provider)?;

    // An empty value means "forget this key".
    if key.trim().is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(AriaError::msg(format!("could not remove the key: {err}"))),
        };
    }

    e.set_password(&key)
        .map_err(|err| AriaError::msg(format!("could not save the key: {err}")))
}

#[tauri::command]
pub async fn get_api_key(provider: String) -> JResult<Option<String>> {
    match entry(&provider)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AriaError::msg(format!(
            "could not read the key: {e}. On Linux this usually means no keyring \
             daemon (gnome-keyring or kwallet) is running."
        ))),
    }
}

#[tauri::command]
pub async fn delete_api_key(provider: String) -> JResult<()> {
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AriaError::msg(format!("could not remove the key: {e}"))),
    }
}

/// Which providers currently have a key — lets Settings show status without
/// ever reading the secrets themselves.
#[tauri::command]
pub async fn list_configured_providers() -> JResult<Vec<String>> {
    let mut found = Vec::new();
    for provider in ["openai", "anthropic", "groq", "gemini", "custom"] {
        if let Ok(e) = entry(provider) {
            if e.get_password().is_ok() {
                found.push(provider.to_string());
            }
        }
    }
    Ok(found)
}
