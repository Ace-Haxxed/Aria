//! X11 backend.
//!
//! Input goes through `enigo` (XTest) first, which needs no external binary
//! and no process per event; `xdotool` is the fallback when XTest is
//! unavailable. Capture uses scrot/maim, windows use wmctrl.

use super::{parse_combo, resolve_window, MouseButton, Point, Region, ScrollDirection, WindowInfo};
use crate::util::{first_available, has, run, run_owned, JResult, AriaError};

fn require(tool: &str, purpose: &str) -> JResult<()> {
    if has(tool) {
        Ok(())
    } else {
        Err(AriaError::missing(
            tool,
            &format!("{purpose} needs it. Install with your package manager (e.g. `sudo pacman -S {tool}` / `sudo apt install {tool}`)."),
        ))
    }
}

/* ── Screen ─────────────────────────────────────────────────────── */

pub async fn screenshot(region: Option<Region>) -> JResult<Vec<u8>> {
    let path = crate::commands::screen::temp_capture_path();
    let path_str = path.to_string_lossy().to_string();

    // Capture straight to a file rather than stdout: PNG bytes do not survive
    // the lossy UTF-8 conversion the generic command runner applies.
    let tool = first_available(&["scrot", "maim", "gnome-screenshot", "spectacle", "import"])
        .ok_or_else(|| {
            AriaError::missing(
                "scrot",
                "Screen capture on X11 needs one of: scrot, maim, gnome-screenshot, spectacle.",
            )
        })?;

    let args: Vec<String> = match (tool.as_str(), region) {
        ("scrot", Some(r)) => vec![
            "-o".into(),
            "-a".into(),
            format!("{},{},{},{}", r.x, r.y, r.w, r.h),
            path_str.clone(),
        ],
        ("scrot", None) => vec!["-o".into(), path_str.clone()],
        ("maim", Some(r)) => vec![
            "-g".into(),
            format!("{}x{}+{}+{}", r.w, r.h, r.x, r.y),
            path_str.clone(),
        ],
        ("maim", None) => vec![path_str.clone()],
        ("gnome-screenshot", _) => vec!["-f".into(), path_str.clone()],
        ("spectacle", _) => vec!["-b".into(), "-n".into(), "-o".into(), path_str.clone()],
        ("import", Some(r)) => vec![
            "-window".into(),
            "root".into(),
            "-crop".into(),
            format!("{}x{}+{}+{}", r.w, r.h, r.x, r.y),
            path_str.clone(),
        ],
        ("import", None) => vec!["-window".into(), "root".into(), path_str.clone()],
        _ => vec![path_str.clone()],
    };

    let out = run_owned(&tool, &args).await?;
    if !out.ok() && !path.exists() {
        return Err(AriaError::msg(format!(
            "{tool} failed: {}",
            out.stderr.trim()
        )));
    }

    let bytes = std::fs::read(&path)?;
    let _ = std::fs::remove_file(&path);

    // gnome-screenshot and spectacle ignore our region flag, so crop here.
    if let Some(r) = region {
        if tool == "gnome-screenshot" || tool == "spectacle" {
            return crate::commands::screen::crop_png(&bytes, r);
        }
    }
    Ok(bytes)
}

/* ── Mouse ──────────────────────────────────────────────────────── */

pub async fn move_mouse(x: i32, y: i32) -> JResult<()> {
    if super::input::move_mouse(x, y).is_ok() {
        return Ok(());
    }
    require("xdotool", "Mouse control on X11")?;
    run("xdotool", &["mousemove", &x.to_string(), &y.to_string()]).await?;
    Ok(())
}

fn button_code(b: MouseButton) -> &'static str {
    match b {
        MouseButton::Left => "1",
        MouseButton::Middle => "2",
        MouseButton::Right => "3",
    }
}

pub async fn click(x: Option<i32>, y: Option<i32>, button: MouseButton) -> JResult<()> {
    if super::input::click(x, y, button).is_ok() {
        return Ok(());
    }
    require("xdotool", "Mouse control on X11")?;
    if let (Some(x), Some(y)) = (x, y) {
        move_mouse(x, y).await?;
    }
    run("xdotool", &["click", button_code(button)]).await?;
    Ok(())
}

