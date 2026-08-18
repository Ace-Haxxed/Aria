//! Mouse control commands.

use crate::platform::{self, MouseButton, Point, ScrollDirection};
use crate::util::JResult;

#[tauri::command]
pub async fn move_mouse(x: i32, y: i32) -> JResult<()> {
    platform::move_mouse(x, y).await
}

#[tauri::command]
pub async fn click(x: Option<i32>, y: Option<i32>, button: Option<MouseButton>) -> JResult<()> {
    platform::click(x, y, button.unwrap_or(MouseButton::Left)).await
}

#[tauri::command]
pub async fn double_click(x: Option<i32>, y: Option<i32>) -> JResult<()> {
    platform::double_click(x, y).await
}

#[tauri::command]
pub async fn right_click(x: Option<i32>, y: Option<i32>) -> JResult<()> {
    platform::click(x, y, MouseButton::Right).await
}

#[tauri::command]
pub async fn drag(x1: i32, y1: i32, x2: i32, y2: i32) -> JResult<()> {
    platform::drag(x1, y1, x2, y2).await
}

/// Click at a point, naming the button explicitly.
///
/// `click` above leaves both the position and the button optional, which suits
/// a UI button wired to "click where the pointer already is". An agent almost
/// always means a specific point and a specific button, and gets this instead.
#[tauri::command]
pub async fn click_mouse(x: i32, y: i32, button: Option<MouseButton>) -> JResult<()> {
    platform::click(Some(x), Some(y), button.unwrap_or(MouseButton::Left)).await
}

#[tauri::command]
pub async fn scroll(
    direction: ScrollDirection,
    amount: Option<u32>,
    // Scrolling acts on whatever is under the pointer, so a caller that names a
    // point means "scroll there" — not "scroll wherever the pointer happens to
    // be sitting from the last action".
    x: Option<i32>,
    y: Option<i32>,
) -> JResult<()> {
    if let (Some(x), Some(y)) = (x, y) {
        platform::move_mouse(x, y).await?;
    }
    platform::scroll(direction, amount.unwrap_or(3)).await
}

#[tauri::command]
pub async fn get_mouse_position() -> JResult<Point> {
    platform::mouse_position().await
}
