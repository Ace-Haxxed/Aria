//! Runtime environment detection.
//!
//! Everything else in the backend asks this module which code path to take,
//! rather than guessing from `cfg!` alone — the same Linux binary has to work
//! on X11 and Wayland, under GNOME, KDE, Hyprland or Sway.

use crate::util::has;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OsKind {
    Linux,
    Windows,
    Macos,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    X11,
    Wayland,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Compositor {
    Gnome,
    Kde,
    Hyprland,
    Sway,
    Xfce,
    Other,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageManager {
    Pacman,
    Dnf,
    Apt,
    Brew,
    Winget,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: OsKind,
    pub arch: String,
    pub os_version: String,
    pub session_type: SessionType,
    pub compositor: Compositor,
    pub distro: Option<String>,
    pub package_manager: PackageManager,
    /// Presence of each external helper binary NOVA may shell out to.
    pub tools: HashMap<String, bool>,
    pub is_mobile: bool,
    pub is_desktop: bool,
}

/// Helper binaries we probe for. The setup wizard turns any missing *required*
/// entry into an install instruction for the detected distro.
pub const PROBED_TOOLS: &[&str] = &[
    // input
    "xdotool",
    "ydotool",
    "wtype",
    "dotool", // screen capture
    "grim",
    "slurp",
    "scrot",
    "maim",
    "import",
    "gnome-screenshot",
    "spectacle",
    "screencapture",
    // window management
    "wmctrl",
    "xprop",
    "hyprctl",
    "swaymsg",
    "qdbus",
    "gdbus",
    "kdotool",
    // system
    "pamixer",
    "pactl",
    "amixer",
    "brightnessctl",
    "notify-send",
    "playerctl",
    "xclip",
    "wl-copy",
    "wl-paste",
    "loginctl",
    "systemctl",
    // package managers
    "pacman",
    "yay",
    "paru",
    "dnf",
    "apt",
    "apt-get",
    "flatpak",
    "brew",
    "winget",
    // apps / runtimes
    "firefox",
    "chromium",
    "google-chrome",
    "python3",
    "node",
    "git",
    "docker",
    "ffmpeg",
    "ollama",
    "gtk-launch",
    "xdg-open",
];

pub fn detect() -> PlatformInfo {
    let os = if cfg!(target_os = "windows") {
        OsKind::Windows
    } else if cfg!(target_os = "macos") {
        OsKind::Macos
    } else {
        OsKind::Linux
    };

    let session_type = detect_session();
    let compositor = detect_compositor();
    let distro = detect_distro();
    let package_manager = detect_package_manager();

    let tools = PROBED_TOOLS
        .iter()
        .map(|t| ((*t).to_string(), has(t)))
        .collect();

    PlatformInfo {
        os,
        arch: std::env::consts::ARCH.to_string(),
        os_version: os_version(),
        session_type,
        compositor,
        distro,
        package_manager,
        tools,
        is_mobile: false,
        is_desktop: true,
    }
}

/// Re-probe the things that can change while NOVA is running.
///
/// The session type and compositor are fixed for the life of the process, but
/// PATH contents are not: a package installed from the setup wizard has to be
/// visible immediately, without asking the user to restart the app.
pub fn refreshed(info: &PlatformInfo) -> PlatformInfo {
    PlatformInfo {
        tools: PROBED_TOOLS
            .iter()
            .map(|t| ((*t).to_string(), has(t)))
            .collect(),
        package_manager: detect_package_manager(),
        ..info.clone()
    }
}

fn detect_session() -> SessionType {
    if !cfg!(target_os = "linux") {
        return SessionType::None;
    }

    match std::env::var("XDG_SESSION_TYPE").as_deref() {
        Ok("wayland") => return SessionType::Wayland,
        Ok("x11") => return SessionType::X11,
        _ => {}
    }

    // XDG_SESSION_TYPE is not always set (bare startx, some display managers),
    // so fall back to which display server socket the session actually has.
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        SessionType::Wayland
    } else if std::env::var("DISPLAY").is_ok() {
        SessionType::X11
    } else {
        SessionType::None
    }
}

fn detect_compositor() -> Compositor {
    if !cfg!(target_os = "linux") {
        return Compositor::None;
    }

    // Hyprland and Sway advertise themselves through their own IPC variables
    // even when XDG_CURRENT_DESKTOP is generic or unset.
    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() {
        return Compositor::Hyprland;
    }
    if std::env::var("SWAYSOCK").is_ok() {
        return Compositor::Sway;
    }

    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .or_else(|_| std::env::var("XDG_SESSION_DESKTOP"))
        .or_else(|_| std::env::var("DESKTOP_SESSION"))
        .unwrap_or_default()
        .to_lowercase();

    if desktop.is_empty() {
        return Compositor::None;
    }
    if desktop.contains("gnome") {
        Compositor::Gnome
    } else if desktop.contains("kde") || desktop.contains("plasma") {
        Compositor::Kde
    } else if desktop.contains("hyprland") {
        Compositor::Hyprland
    } else if desktop.contains("sway") {
        Compositor::Sway
    } else if desktop.contains("xfce") {
        Compositor::Xfce
    } else {
        Compositor::Other
    }
}

fn detect_distro() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let content = std::fs::read_to_string("/etc/os-release").ok()?;
    for line in content.lines() {
        if let Some(v) = line.strip_prefix("ID=") {
            return Some(v.trim_matches('"').to_string());
        }
    }
    None
}

