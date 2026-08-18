//! Input synthesis for Windows and macOS.
//!
//! `enigo` wraps the exact APIs the platforms expect — `SendInput` on Windows
//! and `CGEvent` on macOS — so this stays free of hand-written `unsafe` FFI
//! while producing genuine OS-level input events.

use super::{parse_combo, MouseButton, Point, ScrollDirection};
use crate::util::{JResult, AriaError};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard as _, Mouse as _, Settings};

fn enigo() -> JResult<Enigo> {
    Enigo::new(&Settings::default())
        .map_err(|e| AriaError::msg(format!("could not open an input device: {e}")))
}

fn err(e: impl std::fmt::Display) -> AriaError {
    AriaError::msg(format!("input event failed: {e}"))
}

fn button(b: MouseButton) -> Button {
    match b {
        MouseButton::Left => Button::Left,
        MouseButton::Right => Button::Right,
        MouseButton::Middle => Button::Middle,
    }
}

pub fn move_mouse(x: i32, y: i32) -> JResult<()> {
    enigo()?.move_mouse(x, y, Coordinate::Abs).map_err(err)
}

pub fn click(x: Option<i32>, y: Option<i32>, b: MouseButton) -> JResult<()> {
    let mut e = enigo()?;
    if let (Some(x), Some(y)) = (x, y) {
        e.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
    }
    e.button(button(b), Direction::Click).map_err(err)
}

pub fn double_click(x: Option<i32>, y: Option<i32>) -> JResult<()> {
    let mut e = enigo()?;
    if let (Some(x), Some(y)) = (x, y) {
        e.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
    }
    e.button(Button::Left, Direction::Click).map_err(err)?;
    std::thread::sleep(std::time::Duration::from_millis(60));
    e.button(Button::Left, Direction::Click).map_err(err)
}

pub fn drag(x1: i32, y1: i32, x2: i32, y2: i32) -> JResult<()> {
    let mut e = enigo()?;
    e.move_mouse(x1, y1, Coordinate::Abs).map_err(err)?;
    e.button(Button::Left, Direction::Press).map_err(err)?;
    // Interpolate: a single jump reads as a teleport and most apps drop the drag.
    for i in 1..=10 {
        let x = x1 + (x2 - x1) * i / 10;
        let y = y1 + (y2 - y1) * i / 10;
        e.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    e.button(Button::Left, Direction::Release).map_err(err)
}

pub fn scroll(dir: ScrollDirection, amount: u32) -> JResult<()> {
    let mut e = enigo()?;
    let n = amount.max(1) as i32;
    match dir {
        ScrollDirection::Up => e.scroll(-n, Axis::Vertical),
        ScrollDirection::Down => e.scroll(n, Axis::Vertical),
        ScrollDirection::Left => e.scroll(-n, Axis::Horizontal),
        ScrollDirection::Right => e.scroll(n, Axis::Horizontal),
    }
    .map_err(err)
}

pub fn mouse_position() -> JResult<Point> {
    let (x, y) = enigo()?.location().map_err(err)?;
    Ok(Point { x, y })
}

pub fn type_text(text: &str) -> JResult<()> {
    enigo()?.text(text).map_err(err)
}

fn key(name: &str) -> JResult<Key> {
    let k = match name {
        "ctrl" => Key::Control,
        "alt" => Key::Alt,
        "shift" => Key::Shift,
        "super" => Key::Meta,
        "return" => Key::Return,
        "escape" => Key::Escape,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" => Key::Delete,
        "home" => Key::Home,
        "end" => Key::End,
        "prior" => Key::PageUp,
        "next" => Key::PageDown,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        other => {
            let mut chars = other.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Key::Unicode(c),
                _ => return Err(AriaError::msg(format!("unknown key `{other}`"))),
            }
        }
    };
    Ok(k)
}

pub fn press_key(combo: &str) -> JResult<()> {
    let parts = parse_combo(combo);
    if parts.is_empty() {
        return Err(AriaError::msg("empty key combo"));
    }
    let (mods, keys): (Vec<String>, Vec<String>) = parts
        .iter()
        .cloned()
        .partition(|p| matches!(p.as_str(), "ctrl" | "alt" | "shift" | "super"));

    let mut e = enigo()?;
    for m in &mods {
        e.key(key(m)?, Direction::Press).map_err(err)?;
    }
    for k in &keys {
        e.key(key(k)?, Direction::Click).map_err(err)?;
    }
    // Release in reverse so nested modifiers unwind cleanly.
    for m in mods.iter().rev() {
        e.key(key(m)?, Direction::Release).map_err(err)?;
    }
    Ok(())
}

pub fn hold_key(name: &str) -> JResult<()> {
    let n = parse_combo(name).into_iter().next().unwrap_or_default();
    enigo()?.key(key(&n)?, Direction::Press).map_err(err)
}

pub fn release_key(name: &str) -> JResult<()> {
    let n = parse_combo(name).into_iter().next().unwrap_or_default();
    enigo()?.key(key(&n)?, Direction::Release).map_err(err)
}
