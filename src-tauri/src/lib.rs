//! ARIA desktop backend.

pub mod commands;
pub mod platform;
pub mod state;
pub mod tray;
pub mod util;

use state::AppState;
use std::str::FromStr;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use util::JResult;

/// Hotkey ids the frontend listens for. Kept in sync with `HotkeyConfig` in TS.
const HOTKEY_ACTIONS: [&str; 4] = ["toggleWindow", "pushToTalk", "screenshotAsk", "cancel"];

/// Alternatives to try when the user's chosen combination is unavailable.
///
/// A global shortcut is a shared resource: the desktop environment, an IME, or
/// another application may already own it, and there is no way to know before
/// asking. Rather than leaving the action unreachable, each one has a short
/// list of fallbacks that are unlikely to collide.
fn fallbacks_for(action: &str) -> &'static [&'static str] {
    match action {
        "toggleWindow" => &["CmdOrCtrl+Shift+J", "CmdOrCtrl+Alt+J", "Alt+Shift+J"],
        "pushToTalk" => &["CmdOrCtrl+Shift+K", "CmdOrCtrl+Alt+K", "Alt+Shift+K"],
        "screenshotAsk" => &["CmdOrCtrl+Shift+U", "CmdOrCtrl+Alt+U", "Alt+Shift+U"],
        "cancel" => &["CmdOrCtrl+Shift+Escape", "CmdOrCtrl+Alt+Escape"],
        _ => &[],
    }
}

/// What happened to one shortcut.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutOutcome {
    pub action: String,
    /// The combination actually registered, which may be a fallback.
    pub accelerator: String,
    /// What the user asked for, when it differs from what was registered.
    pub requested: String,
    pub registered: bool,
    /// Set when nothing could be registered: why, in plain language.
    pub problem: Option<String>,
}

/// Try one combination. `Ok` means it is now live.
fn try_register(
    manager: &tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>,
    action: &str,
    accelerator: &str,
) -> Result<(), String> {
    let shortcut = Shortcut::from_str(accelerator)
        .map_err(|e| format!("`{accelerator}` is not a valid shortcut ({e})"))?;

    let action = action.to_string();
    manager
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            // Fire on press only; otherwise every hotkey triggers twice.
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit("aria://hotkey", action.clone());
            }
        })
        .map_err(|e| format!("`{accelerator}` is unavailable ({e})"))
}

/// Register the user's hotkeys, replacing any previously registered set.
///
/// Each shortcut is registered independently and its outcome reported. This
/// matters: previously the first conflict aborted the whole loop with `?`, so
/// one combination taken by the desktop environment left every *other*
/// shortcut unregistered too — and the error named none of them.
#[tauri::command]
async fn register_hotkeys(
    app: tauri::AppHandle,
    bindings: Vec<(String, String)>,
) -> JResult<Vec<ShortcutOutcome>> {
    let manager = app.global_shortcut();

    // Wholesale replace: partial updates would strand old bindings.
    let _ = manager.unregister_all();

    let mut outcomes = Vec::new();

    for (action, accelerator) in bindings {
        if !HOTKEY_ACTIONS.contains(&action.as_str()) {
            continue;
        }
        let requested = accelerator.trim().to_string();
        if requested.is_empty() {
            continue;
        }

        // The user's choice first, then the fallbacks, stopping at the first
        // that takes.
        let mut attempts: Vec<String> = vec![requested.clone()];
        attempts.extend(
            fallbacks_for(&action)
                .iter()
                .map(|s| (*s).to_string())
                .filter(|f| *f != requested),
        );

        let mut reasons: Vec<String> = Vec::new();
        let mut outcome = ShortcutOutcome {
            action: action.clone(),
            accelerator: String::new(),
            requested: requested.clone(),
            registered: false,
            problem: None,
        };

        for candidate in attempts {
            match try_register(&manager, &action, &candidate) {
                Ok(()) => {
                    outcome.accelerator = candidate;
                    outcome.registered = true;
                    break;
                }
                Err(reason) => reasons.push(reason),
            }
        }

        if !outcome.registered {
            // Every reason, so the log says which combinations were tried and
            // what each one said — "some shortcuts failed" is not diagnosable.
            outcome.problem = Some(reasons.join("; "));
        }

        outcomes.push(outcome);
    }

    Ok(outcomes)
}

#[tauri::command]
async fn unregister_hotkeys(app: tauri::AppHandle) -> JResult<()> {
    let _ = app.global_shortcut().unregister_all();
    Ok(())
}