fn detect_package_manager() -> PackageManager {
    if cfg!(target_os = "macos") {
        return if has("brew") {
            PackageManager::Brew
        } else {
            PackageManager::None
        };
    }
    if cfg!(target_os = "windows") {
        return if has("winget") {
            PackageManager::Winget
        } else {
            PackageManager::None
        };
    }

    // Probe in order of specificity — a system with both `apt` and `dnf`
    // installed is almost certainly Debian-family with dnf as a stray package.
    if has("pacman") {
        PackageManager::Pacman
    } else if has("dnf") {
        PackageManager::Dnf
    } else if has("apt-get") || has("apt") {
        PackageManager::Apt
    } else {
        PackageManager::None
    }
}

fn os_version() -> String {
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
            for line in content.lines() {
                if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                    return v.trim_matches('"').to_string();
                }
            }
        }
        std::fs::read_to_string("/proc/version")
            .map(|s| s.split_whitespace().take(3).collect::<Vec<_>>().join(" "))
            .unwrap_or_else(|_| "Linux".into())
    }
    #[cfg(not(target_os = "linux"))]
    {
        sysinfo::System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string())
    }
}

/// Is a desktop portal backend installed?
///
/// Portal backends are not binaries on PATH — they are `.portal` files that
/// xdg-desktop-portal reads to decide which implementation to talk to — so
/// `which` cannot see them and they have to be looked for on disk.
pub fn has_portal_backend(name: &str) -> bool {
    let mut roots: Vec<std::path::PathBuf> = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .collect();

    // XDG_DATA_DIRS is frequently unset or trimmed inside a desktop session;
    // the spec's defaults are where distributions actually install these.
    for fallback in ["/usr/share", "/usr/local/share"] {
        let p = std::path::PathBuf::from(fallback);
        if !roots.contains(&p) {
            roots.push(p);
        }
    }

    roots
        .iter()
        .any(|r| r.join("xdg-desktop-portal/portals").join(format!("{name}.portal")).exists())
}

/// Per-distribution package names for one dependency. The same tool is called
/// something different nearly everywhere, and a hint the user cannot paste is
/// worse than no hint at all.
#[derive(Debug, Clone, Copy)]
pub struct Pkg {
    pub arch: &'static str,
    pub fedora: &'static str,
    pub debian: &'static str,
    pub mac: &'static str,
    pub windows: &'static str,
}

impl Pkg {
    /// The same name everywhere, which is the common case.
    const fn same(name: &'static str) -> Self {
        Pkg {
            arch: name,
            fedora: name,
            debian: name,
            mac: name,
            windows: name,
        }
    }

