//! Per-environment implementations of the primitives ARIA needs.
//!
//! `mod.rs` owns the dispatch table: it detects the environment once at startup
//! and every call is then routed to the backend that actually works there.

pub mod detect;
pub mod env;
pub mod input;
pub mod macos;
#[cfg(target_os = "linux")]
pub mod portal;

/// Stub for the non-Linux builds.
///
/// The `wayland` module is compiled on every target — the dispatch table below
/// has to typecheck all of its arms regardless of which one can run — so the
/// portal it calls has to exist everywhere too, even though only Linux has one.
#[cfg(not(target_os = "linux"))]
pub mod portal {
    use crate::util::{JResult, AriaError};

    pub async fn screenshot() -> JResult<Vec<u8>> {
        Err(AriaError::msg(
            "xdg-desktop-portal exists only on Linux desktops.",
        ))
    }
}

pub mod wayland;
pub mod windows;
pub mod x11;

use crate::util::{JResult, AriaError};
use detect::{OsKind, PlatformInfo, SessionType};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// Detected once — probing PATH for two dozen binaries on every mouse move
/// would be wasteful, and the environment cannot change while the app runs.
static INFO: OnceLock<PlatformInfo> = OnceLock::new();

pub fn info() -> &'static PlatformInfo {
    INFO.get_or_init(detect::detect)
}

/// Which family of helper tools to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Wayland,
    X11,
    Windows,
    Macos,
}

pub fn backend() -> Backend {
    let i = info();
    match i.os {
        OsKind::Windows => Backend::Windows,
        OsKind::Macos => Backend::Macos,
        OsKind::Linux => match i.session_type {
            SessionType::Wayland => Backend::Wayland,
            // A headless/unknown Linux session still has the best chance with
            // the X11 tools, which work over XWayland too.
            _ => Backend::X11,
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub app: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub focused: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/* ── Dispatch ───────────────────────────────────────────────────── */

macro_rules! dispatch {
    ($fn_name:ident ( $($arg:expr),* )) => {
        match backend() {
            Backend::Wayland => wayland::$fn_name($($arg),*).await,
            Backend::X11 => x11::$fn_name($($arg),*).await,
            Backend::Windows => windows::$fn_name($($arg),*).await,
            Backend::Macos => macos::$fn_name($($arg),*).await,
        }
    };
}

/* screen */
pub async fn screenshot(region: Option<Region>) -> JResult<Vec<u8>> {
    dispatch!(screenshot(region))
}

/* mouse */
pub async fn move_mouse(x: i32, y: i32) -> JResult<()> {
    dispatch!(move_mouse(x, y))
}
pub async fn click(x: Option<i32>, y: Option<i32>, button: MouseButton) -> JResult<()> {
    dispatch!(click(x, y, button))
}
pub async fn double_click(x: Option<i32>, y: Option<i32>) -> JResult<()> {
    dispatch!(double_click(x, y))
}
pub async fn drag(x1: i32, y1: i32, x2: i32, y2: i32) -> JResult<()> {
    dispatch!(drag(x1, y1, x2, y2))
}
pub async fn scroll(dir: ScrollDirection, amount: u32) -> JResult<()> {
    dispatch!(scroll(dir, amount))
}
pub async fn mouse_position() -> JResult<Point> {
    dispatch!(mouse_position())
}

/* keyboard */
pub async fn type_text(text: &str) -> JResult<()> {
    dispatch!(type_text(text))
}
pub async fn press_key(combo: &str) -> JResult<()> {
    dispatch!(press_key(combo))
}
pub async fn hold_key(key: &str) -> JResult<()> {
    dispatch!(hold_key(key))
}
pub async fn release_key(key: &str) -> JResult<()> {
    dispatch!(release_key(key))
}

/* windows */
pub async fn list_windows() -> JResult<Vec<WindowInfo>> {
    dispatch!(list_windows())
}
pub async fn focus_window(target: &str) -> JResult<()> {
    dispatch!(focus_window(target))
}
pub async fn move_window(target: &str, x: i32, y: i32) -> JResult<()> {
    dispatch!(move_window(target, x, y))
}
pub async fn resize_window(target: &str, w: i32, h: i32) -> JResult<()> {
    dispatch!(resize_window(target, w, h))
}
pub async fn close_window(target: &str) -> JResult<()> {
    dispatch!(close_window(target))
}
pub async fn minimize_window(target: &str) -> JResult<()> {
    dispatch!(minimize_window(target))
}
pub async fn maximize_window(target: &str) -> JResult<()> {
    dispatch!(maximize_window(target))
}

pub async fn active_window() -> JResult<WindowInfo> {
    let windows = list_windows().await?;
    windows
        .into_iter()
        .find(|w| w.focused)
        .ok_or_else(|| AriaError::msg("no focused window"))
}

/// Resolve a user-supplied window reference — an exact id, or a case-insensitive
/// substring of the title or application name.
pub fn resolve_window<'a>(windows: &'a [WindowInfo], target: &str) -> Option<&'a WindowInfo> {
    let needle = target.to_lowercase();

    windows
        .iter()
        .find(|w| w.id == target)
        .or_else(|| windows.iter().find(|w| w.title.to_lowercase() == needle))
        .or_else(|| windows.iter().find(|w| w.app.to_lowercase() == needle))
        .or_else(|| {
            windows
                .iter()
                .find(|w| w.title.to_lowercase().contains(&needle))
        })
        .or_else(|| {
            windows
                .iter()
                .find(|w| w.app.to_lowercase().contains(&needle))
        })
}

/// Shared by every backend: turn `"ctrl+shift+s"` into its parts, normalising
/// the aliases users and LLMs actually type.
pub fn parse_combo(combo: &str) -> Vec<String> {
    combo
        .split(['+', '-'])
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .map(|p| {
            match p.as_str() {
                "control" | "ctlr" => "ctrl",
                "command" | "cmd" | "meta" | "win" | "super" => "super",
                "option" | "opt" => "alt",
                "esc" => "escape",
                "del" => "delete",
                "ins" => "insert",
                "pgup" => "prior",
                "pgdn" | "pagedown" => "next",
                "enter" => "return",
                "spacebar" | "space" => "space",
                other => other,
            }
            .to_string()
        })
        .collect()
}
