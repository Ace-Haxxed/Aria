// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// What the command line asked for, once parsed.
enum Invocation {
    /// Launch the window normally.
    Gui,
    /// Launch, and open straight to the API key settings.
    Keys,
    /// Clear `~/.config/nova/` first, then launch.
    Reset,
    /// Launch and drive a scripted set of real prompts through the agent.
    Demo,
    /// Print something and exit without starting a window.
    Print(String),
}

fn parse_args(args: &[String]) -> Invocation {
    match args.iter().map(String::as_str).find(|a| a.starts_with('-')) {
        Some("--version" | "-V" | "-v") => {
            Invocation::Print(format!("nova {}", env!("CARGO_PKG_VERSION")))
        }
        Some("--help" | "-h") => Invocation::Print(
            "NOVA — Neural Operative Virtual Assistant\n\n\
             Usage: nova [options]\n\n\
             Options:\n  \
               (none)       launch NOVA\n  \
               --keys       open directly to the API key settings\n  \
               --demo       launch and run a scripted demo through the real agent\n  \
               --reset      clear ~/.config/nova/ and relaunch\n  \
               --version    print the version and exit\n  \
               --help       show this message"
                .into(),
        ),
        Some("--keys") => Invocation::Keys,
        Some("--demo") => Invocation::Demo,
        Some("--reset") => Invocation::Reset,
        Some(other) => {
            Invocation::Print(format!("nova: unknown option `{other}`\nTry `nova --help`."))
        }
        None => Invocation::Gui,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    match parse_args(&args) {
        Invocation::Print(text) => {
            println!("{text}");
            return;
        }
        Invocation::Reset => {
            // Only the config directory. Conversations, models and training
            // data live elsewhere and are not what "reset my settings" means —
            // deleting a downloaded multi-gigabyte model here would be a
            // nasty surprise.
            match nova_lib::commands::keys::config_dir() {
                Ok(dir) => match std::fs::remove_dir_all(&dir) {
                    Ok(()) => println!("Cleared {}.", dir.display()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        println!("Nothing to clear at {}.", dir.display());
                    }
                    Err(e) => eprintln!("Could not clear {}: {e}", dir.display()),
                },
                Err(e) => eprintln!("Could not locate the config directory: {e}"),
            }
        }
        // The window reads these on start-up. Both are read once, by the
        // process the flag was passed to, so they cannot leak into a later run.
        Invocation::Keys => std::env::set_var("NOVA_OPEN_KEYS", "1"),
        Invocation::Demo => std::env::set_var("NOVA_DEMO", "1"),
        Invocation::Gui => {}
    }

    // Before anything else: GTK and WebKitGTK read their environment once, at
    // initialisation, and Tauri initialises them inside `run()`. Setting these
    // any later has no effect.
    nova_lib::platform::env::prepare();

    nova_lib::run()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Invocation {
        parse_args(&args.iter().map(|s| (*s).to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn no_arguments_launches_the_window() {
        assert!(matches!(parse(&[]), Invocation::Gui));
    }

    #[test]
    fn version_prints_and_exits() {
        let Invocation::Print(text) = parse(&["--version"]) else {
            panic!("--version should print");
        };
        assert!(text.starts_with("nova "));
        assert!(text.contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn keys_reset_and_demo_are_recognised() {
        assert!(matches!(parse(&["--keys"]), Invocation::Keys));
        assert!(matches!(parse(&["--reset"]), Invocation::Reset));
        assert!(matches!(parse(&["--demo"]), Invocation::Demo));
    }

    #[test]
    fn help_lists_every_flag_that_is_accepted() {
        let Invocation::Print(text) = parse(&["--help"]) else {
            panic!("--help should print");
        };
        // A flag that works but is undocumented is a flag nobody finds.
        for flag in ["--keys", "--demo", "--reset", "--version"] {
            assert!(text.contains(flag), "{flag} missing from --help");
        }
    }

    #[test]
    fn an_unknown_flag_explains_itself_rather_than_launching() {
        let Invocation::Print(text) = parse(&["--wat"]) else {
            panic!("an unknown flag must not silently launch the GUI");
        };
        assert!(text.contains("--wat"));
        assert!(text.contains("--help"));
    }

    #[test]
    fn positional_arguments_are_ignored() {
        // Desktop launchers and some shells append arguments of their own;
        // those must not be mistaken for a flag.
        assert!(matches!(parse(&["somefile.txt"]), Invocation::Gui));
    }
}
