//! macOS backend.
//!
//! Input goes through `enigo` (CGEvent). Capture uses the built-in
//! `screencapture`, and window management drives the Accessibility API through
//! System Events via `osascript` — the same API a native client would use,
//! reached over Apple's own scripting bridge.
//!
//! Window control requires the user to grant ARIA Accessibility permission
//! (System Settings → Privacy & Security → Accessibility). The setup wizard
//! checks for this and links straight to the pane.

use super::{input, resolve_window, MouseButton, Point, Region, ScrollDirection, WindowInfo};
use crate::util::{run, run_owned, JResult, AriaError};

async fn osascript(script: &str) -> JResult<String> {
    let out = run("osascript", &["-e", script]).await?;
    if !out.ok() {
        let stderr = out.stderr.trim();
        // -1743 is the Accessibility-permission denial; give the real fix.
        if stderr.contains("-1743") || stderr.contains("not allowed assistive") {
            return Err(AriaError::msg(
                "macOS denied Accessibility access. Grant it under System Settings → \
                 Privacy & Security → Accessibility, then restart ARIA.",
            ));
        }
        return Err(AriaError::msg(format!("osascript failed: {stderr}")));
    }
    Ok(out.stdout)
}

/* ── Screen ─────────────────────────────────────────────────────── */

pub async fn screenshot(region: Option<Region>) -> JResult<Vec<u8>> {
    let path = crate::commands::screen::temp_capture_path();
    let path_str = path.to_string_lossy().to_string();

    // -x suppresses the capture sound, -o drops the window shadow.
    let mut args: Vec<String> = vec!["-x".into(), "-o".into()];
    if let Some(r) = region {
        args.push("-R".into());
        args.push(format!("{},{},{},{}", r.x, r.y, r.w, r.h));
    }
    args.push(path_str);

    let out = run_owned("screencapture", &args).await?;
    if !out.ok() && !path.exists() {
        return Err(AriaError::msg(format!(
            "screencapture failed: {}",
            out.stderr.trim()
        )));
    }

    let bytes = std::fs::read(&path)?;
    let _ = std::fs::remove_file(&path);
    Ok(bytes)
}

/* ── Input (enigo) ──────────────────────────────────────────────── */

pub async fn move_mouse(x: i32, y: i32) -> JResult<()> {
    input::move_mouse(x, y)
}
pub async fn click(x: Option<i32>, y: Option<i32>, b: MouseButton) -> JResult<()> {
    input::click(x, y, b)
}
pub async fn double_click(x: Option<i32>, y: Option<i32>) -> JResult<()> {
    input::double_click(x, y)
}
pub async fn drag(x1: i32, y1: i32, x2: i32, y2: i32) -> JResult<()> {
    input::drag(x1, y1, x2, y2)
}
pub async fn scroll(dir: ScrollDirection, amount: u32) -> JResult<()> {
    input::scroll(dir, amount)
}
pub async fn mouse_position() -> JResult<Point> {
    input::mouse_position()
}
pub async fn type_text(text: &str) -> JResult<()> {
    input::type_text(text)
}
pub async fn press_key(combo: &str) -> JResult<()> {
    input::press_key(combo)
}
pub async fn hold_key(key: &str) -> JResult<()> {
    input::hold_key(key)
}
pub async fn release_key(key: &str) -> JResult<()> {
    input::release_key(key)
}

/* ── Windows ────────────────────────────────────────────────────── */

/// Emits one tab-separated record per window. AppleScript's JSON support is
/// non-existent, and tabs never appear in window titles in practice.
const LIST_SCRIPT: &str = r#"
set output to ""
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  repeat with proc in (application processes where visible is true)
    set procName to name of proc
    try
      repeat with win in (windows of proc)
        try
          set p to position of win
          set s to size of win
          set output to output & procName & tab & (name of win) & tab & ¬
            (item 1 of p) & tab & (item 2 of p) & tab & ¬
            (item 1 of s) & tab & (item 2 of s) & tab & ¬
            (procName is equal to frontApp) & linefeed
        end try
      end repeat
    end try
  end repeat
end tell
return output
"#;

pub async fn list_windows() -> JResult<Vec<WindowInfo>> {
    let out = osascript(LIST_SCRIPT).await?;
    let mut windows = Vec::new();

    for (i, line) in out.lines().enumerate() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 7 {
            continue;
        }
        windows.push(WindowInfo {
            // System Events has no stable window handle, so index the list.
            id: i.to_string(),
            app: f[0].to_string(),
            title: f[1].to_string(),
            x: f[2].trim().parse().unwrap_or(0),
            y: f[3].trim().parse().unwrap_or(0),
            w: f[4].trim().parse().unwrap_or(0),
            h: f[5].trim().parse().unwrap_or(0),
            focused: f[6].trim() == "true",
        });
    }
    Ok(windows)
}

/// Resolve a fuzzy target to the (app name, window title) pair AppleScript needs.
async fn target_window(target: &str) -> JResult<(String, String)> {
    let windows = list_windows().await?;
    resolve_window(&windows, target)
        .map(|w| (w.app.clone(), w.title.clone()))
        .ok_or_else(|| AriaError::msg(format!("no window matching `{target}`")))
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Run `body` against the window, with `win` bound to it.
async fn with_window(target: &str, body: &str) -> JResult<()> {
    let (app, title) = target_window(target).await?;
    let script = format!(
        r#"tell application "System Events"
  tell process "{}"
    set win to (first window whose name is "{}")
    {body}
  end tell
end tell"#,
        escape(&app),
        escape(&title)
    );
    osascript(&script).await?;
    Ok(())
}

pub async fn focus_window(target: &str) -> JResult<()> {
    let (app, title) = target_window(target).await?;
    let script = format!(
        r#"tell application "System Events"
  set frontmost of process "{}" to true
  tell process "{}"
    perform action "AXRaise" of (first window whose name is "{}")
  end tell
end tell"#,
        escape(&app),
        escape(&app),
        escape(&title)
    );
    osascript(&script).await?;
    Ok(())
}

pub async fn move_window(target: &str, x: i32, y: i32) -> JResult<()> {
    with_window(target, &format!("set position of win to {{{x}, {y}}}")).await
}

pub async fn resize_window(target: &str, w: i32, h: i32) -> JResult<()> {
    with_window(target, &format!("set size of win to {{{w}, {h}}}")).await
}

pub async fn close_window(target: &str) -> JResult<()> {
    with_window(
        target,
        r#"click (first button of win whose subrole is "AXCloseButton")"#,
    )
    .await
}

pub async fn minimize_window(target: &str) -> JResult<()> {
    with_window(
        target,
        "set value of attribute \"AXMinimized\" of win to true",
    )
    .await
}

pub async fn maximize_window(target: &str) -> JResult<()> {
    // "Zoom" is the macOS equivalent of maximise; full-screen is a different mode.
    with_window(
        target,
        r#"click (first button of win whose subrole is "AXZoomButton")"#,
    )
    .await
}
