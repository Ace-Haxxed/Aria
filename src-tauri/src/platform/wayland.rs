//! Wayland backend — grim for capture, ydotool/wtype for input, and the
//! compositor's own IPC for window management.
//!
//! Wayland deliberately denies clients a global view of input and windows, so
//! unlike X11 there is no single tool that works everywhere. Hyprland and Sway
//! expose complete, documented IPC and are fully supported. GNOME and KDE gate
//! the equivalent APIs behind their shells, so those paths return an actionable
//! error rather than silently doing nothing.

use super::{parse_combo, resolve_window, MouseButton, Point, Region, ScrollDirection, WindowInfo};
use crate::platform::detect::Compositor as Comp;
use crate::util::{has, run, run_owned, JResult, NovaError};
use serde_json::Value;

fn compositor() -> Comp {
    super::info().compositor
}

fn need_ydotool() -> JResult<()> {
    if has("ydotool") {
        return Ok(());
    }
    Err(NovaError::missing(
        "ydotool",
        "Input control on Wayland needs ydotool, and its daemon must be running \
         (`systemctl --user enable --now ydotool` or `sudo systemctl enable --now ydotoold`).",
    ))
}

/* ── Screen ─────────────────────────────────────────────────────── */

/// Capture the screen, choosing a method that this compositor actually supports.
///
/// There is no single Wayland capture path. Each compositor family exposes a
/// different one, and picking the wrong one does not degrade — it fails
/// outright:
///
/// * wlroots (Hyprland, Sway) implement `wlr-screencopy`, which is what `grim`
///   speaks. It is the fastest option and needs no D-Bus round trip.
/// * GNOME implements neither `wlr-screencopy` (so `grim` reports "compositor
///   doesn't support the screen capture protocol") nor an open
///   `org.gnome.Shell.Screenshot` (restricted since GNOME 41, and it now denies
///   even `gnome-screenshot`). The portal is the supported route.
/// * KDE ships `spectacle`, and also has a portal backend.
///
/// So each family gets its native tool first and the portal as the fallback,
/// except GNOME where the portal *is* the native route.
pub async fn screenshot(region: Option<Region>) -> JResult<Vec<u8>> {
    let mut attempts: Vec<String> = Vec::new();

    let bytes = match compositor() {
        // The portal first: on GNOME 41+ it is the only thing that works, and
        // on older GNOME it works too. The Shell interface is kept behind it
        // for desktops whose portal backend is missing.
        Comp::Gnome => match try_portal(&mut attempts).await {
            Some(b) => b,
            None => match try_gnome_shell(&mut attempts).await {
                Some(b) => b,
                None => return Err(capture_failed(&attempts)),
            },
        },
        Comp::Kde => match try_tool("spectacle", region, &mut attempts).await {
            Some(b) => return finish(b, region, true),
            None => match try_portal(&mut attempts).await {
                Some(b) => b,
                None => return Err(capture_failed(&attempts)),
            },
        },
        // wlroots and anything else that might implement wlr-screencopy.
        _ => match try_tool("grim", region, &mut attempts).await {
            // grim applies the region itself, so it needs no crop.
            Some(b) => return Ok(b),
            None => match try_portal(&mut attempts).await {
                Some(b) => b,
                None => return Err(capture_failed(&attempts)),
            },
        },
    };

    finish(bytes, region, true)
}

/// Crop in-process when the capture method could not restrict the region itself.
fn finish(bytes: Vec<u8>, region: Option<Region>, needs_crop: bool) -> JResult<Vec<u8>> {
    match region {
        Some(r) if needs_crop => crate::commands::screen::crop_png(&bytes, r),
        _ => Ok(bytes),
    }
}

