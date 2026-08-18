//! Linux package and service management.
//!
//! Everything here needs root. We prefer `pkexec`, which raises the desktop's
//! own polkit prompt — a GUI app has no terminal to type a sudo password into,
//! and prompting invisibly would just hang.

use crate::platform::detect::PackageManager;
use crate::util::{cap_output, has, run_owned, JResult, AriaError};

fn pm() -> JResult<PackageManager> {
    match crate::platform::info().package_manager {
        PackageManager::None => Err(AriaError::msg(
            "No supported package manager was found on this system.",
        )),
        other => Ok(other),
    }
}

/// Build a privileged command, preferring the graphical auth agent.
fn privileged(argv: &[&str]) -> JResult<(String, Vec<String>)> {
    let mut args: Vec<String> = argv.iter().map(|s| s.to_string()).collect();

    if has("pkexec") {
        return Ok(("pkexec".to_string(), args));
    }
    if has("sudo") {
        // -n: never prompt. Without a tty a prompt would block until the timeout.
        args.insert(0, "-n".to_string());
        return Ok(("sudo".to_string(), args));
    }
    Err(AriaError::msg(
        "Neither pkexec nor sudo is available, so ARIA cannot run privileged commands.",
    ))
}

async fn run_privileged(argv: &[&str]) -> JResult<String> {
    let (program, args) = privileged(argv)?;
    let out = run_owned(&program, &args).await?;

    if !out.ok() {
        let stderr = out.stderr.trim();
        if stderr.contains("password is required") || stderr.contains("a terminal is required") {
            return Err(AriaError::msg(
                "This needs administrator rights, but no graphical authentication agent \
                 (polkit) is running. Start one, or run the command yourself in a terminal.",
            ));
        }
        return Err(AriaError::msg(format!(
            "command failed (exit {}): {}",
            out.exit_code,
            if stderr.is_empty() {
                out.trimmed()
            } else {
                stderr
            }
        )));
    }
    Ok(cap_output(out.trimmed(), 8_000))
}

#[tauri::command]
pub async fn install_package(name: String) -> JResult<String> {
    match pm()? {
        PackageManager::Pacman => {
            // AUR helpers must not run as root; they call sudo themselves.
            if has("yay") {
                let out =
                    run_owned("yay", &["-S".into(), "--noconfirm".into(), name.clone()]).await?;
                if out.ok() {
                    return Ok(cap_output(out.trimmed(), 8_000));
                }
            }
            run_privileged(&["pacman", "-S", "--noconfirm", &name]).await
        }
        PackageManager::Dnf => run_privileged(&["dnf", "install", "-y", &name]).await,
        PackageManager::Apt => run_privileged(&["apt-get", "install", "-y", &name]).await,
        PackageManager::Brew => {
            let out = run_owned("brew", &["install".into(), name]).await?;
            Ok(cap_output(out.trimmed(), 8_000))
        }
        PackageManager::Winget => {
            let out = run_owned(
                "winget",
                &[
                    "install".into(),
                    "-e".into(),
                    "--accept-package-agreements".into(),
                    "--accept-source-agreements".into(),
                    name,
                ],
            )
            .await?;
            Ok(cap_output(out.trimmed(), 8_000))
        }
        PackageManager::None => unreachable!("pm() rejects None"),
    }
}

#[tauri::command]
pub async fn remove_package(name: String) -> JResult<String> {
    match pm()? {
        PackageManager::Pacman => run_privileged(&["pacman", "-Rns", "--noconfirm", &name]).await,
        PackageManager::Dnf => run_privileged(&["dnf", "remove", "-y", &name]).await,
        PackageManager::Apt => run_privileged(&["apt-get", "remove", "-y", &name]).await,
        PackageManager::Brew => {
            let out = run_owned("brew", &["uninstall".into(), name]).await?;
            Ok(cap_output(out.trimmed(), 8_000))
        }
        PackageManager::Winget => {
            let out = run_owned("winget", &["uninstall".into(), "-e".into(), name]).await?;
            Ok(cap_output(out.trimmed(), 8_000))
        }
        PackageManager::None => unreachable!("pm() rejects None"),
    }
}

#[tauri::command]
pub async fn list_installed_packages() -> JResult<Vec<String>> {
    let (program, args): (&str, Vec<&str>) = match pm()? {
        PackageManager::Pacman => ("pacman", vec!["-Qq"]),
        PackageManager::Dnf => ("rpm", vec!["-qa", "--qf", "%{NAME}\n"]),
        PackageManager::Apt => ("dpkg-query", vec!["-f", "${binary:Package}\n", "-W"]),
        PackageManager::Brew => ("brew", vec!["list", "--formula"]),
        PackageManager::Winget => ("winget", vec!["list"]),
        PackageManager::None => unreachable!("pm() rejects None"),
    };

    let owned: Vec<String> = args.into_iter().map(String::from).collect();
    let out = run_owned(program, &owned).await?;
    Ok(out
        .stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

#[tauri::command]
pub async fn update_system() -> JResult<String> {
    match pm()? {
        PackageManager::Pacman => run_privileged(&["pacman", "-Syu", "--noconfirm"]).await,
        PackageManager::Dnf => run_privileged(&["dnf", "upgrade", "-y"]).await,
        PackageManager::Apt => {
            run_privileged(&["apt-get", "update"]).await?;
            run_privileged(&["apt-get", "upgrade", "-y"]).await
        }
        PackageManager::Brew => {
            let out = run_owned("brew", &["upgrade".into()]).await?;
            Ok(cap_output(out.trimmed(), 8_000))
        }
        PackageManager::Winget => {
            let out = run_owned(
                "winget",
                &[
                    "upgrade".into(),
                    "--all".into(),
                    "--accept-package-agreements".into(),
                ],
            )
            .await?;
            Ok(cap_output(out.trimmed(), 8_000))
        }
        PackageManager::None => unreachable!("pm() rejects None"),
    }
}

#[tauri::command]
pub async fn manage_service(name: String, action: String) -> JResult<String> {
    if !has("systemctl") {
        return Err(AriaError::missing(
            "systemctl",
            "Service management requires systemd.",
        ));
    }
    if !matches!(action.as_str(), "start" | "stop" | "restart" | "status") {
        return Err(AriaError::msg(format!(
            "unsupported service action `{action}`"
        )));
    }

    // `status` is read-only and works unprivileged; the rest need root.
    if action == "status" {
        let out = run_owned("systemctl", &["status".into(), name, "--no-pager".into()]).await?;
        return Ok(cap_output(out.trimmed(), 6_000));
    }

    run_privileged(&["systemctl", &action, &name]).await
}
