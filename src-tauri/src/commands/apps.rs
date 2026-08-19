//! Launching, listing and stopping applications.

use crate::platform::detect::OsKind;
use crate::util::{has, run, spawn_detached, JResult, NovaError};
use sysinfo::{ProcessesToUpdate, System};

/// Find the `.desktop` entry whose name or exec matches, so "spotify",
/// "Spotify" and "com.spotify.Client" all resolve to the same launcher.
fn find_desktop_entry(name: &str) -> Option<String> {
    let needle = name.to_lowercase();
    let mut dirs: Vec<std::path::PathBuf> = vec![
        "/usr/share/applications".into(),
        "/usr/local/share/applications".into(),
        "/var/lib/flatpak/exports/share/applications".into(),
    ];
    if let Some(home) = dirs::data_dir() {
        dirs.push(home.join("applications"));
        dirs.push(home.join("flatpak/exports/share/applications"));
    }

    let mut fallback = None;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let stem = path.file_stem()?.to_string_lossy().to_lowercase();
            let file_name = path.file_name()?.to_string_lossy().to_string();

            if stem == needle {
                return Some(file_name); // exact id wins immediately
            }

            // Otherwise check the human-readable Name= field.
            if let Ok(content) = std::fs::read_to_string(&path) {
                for line in content.lines() {
                    if let Some(v) = line.strip_prefix("Name=") {
                        let v = v.trim().to_lowercase();
                        if v == needle {
                            return Some(file_name);
                        }
                        if fallback.is_none() && (v.contains(&needle) || stem.contains(&needle)) {
                            fallback = Some(file_name.clone());
                        }
                        break;
                    }
                }
            }
        }
    }
    fallback
}

#[tauri::command]
pub async fn launch_app(name: String) -> JResult<String> {
    match crate::platform::info().os {
        OsKind::Linux => {
            // A bare executable on PATH is the most direct match.
            if has(&name) {
                spawn_detached(&name, &[])?;
                return Ok(format!("launched {name}"));
            }
            if let Some(entry) = find_desktop_entry(&name) {
                let id = entry.trim_end_matches(".desktop").to_string();
                if has("gtk-launch") {
                    spawn_detached("gtk-launch", &[&id])?;
                    return Ok(format!("launched {name} via {entry}"));
                }
                if has("gio") {
                    spawn_detached(
                        "gio",
                        &["launch", &format!("/usr/share/applications/{entry}")],
                    )?;
                    return Ok(format!("launched {name} via {entry}"));
                }
            }
            Err(NovaError::msg(format!(
                "could not find an application called `{name}`"
            )))
        }
        OsKind::Macos => {
            spawn_detached("open", &["-a", &name])?;
            Ok(format!("launched {name}"))
        }
        OsKind::Windows => {
            spawn_detached("cmd", &["/C", "start", "", &name])?;
            Ok(format!("launched {name}"))
        }
    }
}

#[tauri::command]
pub async fn kill_app(name: String) -> JResult<String> {
    match crate::platform::info().os {
        OsKind::Windows => {
            let out = run("taskkill", &["/IM", &format!("{name}.exe"), "/F"]).await?;
            if !out.ok() {
                return Err(NovaError::msg(format!(
                    "could not stop {name}: {}",
                    out.stderr.trim()
                )));
            }
            Ok(format!("stopped {name}"))
        }
        _ => {
            let out = run("pkill", &["-f", &name]).await?;
            // pkill exits 1 when nothing matched — that is not an error worth raising.
            if out.exit_code > 1 {
                return Err(NovaError::msg(format!(
                    "could not stop {name}: {}",
                    out.stderr.trim()
                )));
            }
            if out.exit_code == 1 {
                return Err(NovaError::msg(format!("`{name}` is not running")));
            }
            Ok(format!("stopped {name}"))
        }
    }
}

#[tauri::command]
pub async fn list_running_apps() -> JResult<Vec<String>> {
    // Prefer the window list: those are the apps the user can actually see.
    if let Ok(windows) = crate::platform::list_windows().await {
        if !windows.is_empty() {
            let mut apps: Vec<String> = windows
                .into_iter()
                .map(|w| if w.app.is_empty() { w.title } else { w.app })
                .filter(|a| !a.is_empty())
                .collect();
            apps.sort();
            apps.dedup();
            return Ok(apps);
        }
    }

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut names: Vec<String> = sys
        .processes()
        .values()
        .map(|p| p.name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

#[tauri::command]
pub async fn is_app_running(name: String) -> JResult<bool> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let needle = name.to_lowercase();
    Ok(sys
        .processes()
        .values()
        .any(|p| p.name().to_string_lossy().to_lowercase().contains(&needle)))
}
