//! Manual probe: `cargo run --example env_probe`.
//!
//! Verifies the launch environment fix-ups, including the guard that stops
//! XDG_CURRENT_DESKTOP being overwritten on a non-GNOME desktop. Run it under
//! different sessions to confirm:
//!
//!   XDG_CURRENT_DESKTOP=KDE   cargo run --example env_probe   # must stay KDE
//!   XDG_CURRENT_DESKTOP=      cargo run --example env_probe   # must become GNOME

fn show(key: &str) {
    println!(
        "  {key} = {}",
        std::env::var(key).unwrap_or_else(|_| "<unset>".into())
    );
}

fn main() {
    println!("before:");
    for k in [
        "XDG_CURRENT_DESKTOP",
        "GTK_USE_PORTAL",
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
    ] {
        show(k);
    }

    let before = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    aria_lib::platform::env::prepare();
    let after = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();

    println!("after:");
    for k in [
        "XDG_CURRENT_DESKTOP",
        "GTK_USE_PORTAL",
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
    ] {
        show(k);
    }

    // The whole point of the guard: a real desktop must survive untouched, or
    // portals and window management get pointed at the wrong backend.
    if !before.is_empty() {
        assert_eq!(before, after, "an existing XDG_CURRENT_DESKTOP was clobbered");
        println!("\nOK: preserved existing desktop `{after}`");
    } else {
        assert_eq!(after, "GNOME");
        println!("\nOK: empty desktop defaulted to GNOME");
    }

    assert_eq!(std::env::var("GTK_USE_PORTAL").unwrap(), "1");
    println!("OK: detected compositor is {:?}", aria_lib::platform::info().compositor);
}
