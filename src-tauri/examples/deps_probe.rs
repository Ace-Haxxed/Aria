//! Manual probe: `cargo run --example deps_probe`.
//!
//! Prints exactly what the setup wizard's "Your system" step would show, so a
//! regression in the per-compositor logic is visible without launching the GUI.

fn main() {
    let info = aria_lib::platform::detect::refreshed(aria_lib::platform::info());
    println!(
        "{:?} / {:?} / {:?} / pm={:?}",
        info.os, info.session_type, info.compositor, info.package_manager
    );
    println!(
        "portal backends: gnome={} kde={} wlr={}",
        aria_lib::platform::detect::has_portal_backend("gnome"),
        aria_lib::platform::detect::has_portal_backend("kde"),
        aria_lib::platform::detect::has_portal_backend("wlr"),
    );
    println!();

    let checks = aria_lib::platform::detect::dependency_checks(&info);
    let mut missing_required = 0;
    for c in &checks {
        let mark = if c.present {
            "ok  "
        } else if c.required {
            missing_required += 1;
            "MISS"
        } else {
            "--  "
        };
        println!(
            "{mark} {:<26} {}{}",
            c.name,
            if c.required { "[required] " } else { "" },
            if c.present {
                String::new()
            } else {
                format!("install: {} (one-click: {})", c.install_hint, c.installable)
            }
        );
    }
    println!("\n{missing_required} required dependencies missing");
}