/// Toggle the tray between working and resting.
///
/// Kept for the agent's busy/idle bracket; finer states go through
/// `set_tray_state`.
#[tauri::command]
async fn set_tray_active(app: tauri::AppHandle, active: bool) -> JResult<()> {
    tray::set_state(
        &app,
        if active {
            tray::TrayState::Acting
        } else {
            tray::TrayState::Idle
        },
    );
    Ok(())
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open ARIA", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, "mute", "Mute microphone", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &mute, &settings, &sep, &quit])?;

    TrayIconBuilder::with_id("aria-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("ARIA")
        .menu(&menu)
        // Left click toggles the window, so the menu must not steal it.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "mute" => {
                let _ = app.emit("aria://tray", "mute");
            }
            "settings" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit("aria://tray", "settings");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Watch the clipboard so the history panel has something to show.
///
/// No desktop platform offers a portable clipboard-change notification, so
/// polling is the only option; 800ms is frequent enough to catch a copy before
/// the user switches windows, and cheap enough to be invisible.
fn spawn_clipboard_poller(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;

            let Ok(text) = app.clipboard().read_text() else {
                continue; // clipboard holds an image, or is momentarily locked
            };
            if text == last || text.trim().is_empty() {
                continue;
            }
            last = text.clone();

            if let Some(state) = app.try_state::<AppState>() {
                state.push_clipboard(text);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("aria"));

            // The database has to exist before any command can run, so this is
            // one of the few places a blocking call in setup is correct.
            let pool = tauri::async_runtime::block_on(commands::db::init(&data_dir))
                .map_err(|e| format!("could not open the database: {e}"))?;
            app.manage(AppState::new(pool));

            // Read the key file before the window exists. It is a few hundred
            // bytes, and doing it here means the first message never waits on
            // disk — the frontend finds the keys already in memory.
            commands::keys::load();

            build_tray(app)?;
            spawn_clipboard_poller(app.handle().clone());

            // Warm the platform probe so the first tool call isn't slowed by it.
            let _ = platform::info();

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides to tray instead of quitting — the tray
            // menu's Quit is the only way out, which is what a resident
            // assistant should do.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                let _ = window.app_handle().emit("aria://window", "hidden");
            }
        })
        .invoke_handler(tauri::generate_handler![
            // platform
            commands::get_platform_info,
            commands::check_dependencies,
            commands::install_dependency,
            // screen
            commands::screen::take_screenshot,
            commands::screen::save_screenshot,
            commands::screen::get_screen_size,
            commands::screen::capture_screen,
            commands::screen::find_on_screen,
            // mouse
            commands::mouse::move_mouse,
            commands::mouse::click,
            commands::mouse::double_click,
            commands::mouse::right_click,
            commands::mouse::drag,
            commands::mouse::scroll,
            commands::mouse::click_mouse,
            commands::mouse::get_mouse_position,
            // keyboard
            commands::keyboard::type_text,
            commands::keyboard::press_key,
            commands::keyboard::hold_key,
            commands::keyboard::release_key,
            commands::keyboard::hotkey,
            // windows
            commands::windows::list_windows,
            commands::windows::focus_window,
            commands::windows::move_window,
            commands::windows::resize_window,
            commands::windows::close_window,
            commands::windows::minimize_window,
            commands::windows::maximize_window,
            commands::windows::get_active_window,
            // files
            commands::files::read_file,
            commands::files::write_file,
            commands::files::append_file,
            commands::files::copy_file,
            commands::files::move_file,
            commands::files::delete_file,
            commands::files::list_directory,
            commands::files::create_directory,
            commands::files::search_files,
            commands::files::get_file_info,
            commands::files::open_file,
            commands::files::zip_files,
            commands::files::unzip_file,
            commands::files::restore_from_trash,
            // apps
            commands::apps::launch_app,
            commands::apps::kill_app,
            commands::apps::list_running_apps,
            commands::apps::is_app_running,
            // system
            commands::system::get_system_info,
            commands::system::get_volume,
            commands::system::set_volume,
            commands::system::mute,
            commands::system::unmute,
            commands::system::get_brightness,
            commands::system::set_brightness,
            commands::system::lock_screen,
            commands::system::sleep_system,
            commands::system::shutdown,
            commands::system::restart,
            commands::system::get_clipboard,
            commands::system::set_clipboard,
            commands::system::get_clipboard_history,
            commands::system::clear_clipboard_history,
            commands::system::send_notification,
            commands::system::run_command,
            commands::system::list_processes,
            commands::system::kill_process,
            commands::system::toggle_main_window,
            commands::system::show_main_window,
            // browser
            commands::browser::open_url,
            commands::browser::get_current_url,
            commands::browser::get_page_title,
            commands::browser::get_page_text,
            commands::browser::take_page_screenshot,
            commands::browser::click_element,
            commands::browser::type_in_element,
            commands::browser::scroll_page,
            commands::browser::go_back,
            commands::browser::go_forward,
            commands::browser::reload_page,
            commands::browser::new_tab,
            commands::browser::close_tab,
            commands::browser::list_tabs,
            commands::browser::switch_tab,
            commands::browser::wait_for_element,
            commands::browser::execute_js,
            commands::browser::fill_form,
            commands::browser::download_file,
            // LLM transport — every provider call leaves from Rust, not the webview
            commands::llm::ollama_chat,
            commands::llm::groq_chat,
            commands::llm::openai_chat,
            commands::llm::anthropic_chat,
            commands::llm::gemini_chat,
            commands::llm::llm_cancel,
            commands::llm::http_request,
            commands::keys::open_keys_requested,
            commands::keys::demo_script,
            commands::keys::openrouter_free_models,
            commands::keys::reconcile_openrouter_model,
            commands::keys::key_config,
            commands::keys::set_key,
            commands::keys::set_active_provider,
            commands::keys::set_active_model,
            commands::keys::reset_key_config,
            commands::keys::validate_key,
            commands::llm::validate_api_key,
            commands::llm::bytez_auth_style,
            // built-in model: runs in this process, no server, no network
            commands::builtin::builtin_status,
            commands::builtin::builtin_load_model,
            commands::builtin::builtin_unload_model,
            commands::builtin::builtin_chat,
            commands::builtin::builtin_cancel,
            commands::builtin::detect_acceleration,
            commands::models::list_builtin_models,
            commands::models::download_builtin_model,
            commands::models::cancel_model_download,
            commands::models::delete_builtin_model,
            // wake word: always-on local listener, no model file, no network
            tray::set_tray_state,
            commands::wakeword::start_wake_word,
            commands::wakeword::stop_wake_word,
            commands::wakeword::set_wake_word_sensitivity,
            commands::wakeword::wake_word_status,
            commands::wakeword::train_wake_word,
            // ollama lifecycle
            commands::gpu::check_gpu,
            commands::ollama::check_ollama,
            commands::ollama::warmup_model,
            commands::ollama::check_ollama_and_start,
            commands::ollama::install_ollama,
            commands::ollama::ollama_has_model,
            commands::ollama::test_ollama_endpoint,
            commands::ollama::ollama_pull,
            // linux packages / services
            commands::linux::install_package,
            commands::linux::remove_package,
            commands::linux::list_installed_packages,
            commands::linux::update_system,
            commands::linux::manage_service,
            // microphone (cpal — never the webview, see commands::audio)
            commands::audio::test_microphone,
            commands::audio::start_capture,
            commands::audio::stop_capture,
            commands::audio::is_capturing,
            // voice
            commands::voice::voice_status,
            commands::voice::transcribe,
            commands::voice::synthesize,
            commands::voice::speak_native,
            // fine-tuning, via the Python sidecar
            commands::finetune::check_finetune_support,
            commands::finetune::start_finetuning,
            commands::finetune::cancel_finetuning,
            commands::finetune::list_adapters,
            commands::finetune::delete_adapter,
            // training data for a future local fine-tune
            commands::training::training_append,
            commands::training::training_stats,
            commands::training::training_rate,
            commands::training::training_export,
            commands::training::training_clear,
            // secrets
            commands::secrets::set_api_key,
            commands::secrets::get_api_key,
            commands::secrets::delete_api_key,
            commands::secrets::list_configured_providers,
            // persistence
            commands::db::db_save_conversation,
            commands::db::db_list_conversations,
            commands::db::db_get_messages,
            commands::db::db_save_message,
            commands::db::db_delete_conversation,
            commands::db::db_search_messages,
            commands::db::db_clear_history,
            commands::db::memory_set,
            commands::db::memory_get_all,
            commands::db::memory_delete,
            commands::db::log_action,
            commands::db::export_action_log,
            // app shell
            register_hotkeys,
            unregister_hotkeys,
            set_tray_active,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ARIA");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_action_has_fallbacks() {
        // A global shortcut is a shared resource; without alternatives, one
        // conflict leaves the action permanently unreachable.
        for action in HOTKEY_ACTIONS {
            assert!(
                !fallbacks_for(action).is_empty(),
                "{action} has no fallback combinations"
            );
        }
    }

    #[test]
    fn fallbacks_do_not_collide_between_actions() {
        // Two actions falling back onto the same keys would mean the second
        // registration fails for a reason we caused ourselves.
        let mut seen: Vec<&str> = Vec::new();
        for action in HOTKEY_ACTIONS {
            for candidate in fallbacks_for(action) {
                assert!(
                    !seen.contains(candidate),
                    "{candidate} is a fallback for two different actions"
                );
                seen.push(candidate);
            }
        }
    }

    #[test]
    fn fallbacks_are_parseable_accelerators() {
        // An unparseable fallback would be tried and rejected at runtime,
        // silently costing the action one of its chances.
        for action in HOTKEY_ACTIONS {
            for candidate in fallbacks_for(action) {
                assert!(
                    Shortcut::from_str(candidate).is_ok(),
                    "{candidate} is not a valid accelerator"
                );
            }
        }
    }

    #[test]
    fn an_unknown_action_has_no_fallbacks() {
        assert!(fallbacks_for("not-an-action").is_empty());
    }
}
