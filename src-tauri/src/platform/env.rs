//! Process environment fix-ups applied before the GUI toolkit starts.
//!
//! These exist so a user who installs the .deb/.rpm/AppImage gets a working
//! app by double-clicking it, with no wrapper script and no exported variables
//! in a terminal. Everything here must therefore run before GTK and WebKitGTK
//! initialise, which is why it is called at the very top of `main`.
//!
//! Every variable is set only when the user has not set it themselves: an
//! explicit value in the environment is a deliberate choice and always wins.

/// Apply the Linux environment fix-ups. A no-op on Windows and macOS.
pub fn prepare() {
    if !cfg!(target_os = "linux") {
        return;
    }

    // Detect the desktop *before* touching anything, so the snapshot in
    // `platform::info()` records the session the user actually logged into.
    // Detection reads XDG_CURRENT_DESKTOP, and this function may write it.
    let _ = super::info();

    // Route GTK's file chooser, and anything else portal-aware, through
    // xdg-desktop-portal. Without this a sandboxed or Wayland-native session
    // gets GTK's own dialogs, which cannot see outside the sandbox.
    set_if_unset("GTK_USE_PORTAL", "1");

    // Only fill XDG_CURRENT_DESKTOP in when the session left it empty — some
    // display managers and bare `startx`-style sessions do.
    //
    // It is deliberately *not* forced to GNOME unconditionally. That variable
    // is how every portal implementation picks its backend and how NOVA
    // picks its window-management path, so overwriting a real value would
    // break precisely the desktops that already work: a KDE session would be
    // handed the GNOME portal backend and lose window control, and Hyprland
    // and Sway would lose theirs the same way. GNOME is the right default only
    // when there is nothing to preserve.
    if is_unset("XDG_CURRENT_DESKTOP") {
        std::env::set_var("XDG_CURRENT_DESKTOP", "GNOME");
    }

    // WebKitGTK's DMA-BUF renderer produces a blank window on several common
    // driver combinations (Nvidia proprietary, and some hybrid setups). The
    // fallback renderer costs a little GPU compositing and always draws.
    set_if_unset("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    set_if_unset("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
}

fn set_if_unset(key: &str, value: &str) {
    if is_unset(key) {
        std::env::set_var(key, value);
    }
}

/// Absent, or present but empty — an empty value carries no more information
/// than an absent one, and some sessions export the variable blank.
fn is_unset(key: &str) -> bool {
    std::env::var_os(key).is_none_or(|v| v.is_empty())
}
