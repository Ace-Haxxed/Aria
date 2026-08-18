//! Window management commands.

use crate::platform::{self, WindowInfo};
use crate::util::JResult;

#[tauri::command]
pub async fn list_windows() -> JResult<Vec<WindowInfo>> {
    platform::list_windows().await
}

#[tauri::command]
pub async fn focus_window(target: String) -> JResult<()> {
    platform::focus_window(&target).await
}

#[tauri::command]
pub async fn move_window(target: String, x: i32, y: i32) -> JResult<()> {
    platform::move_window(&target, x, y).await
}

#[tauri::command]
pub async fn resize_window(target: String, w: i32, h: i32) -> JResult<()> {
    platform::resize_window(&target, w, h).await
}

#[tauri::command]
pub async fn close_window(target: String) -> JResult<()> {
    platform::close_window(&target).await
}

#[tauri::command]
pub async fn minimize_window(target: String) -> JResult<()> {
    platform::minimize_window(&target).await
}

#[tauri::command]
pub async fn maximize_window(target: String) -> JResult<()> {
    platform::maximize_window(&target).await
}

#[tauri::command]
pub async fn get_active_window() -> JResult<WindowInfo> {
    platform::active_window().await
}
