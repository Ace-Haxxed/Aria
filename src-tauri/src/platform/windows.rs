//! Windows backend.
//!
//! Input goes through `enigo` (SendInput). Screen capture and window
//! management go through a small PowerShell helper that P/Invokes the same
//! user32/System.Drawing APIs a native implementation would call, which keeps
//! the Rust side free of `unsafe` and identical across build targets.

use super::{input, resolve_window, MouseButton, Point, Region, ScrollDirection, WindowInfo};
use crate::util::{run_owned, JResult, AriaError};
use serde_json::Value;

/// Run a PowerShell script from a temp file — passing multi-line scripts with
/// here-strings through `-Command` is quoting-fragile, `-File` is not.
async fn powershell(script: &str) -> JResult<String> {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("jarvis-ps-{}.ps1", std::process::id()));
    std::fs::write(&path, script)?;

    let out = run_owned(
        "powershell",
        &[
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            path.to_string_lossy().to_string(),
        ],
    )
    .await;

    let _ = std::fs::remove_file(&path);
    let out = out?;
    if !out.ok() {
        return Err(AriaError::msg(format!(
            "PowerShell failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(out.stdout)
}

/* ── Screen ─────────────────────────────────────────────────────── */

pub async fn screenshot(region: Option<Region>) -> JResult<Vec<u8>> {
    let path = crate::commands::screen::temp_capture_path();
    let p = path.to_string_lossy().replace('\'', "''");

    let bounds = match region {
        Some(r) => format!(
            "New-Object Drawing.Rectangle({}, {}, {}, {})",
            r.x, r.y, r.w, r.h
        ),
        None => "[Windows.Forms.SystemInformation]::VirtualScreen".to_string(),
    };

    let script = format!(
        r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = {bounds}
$bmp = New-Object Drawing.Bitmap($b.Width, $b.Height)
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save('{p}', [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
"#
    );

    powershell(&script).await?;
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

/// P/Invoke surface shared by every window operation below.
const USER32: &str = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ARIAWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
"#;

pub async fn list_windows() -> JResult<Vec<WindowInfo>> {
    let script = format!(
        r#"{USER32}
$fg = [ARIAWin]::GetForegroundWindow()
$list = @()
Get-Process | Where-Object {{ $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' }} | ForEach-Object {{
  $r = New-Object ARIAWin+RECT
  [void][ARIAWin]::GetWindowRect($_.MainWindowHandle, [ref]$r)
  $list += [PSCustomObject]@{{
    id = $_.MainWindowHandle.ToString()
    title = $_.MainWindowTitle
    app = $_.ProcessName
    x = $r.Left
    y = $r.Top
    w = ($r.Right - $r.Left)
    h = ($r.Bottom - $r.Top)
    focused = ($_.MainWindowHandle -eq $fg)
  }}
}}
ConvertTo-Json -InputObject @($list) -Compress
"#
    );

    let out = powershell(&script).await?;
    let parsed: Value = serde_json::from_str(out.trim())
        .map_err(|e| AriaError::msg(format!("could not parse window list: {e}")))?;

    let mut windows = Vec::new();
    for w in parsed.as_array().cloned().unwrap_or_default() {
        windows.push(WindowInfo {
            id: w["id"].as_str().unwrap_or_default().to_string(),
            title: w["title"].as_str().unwrap_or_default().to_string(),
            app: w["app"].as_str().unwrap_or_default().to_string(),
            x: w["x"].as_i64().unwrap_or(0) as i32,
            y: w["y"].as_i64().unwrap_or(0) as i32,
            w: w["w"].as_i64().unwrap_or(0) as i32,
            h: w["h"].as_i64().unwrap_or(0) as i32,
            focused: w["focused"].as_bool().unwrap_or(false),
        });
    }
    Ok(windows)
}

async fn target_handle(target: &str) -> JResult<String> {
    let windows = list_windows().await?;
    resolve_window(&windows, target)
        .map(|w| w.id.clone())
        .ok_or_else(|| AriaError::msg(format!("no window matching `{target}`")))
}

pub async fn focus_window(target: &str) -> JResult<()> {
    let h = target_handle(target).await?;
    powershell(&format!(
        "{USER32}\n[void][ARIAWin]::ShowWindow([IntPtr]{h}, 9)\n[void][ARIAWin]::SetForegroundWindow([IntPtr]{h})"
    ))
    .await?;
    Ok(())
}

pub async fn move_window(target: &str, x: i32, y: i32) -> JResult<()> {
    let h = target_handle(target).await?;
    let windows = list_windows().await?;
    let cur =
        resolve_window(&windows, target).ok_or_else(|| AriaError::msg("window disappeared"))?;
    powershell(&format!(
        "{USER32}\n[void][ARIAWin]::MoveWindow([IntPtr]{h}, {x}, {y}, {}, {}, $true)",
        cur.w, cur.h
    ))
    .await?;
    Ok(())
}

pub async fn resize_window(target: &str, w: i32, h: i32) -> JResult<()> {
    let handle = target_handle(target).await?;
    let windows = list_windows().await?;
    let cur =
        resolve_window(&windows, target).ok_or_else(|| AriaError::msg("window disappeared"))?;
    powershell(&format!(
        "{USER32}\n[void][ARIAWin]::MoveWindow([IntPtr]{handle}, {}, {}, {w}, {h}, $true)",
        cur.x, cur.y
    ))
    .await?;
    Ok(())
}

pub async fn close_window(target: &str) -> JResult<()> {
    let h = target_handle(target).await?;
    // WM_CLOSE (0x0010) — lets the app run its own save/confirm logic.
    powershell(&format!(
        "{USER32}\n[void][ARIAWin]::PostMessage([IntPtr]{h}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)"
    ))
    .await?;
    Ok(())
}

pub async fn minimize_window(target: &str) -> JResult<()> {
    let h = target_handle(target).await?;
    // SW_MINIMIZE = 6
    powershell(&format!(
        "{USER32}\n[void][ARIAWin]::ShowWindow([IntPtr]{h}, 6)"
    ))
    .await?;
    Ok(())
}

pub async fn maximize_window(target: &str) -> JResult<()> {
    let h = target_handle(target).await?;
    // SW_MAXIMIZE = 3
    powershell(&format!(
        "{USER32}\n[void][ARIAWin]::ShowWindow([IntPtr]{h}, 3)"
    ))
    .await?;
    Ok(())
}
