//! Keyboard control commands.

use crate::platform;
use crate::util::JResult;

#[tauri::command]
pub async fn type_text(text: String) -> JResult<()> {
    platform::type_text(&text).await
}

#[tauri::command]
pub async fn press_key(combo: String) -> JResult<()> {
    platform::press_key(&combo).await
}

#[tauri::command]
pub async fn hold_key(key: String) -> JResult<()> {
    platform::hold_key(&key).await
}

#[tauri::command]
pub async fn release_key(key: String) -> JResult<()> {
    platform::release_key(&key).await
}

/// Press several keys together, e.g. `["ctrl", "shift", "s"]`.
#[tauri::command]
pub async fn hotkey(keys: Vec<String>) -> JResult<()> {
    platform::press_key(&keys.join("+")).await
}