pub async fn double_click(x: Option<i32>, y: Option<i32>) -> JResult<()> {
    require("xdotool", "Mouse control on X11")?;
    if let (Some(x), Some(y)) = (x, y) {
        move_mouse(x, y).await?;
    }
    run("xdotool", &["click", "--repeat", "2", "--delay", "60", "1"]).await?;
    Ok(())
}

pub async fn drag(x1: i32, y1: i32, x2: i32, y2: i32) -> JResult<()> {
    require("xdotool", "Mouse control on X11")?;
    move_mouse(x1, y1).await?;
    run("xdotool", &["mousedown", "1"]).await?;
    // Move in steps: apps that track drag events ignore a single teleport.
    for i in 1..=10 {
        let x = x1 + (x2 - x1) * i / 10;
        let y = y1 + (y2 - y1) * i / 10;
        move_mouse(x, y).await?;
        tokio::time::sleep(std::time::Duration::from_millis(16)).await;
    }
    run("xdotool", &["mouseup", "1"]).await?;
    Ok(())
}

pub async fn scroll(dir: ScrollDirection, amount: u32) -> JResult<()> {
    if super::input::scroll(dir, amount).is_ok() {
        return Ok(());
    }
    require("xdotool", "Mouse control on X11")?;
    let btn = match dir {
        ScrollDirection::Up => "4",
        ScrollDirection::Down => "5",
        ScrollDirection::Left => "6",
        ScrollDirection::Right => "7",
    };
    run(
        "xdotool",
        &[
            "click",
            "--repeat",
            &amount.max(1).to_string(),
            "--delay",
            "12",
            btn,
        ],
    )
    .await?;
    Ok(())
}

pub async fn mouse_position() -> JResult<Point> {
    require("xdotool", "Mouse control on X11")?;
    let out = run("xdotool", &["getmouselocation", "--shell"]).await?;
    let mut p = Point { x: 0, y: 0 };
    for line in out.stdout.lines() {
        if let Some(v) = line.strip_prefix("X=") {
            p.x = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("Y=") {
            p.y = v.trim().parse().unwrap_or(0);
        }
    }
    Ok(p)
}

/* ── Keyboard ───────────────────────────────────────────────────── */

pub async fn type_text(text: &str) -> JResult<()> {
    if super::input::type_text(text).is_ok() {
        return Ok(());
    }
    require("xdotool", "Keyboard control on X11")?;
    run(
        "xdotool",
        &["type", "--clearmodifiers", "--delay", "12", text],
    )
    .await?;
    Ok(())
}

/// Map our normalised key names onto X keysyms.
fn keysym(name: &str) -> String {
    match name {
        "ctrl" => "ctrl",
        "alt" => "alt",
        "shift" => "shift",
        "super" => "super",
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
        other => return other.to_string(),
    }
    .to_string()
}

pub async fn press_key(combo: &str) -> JResult<()> {
    if super::input::press_key(combo).is_ok() {
        return Ok(());
    }
    require("xdotool", "Keyboard control on X11")?;
    let keys: Vec<String> = parse_combo(combo).iter().map(|k| keysym(k)).collect();
    let arg = keys.join("+");
    run("xdotool", &["key", "--clearmodifiers", &arg]).await?;
    Ok(())
}

pub async fn hold_key(key: &str) -> JResult<()> {
    require("xdotool", "Keyboard control on X11")?;
    run("xdotool", &["keydown", &keysym(&parse_combo(key).join(""))]).await?;
    Ok(())
}

pub async fn release_key(key: &str) -> JResult<()> {
    require("xdotool", "Keyboard control on X11")?;
    run("xdotool", &["keyup", &keysym(&parse_combo(key).join(""))]).await?;
    Ok(())
}

/* ── Windows ────────────────────────────────────────────────────── */

pub async fn list_windows() -> JResult<Vec<WindowInfo>> {
    if !has("wmctrl") && !has("xdotool") {
        return Err(AriaError::missing(
            "wmctrl",
            "Window management on X11 needs wmctrl (or xdotool).",
        ));
    }

    let active = if has("xdotool") {
        run("xdotool", &["getactivewindow"])
            .await
            .ok()
            .map(|o| o.trimmed().to_string())
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse::<u64>().ok())
    } else {
        None
    };

    if has("wmctrl") {
        // `-lGpx` → id, desktop, pid, x, y, w, h, wm_class, host, title
        let out = run("wmctrl", &["-lGpx"]).await?;
        let mut windows = Vec::new();

        for line in out.stdout.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 9 {
                continue;
            }
            let id_hex = parts[0];
            let id_num = u64::from_str_radix(id_hex.trim_start_matches("0x"), 16).ok();

            // The window class is `instance.Class`; the human-facing app name is
            // the part after the final dot.
            let app = parts[7].rsplit('.').next().unwrap_or(parts[7]).to_string();
            let title = parts[9..].join(" ");

            windows.push(WindowInfo {
                id: id_hex.to_string(),
                title,
                app,
                x: parts[3].parse().unwrap_or(0),
                y: parts[4].parse().unwrap_or(0),
                w: parts[5].parse().unwrap_or(0),
                h: parts[6].parse().unwrap_or(0),
                focused: match (id_num, active) {
                    (Some(a), Some(b)) => a == b,
                    _ => false,
                },
            });
        }
        return Ok(windows);
    }

    // xdotool-only fallback.
    let out = run("xdotool", &["search", "--onlyvisible", "--name", ".+"]).await?;
    let mut windows = Vec::new();
    for id in out.stdout.split_whitespace() {
        let Ok(name) = run("xdotool", &["getwindowname", id]).await else {
            continue;
        };
        let geom = run("xdotool", &["getwindowgeometry", "--shell", id]).await?;
        let (mut x, mut y, mut w, mut h) = (0, 0, 0, 0);
        for line in geom.stdout.lines() {
            let Some((k, v)) = line.split_once('=') else {
                continue;
            };
            let v: i32 = v.trim().parse().unwrap_or(0);
            match k {
                "X" => x = v,
                "Y" => y = v,
                "WIDTH" => w = v,
                "HEIGHT" => h = v,
                _ => {}
            }
        }
        windows.push(WindowInfo {
            id: id.to_string(),
            title: name.trimmed().to_string(),
            app: String::new(),
            x,
            y,
            w,
            h,
            focused: id.parse::<u64>().ok() == active,
        });
    }
    Ok(windows)
}

