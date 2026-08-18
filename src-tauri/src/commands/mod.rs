pub mod apps;
pub mod audio;
pub mod browser;
pub mod builtin;
pub mod db;
pub mod files;
pub mod finetune;
pub mod gpu;
pub mod keyboard;
pub mod keys;
pub mod linux;
pub mod llm;
pub mod models;
pub mod mouse;
pub mod ollama;
pub mod screen;
pub mod secrets;
pub mod system;
pub mod training;
pub mod voice;
pub mod wakeword;
pub mod windows;

use crate::platform::detect::{self, dependency_checks, DependencyCheck, PlatformInfo};
use crate::util::{run, JResult, AriaError};

#[tauri::command]
pub async fn get_platform_info() -> JResult<PlatformInfo> {
    Ok(crate::platform::info().clone())
}

#[tauri::command]
pub async fn check_dependencies() -> JResult<Vec<DependencyCheck>> {
    // Re-probe rather than reusing the startup snapshot: the wizard calls this
    // again straight after an install, and a cached PATH would still show the
    // package as missing.
    Ok(dependency_checks(&detect::refreshed(crate::platform::info())))
}

/// Install one dependency the wizard reported as missing.
///
/// Backs the wizard's one-click install button. The privilege prompt is the
/// desktop's own polkit dialog (see `commands::linux`), so the user still
/// confirms — ARIA never acquires root silently.
#[tauri::command]
pub async fn install_dependency(name: String) -> JResult<String> {
    let checks = dependency_checks(&detect::refreshed(crate::platform::info()));
    let check = checks
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| AriaError::msg(format!("`{name}` is not a dependency ARIA knows.")))?;

    if check.present {
        return Ok(format!("{name} is already installed."));
    }

    let package = check.package.clone().ok_or_else(|| {
        AriaError::msg(format!(
            "{name} cannot be installed automatically on this system. Install it with: {}",
            check.install_hint
        ))
    })?;

    linux::install_package(package.clone()).await?;

    // Some packages are not usable the moment they land on disk.
    let note = after_install(&name).await;

    // Trust the probe, not the installer's exit code: a package can install
    // successfully and still not put the expected binary on PATH.
    let installed = dependency_checks(&detect::refreshed(crate::platform::info()))
        .iter()
        .any(|c| c.name == name && c.present);

    if !installed {
        return Err(AriaError::msg(format!(
            "{package} installed, but {name} is still not available. You may need to \
             log out and back in, or install it manually with: {}",
            check.install_hint
        )));
    }

    Ok(match note {
        Some(n) => format!("{name} installed. {n}"),
        None => format!("{name} installed."),
    })
}

/// Post-install steps for dependencies that need more than unpacking.
async fn after_install(name: &str) -> Option<String> {
    if name != "ydotool" {
        return None;
    }

    // ydotool talks to /dev/uinput through a daemon. Most distributions ship a
    // user unit; starting it here saves the user a terminal round trip.
    let started = run(
        "systemctl",
        &["--user", "enable", "--now", "ydotool.service"],
    )
    .await
    .map(|o| o.ok())
    .unwrap_or(false);

    Some(if started {
        "Its background daemon is running.".to_string()
    } else {
        // Worth being explicit: this is the one step that genuinely needs a
        // terminal, because granting uinput access is a root-level change.
        "Its daemon could not be started automatically — mouse and keyboard \
         control needs `sudo systemctl enable --now ydotoold`, and your user \
         must be able to reach /dev/uinput."
            .to_string()
    })
}