    /// The package to install on this machine, or `None` when this dependency
    /// cannot be installed by the detected package manager.
    fn for_pm(&self, pm: PackageManager) -> Option<String> {
        let name = match pm {
            PackageManager::Pacman => self.arch,
            PackageManager::Dnf => self.fedora,
            PackageManager::Apt => self.debian,
            PackageManager::Brew => self.mac,
            PackageManager::Winget => self.windows,
            PackageManager::None => return None,
        };
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        }
    }
}

/// The command a user would type to install `package` themselves. Shown next to
/// the one-click button so nothing is hidden.
fn install_command(pm: PackageManager, package: Option<&str>) -> String {
    let Some(p) = package else {
        return "Not available through this system's package manager".to_string();
    };
    match pm {
        PackageManager::Pacman => format!("sudo pacman -S --needed {p}"),
        PackageManager::Dnf => format!("sudo dnf install {p}"),
        PackageManager::Apt => format!("sudo apt install {p}"),
        PackageManager::Brew => format!("brew install {p}"),
        PackageManager::Winget => format!("winget install {p}"),
        PackageManager::None => "Install via your system package manager".to_string(),
    }
}

/// A capability the current environment either supports or doesn't, plus how to
/// fix it. The setup wizard renders these verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyCheck {
    pub name: String,
    pub present: bool,
    pub required: bool,
    pub purpose: String,
    pub install_hint: String,
    /// Package to hand to `install_dependency`, when one exists for this
    /// machine's package manager.
    pub package: Option<String>,
    /// Whether the wizard may offer a one-click install for this entry.
    pub installable: bool,
}

