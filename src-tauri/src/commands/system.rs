//! System control: metrics, audio, brightness, power, clipboard, processes.

use crate::platform::detect::OsKind;
use crate::state::AppState;
use crate::util::{
    cap_output, first_available, has, run, run_shell, CmdOutput, JResult, NovaError,
};
use serde::{Deserialize, Serialize};
use sysinfo::{Disks, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub hostname: String,
    pub cpu_usage: f32,
    pub cpu_count: usize,
    pub ram_used: u64,
    pub ram_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub battery: Option<u8>,
    pub charging: Option<bool>,
    pub uptime: u64,
}

#[tauri::command]
pub async fn get_system_info() -> JResult<SystemInfo> {
    let mut sys = System::new_all();
    // CPU usage is a delta between two samples; one refresh always reads 0.
    sys.refresh_cpu_usage();
    tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let disks = Disks::new_with_refreshed_list();
    let (mut disk_total, mut disk_avail) = (0u64, 0u64);
    // Sum only real mount points; /proc, /sys and friends report zero anyway.
    for d in disks.list() {
        if d.total_space() > 0 {
            disk_total += d.total_space();
            disk_avail += d.available_space();
        }
    }

    let (battery, charging) = battery_status().await;

    Ok(SystemInfo {
        os: System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
        hostname: System::host_name().unwrap_or_default(),
        cpu_usage: sys.global_cpu_usage(),
        cpu_count: sys.cpus().len(),
        ram_used: sys.used_memory(),
        ram_total: sys.total_memory(),
        disk_used: disk_total.saturating_sub(disk_avail),
        disk_total,
        battery,
        charging,
        uptime: System::uptime(),
    })
}

async fn battery_status() -> (Option<u8>, Option<bool>) {
    #[cfg(target_os = "linux")]
    {
        // sysfs is the canonical source and needs no helper binary.
        for bat in ["BAT0", "BAT1", "BATT"] {
            let base = format!("/sys/class/power_supply/{bat}");
            if let Ok(cap) = std::fs::read_to_string(format!("{base}/capacity")) {
                let pct = cap.trim().parse::<u8>().ok();
                let charging = std::fs::read_to_string(format!("{base}/status"))
                    .ok()
                    .map(|s| s.trim() == "Charging" || s.trim() == "Full");
                return (pct, charging);
            }
        }
        (None, None)
    }
    #[cfg(target_os = "macos")]
    {
        let Ok(out) = run("pmset", &["-g", "batt"]).await else {
            return (None, None);
        };
        let pct = out
            .stdout
            .split('%')
            .next()
            .and_then(|s| s.rsplit(char::is_whitespace).next().map(str::to_string))
            .and_then(|s| s.trim().parse::<u8>().ok());
        let charging = Some(out.stdout.contains("AC Power"));
        (pct, charging)
    }
    #[cfg(target_os = "windows")]
    {
        let Ok(out) = run(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_Battery).EstimatedChargeRemaining",
            ],
        )
        .await
        else {
            return (None, None);
        };
        (out.trimmed().parse::<u8>().ok(), None)
    }
}

