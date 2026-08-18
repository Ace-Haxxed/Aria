//! The tray icon, and what it says about what ARIA is doing.
//!
//! When the window is hidden the tray is the only thing the user can see, so
//! it carries the same state the orb does: whether ARIA is listening, busy,
//! or waiting. Listening pulses, because "the microphone is open" is the one
//! state a user is entitled to notice without looking for it.
//!
//! Icons are drawn by `build.rs` and compiled in, so there is no directory of
//! images to lose and nothing to load at runtime.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::{AppHandle, Manager};

/// Icons generated at build time, embedded in the binary.
macro_rules! icon {
    ($name:literal) => {
        include_bytes!(concat!(env!("OUT_DIR"), "/tray-icons/", $name, ".png"))
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrayState {
    Idle,
    /// The wake word listener is running. Pulses.
    Listening,
    /// A reply is being generated. Pulses faster.
    Thinking,
    Speaking,
    Acting,
}

impl TrayState {
    /// The two frames for this state: full, then dimmed.
    fn frames(self) -> (&'static [u8], &'static [u8]) {
        match self {
            TrayState::Idle => (icon!("idle"), icon!("idle-dim")),
            TrayState::Listening => (icon!("listening"), icon!("listening-dim")),
            TrayState::Thinking => (icon!("thinking"), icon!("thinking-dim")),
            TrayState::Speaking => (icon!("speaking"), icon!("speaking-dim")),
            TrayState::Acting => (icon!("acting"), icon!("acting-dim")),
        }
    }

    /// How fast to alternate frames, or `None` to sit still.
    ///
    /// Idle does not animate: a tray icon that moves forever is an irritation,
    /// and the whole point of the pulse is that it means something.
    fn pulse_interval(self) -> Option<Duration> {
        match self {
            TrayState::Idle => None,
            // Slow and shallow — presence, not an alarm.
            TrayState::Listening => Some(Duration::from_millis(900)),
            // Faster, reading as activity rather than attention.
            TrayState::Thinking | TrayState::Acting => Some(Duration::from_millis(450)),
            TrayState::Speaking => Some(Duration::from_millis(600)),
        }
    }

    fn tooltip(self) -> &'static str {
        match self {
            TrayState::Idle => "ARIA",
            TrayState::Listening => "ARIA — listening for the wake word",
            TrayState::Thinking => "ARIA — thinking",
            TrayState::Speaking => "ARIA — speaking",
            TrayState::Acting => "ARIA — working",
        }
    }
}

static CURRENT: Mutex<TrayState> = Mutex::new(TrayState::Idle);
/// Whether the animation thread is already running.
static ANIMATING: AtomicBool = AtomicBool::new(false);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn apply(app: &AppHandle, bytes: &[u8], tooltip: Option<&str>) {
    let Some(tray) = app.tray_by_id("aria-tray") else {
        return;
    };
    if let Ok(image) = Image::from_bytes(bytes) {
        let _ = tray.set_icon(Some(image));
    }
    if let Some(text) = tooltip {
        let _ = tray.set_tooltip(Some(text));
    }
}

/// Set the tray state. Starts or stops the pulse as needed.
pub fn set_state(app: &AppHandle, state: TrayState) {
    {
        let mut current = lock(&CURRENT);
        if *current == state {
            return;
        }
        *current = state;
    }

    let (full, _) = state.frames();
    apply(app, full, Some(state.tooltip()));

    if state.pulse_interval().is_some() {
        start_pulse(app.clone());
    }
}

/// Whether animating the tray icon is safe on this platform.
///
/// On Linux the tray goes through libappindicator, and every `set_icon` on a
/// tray whose widget is not realised prints
/// `gtk_widget_get_scale_factor: assertion 'GTK_IS_WIDGET (widget)' failed`.
/// One warning per state change is tolerable; a pulse emits one every few
/// hundred milliseconds for as long as ARIA is busy, which floods the terminal
/// of anyone who launched it with `aria` and buries real output.
///
/// The per-state icon still updates — only the animation is dropped — so the
/// tray remains informative. Set `ARIA_TRAY_PULSE=1` to force it back on.
fn pulse_supported() -> bool {
    if cfg!(not(target_os = "linux")) {
        return true;
    }
    std::env::var_os("ARIA_TRAY_PULSE").is_some()
}

/// Alternate frames for as long as the current state animates.
///
/// One thread serves every state: it reads the current state each tick rather
/// than being restarted, so rapid state changes cannot leave several threads
/// fighting over the icon.
fn start_pulse(app: AppHandle) {
    if !pulse_supported() {
        return;
    }
    if ANIMATING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::Builder::new()
        .name("aria-tray-pulse".into())
        .spawn(move || {
            let mut bright = true;
            loop {
                let state = *lock(&CURRENT);
                let Some(interval) = state.pulse_interval() else {
                    // Settled on a static state: restore the full icon and
                    // let the thread end.
                    let (full, _) = state.frames();
                    apply(&app, full, None);
                    ANIMATING.store(false, Ordering::SeqCst);
                    return;
                };

                let (full, dim) = state.frames();
                apply(&app, if bright { full } else { dim }, None);
                bright = !bright;

                std::thread::sleep(interval);
            }
        })
        .ok();
}

/// Set the tray state from the frontend.
#[tauri::command]
pub async fn set_tray_state(app: AppHandle, state: TrayState) -> crate::util::JResult<()> {
    set_state(&app, state);
    Ok(())
}

/// Put the tray back to its resting state, and show the window.
pub fn reveal_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {

    /// The pulse is what floods the terminal on Linux; it must stay off there
    /// unless explicitly asked for, and stay on everywhere else.
    #[test]
    fn the_pulse_is_off_by_default_on_linux_only() {
        let forced = std::env::var_os("ARIA_TRAY_PULSE").is_some();
        if cfg!(target_os = "linux") {
            assert_eq!(pulse_supported(), forced);
        } else {
            assert!(pulse_supported());
        }
    }

    /// Dropping the animation must not drop the per-state icon: every state
    /// still has a distinct frame and tooltip to show.
    #[test]
    fn every_state_still_has_its_own_icon_and_tooltip() {
        let states = [
            TrayState::Idle,
            TrayState::Listening,
            TrayState::Thinking,
            TrayState::Speaking,
            TrayState::Acting,
        ];
        for state in states {
            let (full, _) = state.frames();
            assert!(!full.is_empty(), "{state:?} has no icon");
            assert!(state.tooltip().contains("ARIA"), "{state:?} tooltip");
        }
    }
    use super::*;

    #[test]
    fn every_state_has_two_distinct_frames() {
        for state in [
            TrayState::Idle,
            TrayState::Listening,
            TrayState::Thinking,
            TrayState::Speaking,
            TrayState::Acting,
        ] {
            let (full, dim) = state.frames();
            assert!(!full.is_empty(), "{state:?} has no icon");
            assert!(!dim.is_empty(), "{state:?} has no dim icon");
            // Identical frames would produce a pulse that does not visibly
            // pulse.
            assert_ne!(full, dim, "{state:?} frames are identical");
        }
    }

    #[test]
    fn generated_icons_are_valid_png() {
        let (full, _) = TrayState::Listening.frames();
        assert_eq!(
            &full[..8],
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
            "not a PNG header"
        );
        // IHDR immediately follows the signature and the length field.
        assert_eq!(&full[12..16], b"IHDR");
        assert!(full.ends_with(&[b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82]));
    }

    #[test]
    fn only_active_states_animate() {
        // A tray icon that moves forever is noise; the pulse has to mean
        // something.
        assert!(TrayState::Idle.pulse_interval().is_none());
        assert!(TrayState::Listening.pulse_interval().is_some());
        assert!(TrayState::Thinking.pulse_interval().is_some());
    }

    #[test]
    fn thinking_pulses_faster_than_listening() {
        // Listening is presence; thinking is activity. They should not read
        // the same.
        assert!(
            TrayState::Thinking.pulse_interval() < TrayState::Listening.pulse_interval(),
            "thinking should be the quicker pulse"
        );
    }

    #[test]
    fn every_state_names_itself_in_the_tooltip() {
        for state in [TrayState::Idle, TrayState::Listening, TrayState::Speaking] {
            assert!(state.tooltip().contains("ARIA"), "{state:?}");
        }
    }
}