/// Turn a fuzzy target into a concrete window id.
async fn target_id(target: &str) -> JResult<String> {
    let windows = list_windows().await?;
    resolve_window(&windows, target)
        .map(|w| w.id.clone())
        .ok_or_else(|| AriaError::msg(format!("no window matching `{target}`")))
}

pub async fn focus_window(target: &str) -> JResult<()> {
    let id = target_id(target).await?;
    if has("wmctrl") {
        run("wmctrl", &["-i", "-a", &id]).await?;
    } else {
        run("xdotool", &["windowactivate", &id]).await?;
    }
    Ok(())
}

pub async fn move_window(target: &str, x: i32, y: i32) -> JResult<()> {
    let id = target_id(target).await?;
    if has("wmctrl") {
        run(
            "wmctrl",
            &["-i", "-r", &id, "-e", &format!("0,{x},{y},-1,-1")],
        )
        .await?;
    } else {
        run(
            "xdotool",
            &["windowmove", &id, &x.to_string(), &y.to_string()],
        )
        .await?;
    }
    Ok(())
}

pub async fn resize_window(target: &str, w: i32, h: i32) -> JResult<()> {
    let id = target_id(target).await?;
    if has("wmctrl") {
        run(
            "wmctrl",
            &["-i", "-r", &id, "-e", &format!("0,-1,-1,{w},{h}")],
        )
        .await?;
    } else {
        run(
            "xdotool",
            &["windowsize", &id, &w.to_string(), &h.to_string()],
        )
        .await?;
    }
    Ok(())
}

pub async fn close_window(target: &str) -> JResult<()> {
    let id = target_id(target).await?;
    if has("wmctrl") {
        run("wmctrl", &["-i", "-c", &id]).await?;
    } else {
        run("xdotool", &["windowclose", &id]).await?;
    }
    Ok(())
}

pub async fn minimize_window(target: &str) -> JResult<()> {
    let id = target_id(target).await?;
    require("xdotool", "Minimising windows on X11")?;
    run("xdotool", &["windowminimize", &id]).await?;
    Ok(())
}

pub async fn maximize_window(target: &str) -> JResult<()> {
    let id = target_id(target).await?;
    require("wmctrl", "Maximising windows on X11")?;
    run(
        "wmctrl",
        &["-i", "-r", &id, "-b", "add,maximized_vert,maximized_horz"],
    )
    .await?;
    Ok(())
}