/// Which helpers matter for *this* machine, given its OS/session/compositor.
///
/// The list is deliberately narrow: anything NOVA can do through a portal or
/// a host API is not listed, because listing it would ask the user to install
/// something that would not be used. In particular nothing here asks a GNOME
/// session for `grim` — GNOME cannot use it, and screen capture there goes
/// through xdg-desktop-portal instead.
pub fn dependency_checks(info: &PlatformInfo) -> Vec<DependencyCheck> {
    let mut checks = Vec::new();
    let pm = info.package_manager;
    let tool = |name: &str| *info.tools.get(name).unwrap_or(&false);

    let mut add = |name: &str, present: bool, required: bool, purpose: &str, pkg: Option<Pkg>| {
        let package = pkg.and_then(|p| p.for_pm(pm));
        checks.push(DependencyCheck {
            name: name.to_string(),
            present,
            required,
            purpose: purpose.to_string(),
            install_hint: if present {
                String::new()
            } else {
                install_command(pm, package.as_deref())
            },
            installable: !present && package.is_some(),
            package,
        });
    };

    if info.os == OsKind::Linux {
        match info.session_type {
            SessionType::Wayland => {
                // Wayland gives no client a way to synthesise input, so this is
                // the one genuinely unavoidable dependency: ydotool works
                // through the kernel's uinput device, below the compositor.
                add(
                    "ydotool",
                    tool("ydotool"),
                    true,
                    "Mouse and keyboard control on Wayland",
                    Some(Pkg::same("ydotool")),
                );
                add(
                    "wtype",
                    tool("wtype"),
                    false,
                    "Faster, Unicode-correct typing on Wayland",
                    Some(Pkg::same("wtype")),
                );

                // Screen capture differs per compositor family, and asking for
                // the wrong one is worse than asking for nothing.
                match info.compositor {
                    Compositor::Gnome => add(
                        "xdg-desktop-portal-gnome",
                        has_portal_backend("gnome"),
                        true,
                        "Screen capture on GNOME (GNOME does not implement the \
                         wlr-screencopy protocol that grim needs)",
                        Some(Pkg::same("xdg-desktop-portal-gnome")),
                    ),
                    Compositor::Kde => add(
                        "xdg-desktop-portal-kde",
                        has_portal_backend("kde") || tool("spectacle"),
                        true,
                        "Screen capture on KDE",
                        Some(Pkg::same("xdg-desktop-portal-kde")),
                    ),
                    // wlroots: grim is the fast native path, the portal backend
                    // covers the rest, so either one satisfies the check.
                    _ => {
                        add(
                            "grim",
                            tool("grim") || has_portal_backend("wlr"),
                            true,
                            "Screen capture on wlroots compositors",
                            Some(Pkg::same("grim")),
                        );
                        add(
                            "slurp",
                            tool("slurp"),
                            false,
                            "Interactive region selection",
                            Some(Pkg::same("slurp")),
                        );
                    }
                }

                add(
                    "wl-copy",
                    tool("wl-copy"),
                    false,
                    "Clipboard access on Wayland",
                    Some(Pkg::same("wl-clipboard")),
                );
            }
            _ => {
                add(
                    "xdotool",
                    tool("xdotool"),
                    true,
                    "Mouse, keyboard and window control on X11",
                    Some(Pkg::same("xdotool")),
                );
                add(
                    "scrot",
                    tool("scrot") || tool("maim") || tool("import"),
                    true,
                    "Screen capture on X11",
                    Some(Pkg::same("scrot")),
                );
                add(
                    "wmctrl",
                    tool("wmctrl"),
                    false,
                    "Window listing and management on X11",
                    Some(Pkg::same("wmctrl")),
                );
                add(
                    "xclip",
                    tool("xclip"),
                    false,
                    "Clipboard access on X11",
                    Some(Pkg::same("xclip")),
                );
            }
        }

        match info.compositor {
            Compositor::Hyprland => add(
                "hyprctl",
                tool("hyprctl"),
                true,
                "Window management under Hyprland",
                None,
            ),
            Compositor::Sway => add(
                "swaymsg",
                tool("swaymsg"),
                true,
                "Window management under Sway",
                None,
            ),
            Compositor::Kde => add(
                "qdbus",
                tool("qdbus"),
                false,
                "Window management under KDE",
                Some(Pkg {
                    arch: "qt6-tools",
                    fedora: "qt5-qttools",
                    debian: "qdbus-qt5",
                    mac: "",
                    windows: "",
                }),
            ),
            _ => {}
        }

        add(
            "pamixer",
            tool("pamixer") || tool("pactl") || tool("amixer"),
            false,
            "Volume control",
            Some(Pkg::same("pamixer")),
        );
        add(
            "brightnessctl",
            tool("brightnessctl"),
            false,
            "Screen brightness control",
            Some(Pkg::same("brightnessctl")),
        );
        add(
            "notify-send",
            tool("notify-send"),
            false,
            "Desktop notifications",
            Some(Pkg {
                arch: "libnotify",
                fedora: "libnotify",
                debian: "libnotify-bin",
                mac: "terminal-notifier",
                windows: "",
            }),
        );
        add(
            "playerctl",
            tool("playerctl"),
            false,
            "Media playback control",
            Some(Pkg::same("playerctl")),
        );
    }

    // Cross-platform extras. None are required: each gates one optional
    // feature, and the feature reports what is missing if it is ever used.
    add(
        "ffmpeg",
        tool("ffmpeg"),
        false,
        "Screen recording and audio conversion",
        Some(Pkg::same("ffmpeg")),
    );
    add(
        "ollama",
        tool("ollama"),
        false,
        "Local offline LLM backend",
        Some(Pkg::same("ollama")),
    );
    add(
        "chromium",
        tool("chromium") || tool("google-chrome") || tool("firefox"),
        false,
        "Browser automation over the DevTools protocol",
        Some(Pkg::same("chromium")),
    );

    // hyprctl and swaymsg are not separately packaged — they are part of the
    // compositor already running, so the generic "install this package" hint
    // would send the user looking for something that does not exist.
    for check in checks.iter_mut().filter(|c| !c.present) {
        let compositor = match check.name.as_str() {
            "hyprctl" => "Hyprland",
            "swaymsg" => "Sway",
            _ => continue,
        };
        check.install_hint =
            format!("Ships with {compositor} — reinstall or repair your {compositor} package.");
    }

    checks
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Linux machine with nothing installed, so a check that passes is
    /// passing on its own logic rather than on this developer's PATH.
    fn bare(session: SessionType, compositor: Compositor) -> PlatformInfo {
        PlatformInfo {
            os: OsKind::Linux,
            arch: "x86_64".into(),
            os_version: "test".into(),
            session_type: session,
            compositor,
            distro: Some("arch".into()),
            package_manager: PackageManager::Pacman,
            tools: PROBED_TOOLS.iter().map(|t| ((*t).to_string(), false)).collect(),
            is_mobile: false,
            is_desktop: true,
        }
    }

    fn required_names(info: &PlatformInfo) -> Vec<String> {
        dependency_checks(info)
            .into_iter()
            .filter(|c| c.required)
            .map(|c| c.name)
            .collect()
    }

    #[test]
    fn gnome_never_asks_for_grim() {
        // The bug this whole path exists for: GNOME does not implement
        // wlr-screencopy, so grim can never work there and must never be
        // presented as the fix for screen capture.
        let names = required_names(&bare(SessionType::Wayland, Compositor::Gnome));
        assert!(!names.contains(&"grim".to_string()), "got {names:?}");
        assert!(names.contains(&"xdg-desktop-portal-gnome".to_string()), "got {names:?}");
    }

    #[test]
    fn wlroots_still_asks_for_grim() {
        for compositor in [Compositor::Hyprland, Compositor::Sway] {
            let names = required_names(&bare(SessionType::Wayland, compositor));
            assert!(names.contains(&"grim".to_string()), "{compositor:?}: {names:?}");
        }
    }

    #[test]
    fn x11_asks_for_x11_tools_only() {
        let names = required_names(&bare(SessionType::X11, Compositor::Gnome));
        assert!(names.contains(&"xdotool".to_string()), "got {names:?}");
        assert!(names.contains(&"scrot".to_string()), "got {names:?}");
        assert!(!names.contains(&"grim".to_string()), "got {names:?}");
        assert!(!names.contains(&"ydotool".to_string()), "got {names:?}");
    }

    #[test]
    fn missing_entries_carry_a_usable_install_command() {
        // A hint the user cannot act on is the same as no hint.
        for check in dependency_checks(&bare(SessionType::Wayland, Compositor::Gnome)) {
            if check.present {
                continue;
            }
            assert!(!check.install_hint.is_empty(), "{} has no hint", check.name);
            if check.installable {
                assert!(
                    check.install_hint.contains("pacman"),
                    "{} is one-click installable but its hint is `{}`",
                    check.name,
                    check.install_hint
                );
                assert!(check.package.is_some(), "{} has no package", check.name);
            }
        }
    }

    #[test]
    fn bundled_compositor_tools_are_not_offered_as_packages() {
        let checks = dependency_checks(&bare(SessionType::Wayland, Compositor::Hyprland));
        let hyprctl = checks.iter().find(|c| c.name == "hyprctl").expect("hyprctl check");
        assert!(!hyprctl.installable);
        assert!(hyprctl.install_hint.contains("Hyprland"), "{}", hyprctl.install_hint);
    }

    #[test]
    fn no_package_manager_means_no_one_click_install() {
        let mut info = bare(SessionType::Wayland, Compositor::Gnome);
        info.package_manager = PackageManager::None;
        for check in dependency_checks(&info) {
            assert!(!check.installable, "{} claims to be installable", check.name);
        }
    }

    #[test]
    fn alternatives_satisfy_a_check() {
        // maim is as good as scrot for X11 capture; demanding the exact binary
        // would report a working machine as broken.
        let mut info = bare(SessionType::X11, Compositor::Other);
        info.tools.insert("maim".into(), true);
        let missing: Vec<String> = dependency_checks(&info)
            .into_iter()
            .filter(|c| c.required && !c.present)
            .map(|c| c.name)
            .collect();
        assert!(!missing.contains(&"scrot".to_string()), "got {missing:?}");
    }
}