/* ── Audio ──────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn get_volume() -> JResult<u8> {
    match crate::platform::info().os {
        OsKind::Linux => {
            if has("pamixer") {
                let out = run("pamixer", &["--get-volume"]).await?;
                return Ok(out.trimmed().parse().unwrap_or(0));
            }
            if has("pactl") {
                let out = run("pactl", &["get-sink-volume", "@DEFAULT_SINK@"]).await?;
                // "Volume: front-left: 45875 /  70% / -9.29 dB, ..."
                if let Some(pct) = out.stdout.split('%').next().and_then(|s| {
                    s.rsplit(|c: char| !c.is_ascii_digit())
                        .next()
                        .and_then(|n| n.parse::<u8>().ok())
                }) {
                    return Ok(pct);
                }
            }
            Err(NovaError::missing(
                "pamixer",
                "Volume control needs pamixer or pactl (PulseAudio/PipeWire).",
            ))
        }
        OsKind::Macos => {
            let out = run(
                "osascript",
                &["-e", "output volume of (get volume settings)"],
            )
            .await?;
            Ok(out.trimmed().parse().unwrap_or(0))
        }
        OsKind::Windows => {
            // Windows has no built-in volume CLI; read it through the audio endpoint COM API.
            let out = run(
                "powershell",
                &[
                    "-NoProfile",
                    "-Command",
                    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices;[Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IAudioEndpointVolume{int _0();int _1();int _2();int _3();int SetMasterVolumeLevelScalar(float f,System.Guid g);int GetMasterVolumeLevelScalar(out float f);}[Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IMMDevice{int Activate(ref System.Guid id,int ctx,System.IntPtr p,[MarshalAs(UnmanagedType.IUnknown)]out object o);}[Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IMMDeviceEnumerator{int _0();int GetDefaultAudioEndpoint(int f,int r,out IMMDevice d);}[ComImport,Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")]public class MMDeviceEnumeratorComObject{}public class Audio{public static float Get(){var e=(IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());IMMDevice d;e.GetDefaultAudioEndpoint(0,1,out d);var g=typeof(IAudioEndpointVolume).GUID;object o;d.Activate(ref g,23,System.IntPtr.Zero,out o);var v=(IAudioEndpointVolume)o;float f;v.GetMasterVolumeLevelScalar(out f);return f*100;}}'; [Audio]::Get()",
                ],
            )
            .await?;
            Ok(out
                .trimmed()
                .split('.')
                .next()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0))
        }
    }
}

#[tauri::command]
pub async fn set_volume(level: u8) -> JResult<()> {
    let level = level.min(100);
    match crate::platform::info().os {
        OsKind::Linux => {
            if has("pamixer") {
                run("pamixer", &["--set-volume", &level.to_string()]).await?;
            } else if has("pactl") {
                run(
                    "pactl",
                    &["set-sink-volume", "@DEFAULT_SINK@", &format!("{level}%")],
                )
                .await?;
            } else {
                return Err(NovaError::missing(
                    "pamixer",
                    "Volume control needs pamixer or pactl.",
                ));
            }
        }
        OsKind::Macos => {
            run(
                "osascript",
                &["-e", &format!("set volume output volume {level}")],
            )
            .await?;
        }
        OsKind::Windows => {
            // Nudge the volume with media keys — no COM plumbing needed for a relative set.
            return Err(NovaError::msg(
                "Setting an absolute volume level is not supported on Windows; \
                 use mute/unmute or adjust it from the system tray.",
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mute() -> JResult<()> {
    set_mute(true).await
}

#[tauri::command]
pub async fn unmute() -> JResult<()> {
    set_mute(false).await
}

async fn set_mute(on: bool) -> JResult<()> {
    match crate::platform::info().os {
        OsKind::Linux => {
            if has("pamixer") {
                run("pamixer", &[if on { "--mute" } else { "--unmute" }]).await?;
            } else if has("pactl") {
                run(
                    "pactl",
                    &[
                        "set-sink-mute",
                        "@DEFAULT_SINK@",
                        if on { "1" } else { "0" },
                    ],
                )
                .await?;
            } else {
                return Err(NovaError::missing(
                    "pamixer",
                    "Muting needs pamixer or pactl.",
                ));
            }
        }
        OsKind::Macos => {
            run(
                "osascript",
                &["-e", &format!("set volume output muted {on}")],
            )
            .await?;
        }
        OsKind::Windows => {
            return Err(NovaError::msg("Muting is not scriptable on Windows."));
        }
    }
    Ok(())
}

/* ── Brightness ─────────────────────────────────────────────────── */

#[tauri::command]
pub async fn get_brightness() -> JResult<u8> {
    if crate::platform::info().os == OsKind::Linux {
        if !has("brightnessctl") {
            return Err(NovaError::missing(
                "brightnessctl",
                "Brightness control needs brightnessctl.",
            ));
        }
        let cur = run("brightnessctl", &["get"]).await?;
        let max = run("brightnessctl", &["max"]).await?;
        let cur: f64 = cur.trimmed().parse().unwrap_or(0.0);
        let max: f64 = max.trimmed().parse().unwrap_or(1.0);
        return Ok(((cur / max.max(1.0)) * 100.0).round() as u8);
    }
    Err(NovaError::msg(
        "Reading screen brightness is only supported on Linux.",
    ))
}

#[tauri::command]
pub async fn set_brightness(level: u8) -> JResult<()> {
    let level = level.clamp(1, 100);
    match crate::platform::info().os {
        OsKind::Linux => {
            if !has("brightnessctl") {
                return Err(NovaError::missing(
                    "brightnessctl",
                    "Brightness control needs brightnessctl.",
                ));
            }
            run("brightnessctl", &["set", &format!("{level}%")]).await?;
            Ok(())
        }
        OsKind::Macos => {
            run(
                "osascript",
                &[
                    "-e",
                    &format!(
                "tell application \"System Events\" to set brightness of first display to {}",
                level as f64 / 100.0
            ),
                ],
            )
            .await?;
            Ok(())
        }
        OsKind::Windows => {
            run(
                "powershell",
                &[
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(1,{level})"
                    ),
                ],
            )
            .await?;
            Ok(())
        }
    }
}