fn capture_failed(attempts: &[String]) -> NovaError {
    NovaError::msg(format!(
        "Screen capture failed on this Wayland session.\n{}\n\nInstall the portal \
         backend for your desktop (xdg-desktop-portal-gnome, xdg-desktop-portal-kde \
         or xdg-desktop-portal-wlr), or run an X11 session.",
        attempts
            .iter()
            .map(|a| format!("  • {a}"))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

async fn try_portal(attempts: &mut Vec<String>) -> Option<Vec<u8>> {
    match super::portal::screenshot().await {
        Ok(b) => Some(b),
        Err(e) => {
            attempts.push(format!("xdg-desktop-portal: {e}"));
            None
        }
    }
}

/// GNOME's own Shell interface. Works up to GNOME 40 and is denied after it,
/// so this is a fallback for old desktops rather than the main path.
async fn try_gnome_shell(attempts: &mut Vec<String>) -> Option<Vec<u8>> {
    if !has("gdbus") {
        attempts.push("gdbus is not installed".into());
        return None;
    }

    let path = crate::commands::screen::temp_capture_path();
    let path_str = path.to_string_lossy().to_string();

    let out = run(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.gnome.Shell.Screenshot",
            "--object-path",
            "/org/gnome/Shell/Screenshot",
            "--method",
            "org.gnome.Shell.Screenshot.Screenshot",
            "false", // include_cursor
            "false", // flash
            &path_str,
        ],
    )
    .await
    .ok()?;

    // The method answers `(true, '/path')` on success; a refusal is a D-Bus
    // error, and a `(false, …)` reply means it ran but captured nothing.
    if !out.ok() || !out.trimmed().starts_with("(true") {
        let detail = if out.stderr.trim().is_empty() {
            out.trimmed().to_string()
        } else {
            out.stderr.trim().to_string()
        };
        attempts.push(format!("org.gnome.Shell.Screenshot: {detail}"));
        let _ = std::fs::remove_file(&path);
        return None;
    }

    let bytes = std::fs::read(&path).ok();
    let _ = std::fs::remove_file(&path);
    match bytes {
        Some(b) => Some(b),
        None => {
            attempts.push("org.gnome.Shell.Screenshot wrote no file".into());
            None
        }
    }
}

/// Run a capture binary that writes a PNG to a path.
async fn try_tool(tool: &str, region: Option<Region>, attempts: &mut Vec<String>) -> Option<Vec<u8>> {
    if !has(tool) {
        attempts.push(format!("{tool} is not installed"));
        return None;
    }

    let path = crate::commands::screen::temp_capture_path();
    let path_str = path.to_string_lossy().to_string();

    let args: Vec<String> = match (tool, region) {
        ("grim", Some(r)) => vec![
            "-g".into(),
            format!("{},{} {}x{}", r.x, r.y, r.w, r.h),
            path_str.clone(),
        ],
        ("grim", None) => vec![path_str.clone()],
        // spectacle has no region flag that works unattended; the caller crops.
        ("spectacle", _) => vec!["-b".into(), "-n".into(), "-o".into(), path_str.clone()],
        _ => vec![path_str.clone()],
    };

    let out = run_owned(tool, &args).await.ok()?;
    if !path.exists() {
        let detail = if out.stderr.trim().is_empty() {
            format!("exit {}", out.exit_code)
        } else {
            out.stderr.trim().to_string()
        };
        attempts.push(format!("{tool}: {detail}"));
        return None;
    }

    let bytes = std::fs::read(&path).ok();
    let _ = std::fs::remove_file(&path);
    match bytes {
        Some(b) => Some(b),
        None => {
            attempts.push(format!("{tool} wrote an unreadable file"));
            None
        }
    }
}

/* ── Mouse ──────────────────────────────────────────────────────── */

pub async fn move_mouse(x: i32, y: i32) -> JResult<()> {
    need_ydotool()?;
    run(
        "ydotool",
        &[
            "mousemove",
            "--absolute",
            "-x",
            &x.to_string(),
            "-y",
            &y.to_string(),
        ],
    )
    .await?;
    Ok(())
}

/// ydotool click codes: low nibble selects the button, 0x40 presses and 0x80
/// releases — so 0xC0..0xC2 is a full click of left/right/middle.
fn click_code(b: MouseButton) -> &'static str {
    match b {
        MouseButton::Left => "0xC0",
        MouseButton::Right => "0xC1",
        MouseButton::Middle => "0xC2",
    }
}

pub async fn click(x: Option<i32>, y: Option<i32>, button: MouseButton) -> JResult<()> {
    need_ydotool()?;
    if let (Some(x), Some(y)) = (x, y) {
        move_mouse(x, y).await?;
    }
    run("ydotool", &["click", click_code(button)]).await?;
    Ok(())
}

pub async fn double_click(x: Option<i32>, y: Option<i32>) -> JResult<()> {
    need_ydotool()?;
    if let (Some(x), Some(y)) = (x, y) {
        move_mouse(x, y).await?;
    }
    run(
        "ydotool",
        &["click", "--repeat", "2", "--next-delay", "60", "0xC0"],
    )
    .await?;
    Ok(())
}

pub async fn drag(x1: i32, y1: i32, x2: i32, y2: i32) -> JResult<()> {
    need_ydotool()?;
    move_mouse(x1, y1).await?;
    run("ydotool", &["click", "0x40"]).await?; // left button down
    for i in 1..=10 {
        let x = x1 + (x2 - x1) * i / 10;
        let y = y1 + (y2 - y1) * i / 10;
        move_mouse(x, y).await?;
        tokio::time::sleep(std::time::Duration::from_millis(16)).await;
    }
    run("ydotool", &["click", "0x80"]).await?; // left button up
    Ok(())
}

pub async fn scroll(dir: ScrollDirection, amount: u32) -> JResult<()> {
    need_ydotool()?;
    let amount = amount.max(1) as i32;
    let (dx, dy) = match dir {
        ScrollDirection::Up => (0, -amount),
        ScrollDirection::Down => (0, amount),
        ScrollDirection::Left => (-amount, 0),
        ScrollDirection::Right => (amount, 0),
    };
    run(
        "ydotool",
        &[
            "mousemove",
            "--wheel",
            "-x",
            &dx.to_string(),
            "-y",
            &dy.to_string(),
        ],
    )
    .await?;
    Ok(())
}

pub async fn mouse_position() -> JResult<Point> {
    // Wayland has no protocol for "where is the pointer" — only the compositor
    // knows, and only Hyprland exposes it.
    if compositor() == Comp::Hyprland && has("hyprctl") {
        let out = run("hyprctl", &["cursorpos"]).await?;
        let t = out.trimmed();
        if let Some((x, y)) = t.split_once(',') {
            return Ok(Point {
                x: x.trim().parse().unwrap_or(0),
                y: y.trim().parse().unwrap_or(0),
            });
        }
    }
    Err(NovaError::msg(
        "Reading the cursor position is not possible on this Wayland compositor. \
         Hyprland is the only one that exposes it (via `hyprctl cursorpos`).",
    ))
}

/* ── Keyboard ───────────────────────────────────────────────────── */

pub async fn type_text(text: &str) -> JResult<()> {
    // wtype speaks the virtual-keyboard protocol directly and handles Unicode
    // properly; ydotool goes through uinput and is the fallback.
    if has("wtype") {
        let out = run("wtype", &[text]).await?;
        if out.ok() {
            return Ok(());
        }
    }
    need_ydotool()?;
    run("ydotool", &["type", "--key-delay", "12", text]).await?;
    Ok(())
}

/// Linux input-event codes (`linux/input-event-codes.h`) — what ydotool wants.
fn keycode(name: &str) -> Option<u16> {
    let code = match name {
        "escape" => 1,
        "1" => 2,
        "2" => 3,
        "3" => 4,
        "4" => 5,
        "5" => 6,
        "6" => 7,
        "7" => 8,
        "8" => 9,
        "9" => 10,
        "0" => 11,
        "minus" => 12,
        "equal" => 13,
        "backspace" => 14,
        "tab" => 15,
        "q" => 16,
        "w" => 17,
        "e" => 18,
        "r" => 19,
        "t" => 20,
        "y" => 21,
        "u" => 22,
        "i" => 23,
        "o" => 24,
        "p" => 25,
        "bracketleft" => 26,
        "bracketright" => 27,
        "return" => 28,
        "ctrl" => 29,
        "a" => 30,
        "s" => 31,
        "d" => 32,
        "f" => 33,
        "g" => 34,
        "h" => 35,
        "j" => 36,
        "k" => 37,
        "l" => 38,
        "semicolon" => 39,
        "apostrophe" => 40,
        "grave" => 41,
        "shift" => 42,
        "backslash" => 43,
        "z" => 44,
        "x" => 45,
        "c" => 46,
        "v" => 47,
        "b" => 48,
        "n" => 49,
        "m" => 50,
        "comma" => 51,
        "period" => 52,
        "slash" => 53,
        "alt" => 56,
        "space" => 57,
        "capslock" => 58,
        "f1" => 59,
        "f2" => 60,
        "f3" => 61,
        "f4" => 62,
        "f5" => 63,
        "f6" => 64,
        "f7" => 65,
        "f8" => 66,
        "f9" => 67,
        "f10" => 68,
        "f11" => 87,
        "f12" => 88,
        "home" => 102,
        "up" => 103,
        "prior" => 104,
        "left" => 105,
        "right" => 106,
        "end" => 107,
        "down" => 108,
        "next" => 109,
        "insert" => 110,
        "delete" => 111,
        "super" => 125,
        _ => return None,
    };
    Some(code)
}

/// xkb keysym names, for the wtype path.
fn keysym(name: &str) -> &str {
    match name {
        "return" => "Return",
        "escape" => "Escape",
        "tab" => "Tab",
        "space" => "space",
        "backspace" => "BackSpace",
        "delete" => "Delete",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "prior" => "Prior",
        "next" => "Next",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        other => other,
    }
}

pub async fn press_key(combo: &str) -> JResult<()> {
    let parts = parse_combo(combo);
    if parts.is_empty() {
        return Err(NovaError::msg("empty key combo"));
    }

    let (mods, keys): (Vec<String>, Vec<String>) = parts
        .iter()
        .cloned()
        .partition(|p| matches!(p.as_str(), "ctrl" | "alt" | "shift" | "super"));

    if has("wtype") {
        // wtype -M ctrl -M shift -k s -m shift -m ctrl
        let mut args: Vec<String> = Vec::new();
        for m in &mods {
            let m = if m == "super" { "logo" } else { m.as_str() };
            args.push("-M".into());
            args.push(m.to_string());
        }
        for k in &keys {
            args.push("-k".into());
            args.push(keysym(k).to_string());
        }
        for m in mods.iter().rev() {
            let m = if m == "super" { "logo" } else { m.as_str() };
            args.push("-m".into());
            args.push(m.to_string());
        }
        let out = run_owned("wtype", &args).await?;
        if out.ok() {
            return Ok(());
        }
    }

    // ydotool wants explicit press/release pairs: modifiers down, keys tapped,
    // then modifiers back up in reverse order.
    need_ydotool()?;
    let mut seq: Vec<String> = Vec::new();
    let mut down: Vec<u16> = Vec::new();

    for m in &mods {
        let c = keycode(m).ok_or_else(|| NovaError::msg(format!("unknown modifier `{m}`")))?;
        seq.push(format!("{c}:1"));
        down.push(c);
    }
    for k in &keys {
        let c = keycode(k).ok_or_else(|| NovaError::msg(format!("unknown key `{k}`")))?;
        seq.push(format!("{c}:1"));
        seq.push(format!("{c}:0"));
    }
    for c in down.iter().rev() {
        seq.push(format!("{c}:0"));
    }

    let mut args = vec!["key".to_string()];
    args.extend(seq);
    run_owned("ydotool", &args).await?;
    Ok(())
}

pub async fn hold_key(key: &str) -> JResult<()> {
    need_ydotool()?;
    let name = parse_combo(key).into_iter().next().unwrap_or_default();
    let c = keycode(&name).ok_or_else(|| NovaError::msg(format!("unknown key `{name}`")))?;
    run("ydotool", &["key", &format!("{c}:1")]).await?;
    Ok(())
}

pub async fn release_key(key: &str) -> JResult<()> {
    need_ydotool()?;
    let name = parse_combo(key).into_iter().next().unwrap_or_default();
    let c = keycode(&name).ok_or_else(|| NovaError::msg(format!("unknown key `{name}`")))?;
    run("ydotool", &["key", &format!("{c}:0")]).await?;
    Ok(())
}

/* ── Windows ────────────────────────────────────────────────────── */

pub async fn list_windows() -> JResult<Vec<WindowInfo>> {
    match compositor() {
        Comp::Hyprland => hyprland_windows().await,
        Comp::Sway => sway_windows().await,
        other => Err(unsupported(other)),
    }
}

fn unsupported(c: Comp) -> NovaError {
    match c {
        Comp::Gnome => NovaError::msg(
            "GNOME on Wayland does not expose window management to applications. \
             Install the 'Window Calls' GNOME extension, or use an X11 session, \
             to let NOVA manage windows.",
        ),
        Comp::Kde => NovaError::msg(
            "KDE on Wayland restricts window management to KWin scripts. \
             Use an X11 session for full window control.",
        ),
        _ => NovaError::msg(
            "Window management on this Wayland compositor is not supported. \
             Hyprland and Sway are fully supported; other compositors work on X11.",
        ),
    }
}

async fn hyprland_windows() -> JResult<Vec<WindowInfo>> {
    if !has("hyprctl") {
        return Err(NovaError::missing("hyprctl", "It ships with Hyprland."));
    }
    let clients = run("hyprctl", &["-j", "clients"]).await?;
    let active = run("hyprctl", &["-j", "activewindow"]).await.ok();
    let active_addr = active
        .and_then(|o| serde_json::from_str::<Value>(&o.stdout).ok())
        .and_then(|v| v.get("address").and_then(|a| a.as_str()).map(String::from))
        .unwrap_or_default();

    let parsed: Value = serde_json::from_str(&clients.stdout)
        .map_err(|e| NovaError::msg(format!("could not parse hyprctl output: {e}")))?;

    let mut out = Vec::new();
    for c in parsed.as_array().cloned().unwrap_or_default() {
        let addr = c["address"].as_str().unwrap_or_default().to_string();
        let at = c["at"].as_array().cloned().unwrap_or_default();
        let size = c["size"].as_array().cloned().unwrap_or_default();
        out.push(WindowInfo {
            focused: !addr.is_empty() && addr == active_addr,
            id: addr,
            title: c["title"].as_str().unwrap_or_default().to_string(),
            app: c["class"].as_str().unwrap_or_default().to_string(),
            x: at.first().and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            y: at.get(1).and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            w: size.first().and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            h: size.get(1).and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        });
    }
    Ok(out)
}

/// Walk the Sway tree, collecting leaf views.
fn sway_collect(node: &Value, focused_id: i64, out: &mut Vec<WindowInfo>) {
    let node_type = node["type"].as_str().unwrap_or("");
    let has_app =
        node.get("app_id").is_some_and(|v| !v.is_null()) || node.get("window_properties").is_some();

    if (node_type == "con" || node_type == "floating_con") && has_app {
        let rect = &node["rect"];
        let id = node["id"].as_i64().unwrap_or(0);
        let app = node["app_id"]
            .as_str()
            .map(String::from)
            .or_else(|| {
                node["window_properties"]["class"]
                    .as_str()
                    .map(String::from)
            })
            .unwrap_or_default();

        out.push(WindowInfo {
            id: id.to_string(),
            title: node["name"].as_str().unwrap_or_default().to_string(),
            app,
            x: rect["x"].as_i64().unwrap_or(0) as i32,
            y: rect["y"].as_i64().unwrap_or(0) as i32,
            w: rect["width"].as_i64().unwrap_or(0) as i32,
            h: rect["height"].as_i64().unwrap_or(0) as i32,
            focused: id == focused_id,
        });
    }

    for key in ["nodes", "floating_nodes"] {
        if let Some(children) = node[key].as_array() {
            for child in children {
                sway_collect(child, focused_id, out);
            }
        }
    }
}

async fn sway_windows() -> JResult<Vec<WindowInfo>> {
    if !has("swaymsg") {
        return Err(NovaError::missing("swaymsg", "It ships with Sway."));
    }
    let tree = run("swaymsg", &["-t", "get_tree", "-r"]).await?;
    let parsed: Value = serde_json::from_str(&tree.stdout)
        .map_err(|e| NovaError::msg(format!("could not parse swaymsg output: {e}")))?;

    // `get_tree` marks the focused node inline; find it first so the recursive
    // walk can tag the right window.
    let focused_id = find_focused(&parsed).unwrap_or(-1);
    let mut out = Vec::new();
    sway_collect(&parsed, focused_id, &mut out);
    Ok(out)
}

fn find_focused(node: &Value) -> Option<i64> {
    if node["focused"].as_bool() == Some(true) {
        return node["id"].as_i64();
    }
    for key in ["nodes", "floating_nodes"] {
        if let Some(children) = node[key].as_array() {
            for child in children {
                if let Some(id) = find_focused(child) {
                    return Some(id);
                }
            }
        }
    }
    None
}

async fn target_id(target: &str) -> JResult<String> {
    let windows = list_windows().await?;
    resolve_window(&windows, target)
        .map(|w| w.id.clone())
        .ok_or_else(|| NovaError::msg(format!("no window matching `{target}`")))
}

pub async fn focus_window(target: &str) -> JResult<()> {
    let id = target_id(target).await?;
    match compositor() {
        Comp::Hyprland => {
            run(
                "hyprctl",
                &["dispatch", "focuswindow", &format!("address:{id}")],
            )
            .await?;
        }
        Comp::Sway => {
            run("swaymsg", &[&format!("[con_id={id}] focus")]).await?;
        }
        other => return Err(unsupported(other)),
    }
    Ok(())
}

pub async fn move_window(target: &str, x: i32, y: i32) -> JResult<()> {
    let id = target_id(target).await?;
    match compositor() {
        Comp::Hyprland => {
            run(
                "hyprctl",
                &[
                    "dispatch",
                    "movewindowpixel",
                    &format!("exact {x} {y},address:{id}"),
                ],
            )
            .await?;
        }
        Comp::Sway => {
            run(
                "swaymsg",
                &[&format!("[con_id={id}] move absolute position {x} {y}")],
            )
            .await?;
        }
        other => return Err(unsupported(other)),
    }
    Ok(())
}

pub async fn resize_window(target: &str, w: i32, h: i32) -> JResult<()> {
    let id = target_id(target).await?;
    match compositor() {
        Comp::Hyprland => {
            run(
                "hyprctl",
                &[
                    "dispatch",
                    "resizewindowpixel",
                    &format!("exact {w} {h},address:{id}"),
                ],
            )
            .await?;
        }
        Comp::Sway => {
            run("swaymsg", &[&format!("[con_id={id}] resize set {w} {h}")]).await?;
        }
        other => return Err(unsupported(other)),
    }
    Ok(())
}

pub async fn close_window(target: &str) -> JResult<()> {
    let id = target_id(target).await?;
    match compositor() {
        Comp::Hyprland => {
            run(
                "hyprctl",
                &["dispatch", "closewindow", &format!("address:{id}")],
            )
            .await?;
        }
        Comp::Sway => {
            run("swaymsg", &[&format!("[con_id={id}] kill")]).await?;
        }
        other => return Err(unsupported(other)),
    }
    Ok(())
}

pub async fn minimize_window(target: &str) -> JResult<()> {
    let id = target_id(target).await?;
    match compositor() {
        // wlroots compositors have no "minimise"; moving to the special
        // scratchpad workspace is the established equivalent.
        Comp::Hyprland => {
            run(
                "hyprctl",
                &[
                    "dispatch",
                    "movetoworkspacesilent",
                    &format!("special,address:{id}"),
                ],
            )
            .await?;
        }
        Comp::Sway => {
            run("swaymsg", &[&format!("[con_id={id}] move scratchpad")]).await?;
        }
        other => return Err(unsupported(other)),
    }
    Ok(())
}

pub async fn maximize_window(target: &str) -> JResult<()> {
    let id = target_id(target).await?;
    match compositor() {
        Comp::Hyprland => {
            focus_window(&id).await?;
            run("hyprctl", &["dispatch", "fullscreen", "1"]).await?;
        }
        Comp::Sway => {
            run("swaymsg", &[&format!("[con_id={id}] fullscreen enable")]).await?;
        }
        other => return Err(unsupported(other)),
    }
    Ok(())
}