/* ── Power ──────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn lock_screen() -> JResult<()> {
    match crate::platform::info().os {
        OsKind::Linux => {
            let tool = first_available(&[
                "loginctl",
                "swaylock",
                "hyprlock",
                "i3lock",
                "gnome-screensaver-command",
            ])
            .ok_or_else(|| {
                NovaError::missing("loginctl", "Locking needs loginctl or a screen locker.")
            })?;

            if tool == "loginctl" {
                run("loginctl", &["lock-session"]).await?;
            } else {
                crate::util::spawn_detached(&tool, &[])?;
            }
        }
        OsKind::Macos => {
            run(
                "osascript",
                &["-e", "tell application \"System Events\" to keystroke \"q\" using {command down, control down}"],
            )
            .await?;
        }
        OsKind::Windows => {
            run("rundll32.exe", &["user32.dll,LockWorkStation"]).await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn sleep_system() -> JResult<()> {
    match crate::platform::info().os {
        OsKind::Linux => {
            run("systemctl", &["suspend"]).await?;
        }
        OsKind::Macos => {
            run("pmset", &["sleepnow"]).await?;
        }
        OsKind::Windows => {
            run("rundll32.exe", &["powrprof.dll,SetSuspendState", "0,1,0"]).await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn shutdown(delay: Option<u32>) -> JResult<()> {
    let mins = delay.unwrap_or(0);
    match crate::platform::info().os {
        OsKind::Linux => {
            run("shutdown", &["-h", &format!("+{mins}")]).await?;
        }
        OsKind::Macos => {
            run(
                "osascript",
                &["-e", "tell application \"System Events\" to shut down"],
            )
            .await?;
        }
        OsKind::Windows => {
            run("shutdown", &["/s", "/t", &(mins * 60).to_string()]).await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn restart(delay: Option<u32>) -> JResult<()> {
    let mins = delay.unwrap_or(0);
    match crate::platform::info().os {
        OsKind::Linux => {
            run("shutdown", &["-r", &format!("+{mins}")]).await?;
        }
        OsKind::Macos => {
            run(
                "osascript",
                &["-e", "tell application \"System Events\" to restart"],
            )
            .await?;
        }
        OsKind::Windows => {
            run("shutdown", &["/r", "/t", &(mins * 60).to_string()]).await?;
        }
    }
    Ok(())
}

/* ── Clipboard ──────────────────────────────────────────────────── */

#[tauri::command]
pub async fn get_clipboard(app: AppHandle) -> JResult<String> {
    app.clipboard()
        .read_text()
        .map_err(|e| NovaError::msg(format!("could not read the clipboard: {e}")))
}

#[tauri::command]
pub async fn set_clipboard(app: AppHandle, text: String) -> JResult<()> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| NovaError::msg(format!("could not write the clipboard: {e}")))
}

#[tauri::command]
pub async fn get_clipboard_history(state: State<'_, AppState>) -> JResult<Vec<String>> {
    Ok(state
        .clipboard_history
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect())
}

#[tauri::command]
pub async fn clear_clipboard_history(state: State<'_, AppState>) -> JResult<()> {
    state.clipboard_history.lock().unwrap().clear();
    Ok(())
}

/* ── Notifications ──────────────────────────────────────────────── */

#[tauri::command]
pub async fn send_notification(app: AppHandle, title: String, body: String) -> JResult<()> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| NovaError::msg(format!("could not show notification: {e}")))
}

/* ── Processes ──────────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub memory: u64,
}

#[tauri::command]
pub async fn list_processes() -> JResult<Vec<ProcessInfo>> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut procs: Vec<ProcessInfo> = sys
        .processes()
        .iter()
        .map(|(pid, p)| ProcessInfo {
            pid: pid.as_u32(),
            name: p.name().to_string_lossy().to_string(),
            cpu: p.cpu_usage(),
            memory: p.memory(),
        })
        .collect();

    // Heaviest first — that is what anyone asking for a process list wants.
    procs.sort_by_key(|p| std::cmp::Reverse(p.memory));
    procs.truncate(100);
    Ok(procs)
}

#[tauri::command]
pub async fn kill_process(target: String) -> JResult<String> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    // Numeric input is a pid; anything else is matched against process names.
    if let Ok(pid) = target.parse::<u32>() {
        let p = sys
            .process(sysinfo::Pid::from_u32(pid))
            .ok_or_else(|| NovaError::msg(format!("no process with pid {pid}")))?;
        let name = p.name().to_string_lossy().to_string();
        if !p.kill() {
            return Err(NovaError::msg(format!("could not kill pid {pid}")));
        }
        return Ok(format!("killed {name} ({pid})"));
    }

    let needle = target.to_lowercase();
    let mut killed = Vec::new();
    for (pid, p) in sys.processes() {
        if p.name().to_string_lossy().to_lowercase().contains(&needle) && p.kill() {
            killed.push(format!("{} ({})", p.name().to_string_lossy(), pid.as_u32()));
        }
    }

    if killed.is_empty() {
        return Err(NovaError::msg(format!("no process matching `{target}`")));
    }
    Ok(format!("killed {}", killed.join(", ")))
}

/* ── Shell ──────────────────────────────────────────────────────── */

/// Run an arbitrary shell command. The safety layer in the frontend gates this
/// behind a confirmation before it is ever reached.
#[tauri::command]
pub async fn run_command(cmd: String) -> JResult<CmdOutput> {
    let mut out = run_shell(&cmd).await?;
    out.stdout = cap_output(&out.stdout, 20_000);
    out.stderr = cap_output(&out.stderr, 8_000);
    Ok(out)
}

/* ── Window/tray helpers ────────────────────────────────────────── */

#[tauri::command]
pub async fn toggle_main_window(app: AppHandle) -> JResult<()> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn show_main_window(app: AppHandle) -> JResult<()> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    Ok(())
}
