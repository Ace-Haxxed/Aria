//! Small helpers shared by every command module.

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

/// Result of running an external process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CmdOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl CmdOutput {
    pub fn ok(&self) -> bool {
        self.exit_code == 0
    }

    /// stdout with trailing newline stripped — what most callers actually want.
    pub fn trimmed(&self) -> &str {
        self.stdout.trim_end_matches(['\n', '\r'])
    }
}

/// Anything that can go wrong inside a Tauri command.
///
/// Tauri needs command errors to be serialisable; `anyhow::Error` is not, so
/// everything funnels through here and reaches the frontend as a plain string.
#[derive(Debug, thiserror::Error)]
pub enum NovaError {
    #[error("{0}")]
    Msg(String),
    #[error("required tool `{tool}` is not installed. {hint}")]
    MissingTool { tool: String, hint: String },
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl NovaError {
    pub fn msg(s: impl Into<String>) -> Self {
        NovaError::Msg(s.into())
    }

    pub fn missing(tool: &str, hint: &str) -> Self {
        NovaError::MissingTool {
            tool: tool.to_string(),
            hint: hint.to_string(),
        }
    }
}

impl From<anyhow::Error> for NovaError {
    fn from(e: anyhow::Error) -> Self {
        NovaError::Msg(e.to_string())
    }
}

impl serde::Serialize for NovaError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type JResult<T> = Result<T, NovaError>;

/// Default ceiling on any external process NOVA spawns, so a hung helper
/// (a `pacman` waiting on a lock, say) can never wedge the agent loop.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Run a program with arguments and capture its output.
pub async fn run(program: &str, args: &[&str]) -> JResult<CmdOutput> {
    run_with_timeout(program, args, DEFAULT_TIMEOUT).await
}

pub async fn run_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> JResult<CmdOutput> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        // Keep console windows from flashing up behind the UI. No
        // `CommandExt` import here: this is a tokio Command, which carries
        // `creation_flags` inherently, and importing the trait as well is an
        // unused import that fails the build under -D warnings.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            NovaError::missing(program, "See Settings → Setup for install instructions.")
        } else {
            NovaError::Io(e)
        }
    })?;

    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r?,
        Err(_) => {
            return Err(NovaError::msg(format!(
                "`{program}` timed out after {}s",
                timeout.as_secs()
            )))
        }
    };

    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        exit_code: out.status.code().unwrap_or(-1),
    })
}

/// Same as [`run`] but takes owned arguments, for callers that build the
/// argument list dynamically.
pub async fn run_owned(program: &str, args: &[String]) -> JResult<CmdOutput> {
    let borrowed: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run(program, &borrowed).await
}

/// Run a command through the platform shell. Used only by `run_command`, which
/// sits behind a confirmation prompt in the safety layer.
pub async fn run_shell(command: &str) -> JResult<CmdOutput> {
    #[cfg(target_os = "windows")]
    {
        run(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", command],
        )
        .await
    }
    #[cfg(not(target_os = "windows"))]
    {
        run("sh", &["-c", command]).await
    }
}

/// Run a program, feeding `input` to its stdin. Needed by piper, which reads
/// the text to speak from standard input.
pub async fn run_with_stdin(program: &str, args: &[String], input: &str) -> JResult<CmdOutput> {
    use tokio::io::AsyncWriteExt;

    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        // Tokio's Command again — inherent `creation_flags`, no trait import.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            NovaError::missing(program, "See Settings → Voice for install instructions.")
        } else {
            NovaError::Io(e)
        }
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).await?;
        // Dropping the handle closes the pipe, which is how the child knows the
        // input has ended — without this piper waits forever.
        drop(stdin);
    }

    let out = tokio::time::timeout(DEFAULT_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| NovaError::msg(format!("`{program}` timed out")))??;

    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        exit_code: out.status.code().unwrap_or(-1),
    })
}

/// Fire-and-forget spawn: used for launching apps and browsers that should
/// outlive the call and keep running after NOVA returns.
/// The directory NOVA keeps its data in: models, training data, wake-word
/// templates.
///
/// New installs use `~/.nova`. An existing `~/.jarvis` is honoured instead,
/// because that directory holds a multi-gigabyte downloaded model and the
/// recorded wake-word templates — switching paths on an upgrade would strand
/// all of it and silently re-download the model.
pub fn data_dir() -> JResult<std::path::PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| NovaError::msg("NOVA could not locate your home directory."))?;

    let nova = home.join(".nova");
    let legacy = home.join(".jarvis");
    let dir = if nova.exists() || !legacy.exists() { nova } else { legacy };

    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// A named subdirectory of [`data_dir`], created if absent.
pub fn data_subdir(name: &str) -> JResult<std::path::PathBuf> {
    let dir = data_dir()?.join(name);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn spawn_detached(program: &str, args: &[&str]) -> JResult<u32> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            NovaError::missing(program, "Check that the application is installed.")
        } else {
            NovaError::Io(e)
        }
    })?;
    Ok(child.id())
}

/// Is this binary on PATH?
pub fn has(tool: &str) -> bool {
    which::which(tool).is_ok()
}

/// Return the first tool from `candidates` that exists on PATH.
pub fn first_available(candidates: &[&str]) -> Option<String> {
    candidates.iter().find(|t| has(t)).map(|t| (*t).to_string())
}

/// Expand a leading `~` and any `$VAR` references in a user-supplied path.
pub fn expand_path(path: &str) -> std::path::PathBuf {
    let mut s = path.to_string();

    if s == "~" || s.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            s = s.replacen('~', &home.to_string_lossy(), 1);
        }
    }

    // Resolve $VAR / ${VAR} against the process environment.
    while let Some(start) = s.find('$') {
        let rest = &s[start + 1..];
        let (name, len) = if let Some(stripped) = rest.strip_prefix('{') {
            match stripped.find('}') {
                Some(end) => (stripped[..end].to_string(), end + 3),
                None => break,
            }
        } else {
            let end = rest
                .find(|c: char| !c.is_alphanumeric() && c != '_')
                .unwrap_or(rest.len());
            if end == 0 {
                break;
            }
            (rest[..end].to_string(), end + 1)
        };

        let value = std::env::var(&name).unwrap_or_default();
        s.replace_range(start..start + len, &value);
    }

    std::path::PathBuf::from(s)
}

/// Truncate long tool output so a single `cat` of a large file can't blow the
/// model's context window.
pub fn cap_output(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n… [truncated, {} of {} bytes shown]",
        &s[..end],
        end,
        s.len()
    )
}

/// Copy application data written under a previous bundle identifier.
///
/// Tauri derives the app-data directory from `identifier` in `tauri.conf.json`,
/// so renaming the app moves it. Everything the user has — settings, the
/// conversation database, the action log — is suddenly at a path nothing reads,
/// and the app looks freshly installed.
///
/// This copies the newest previous directory across once, on first launch under
/// the new name. It never overwrites: if the new directory already has content,
/// the migration has happened (or the user has started fresh deliberately) and
/// is skipped.
pub fn adopt_previous_app_data(current: &std::path::Path) {
    // Already populated: nothing to do, and nothing may be clobbered.
    if current.read_dir().map(|mut d| d.next().is_some()).unwrap_or(false) {
        return;
    }

    let Some(parent) = current.parent() else {
        return;
    };
    // Newest first, so an upgrade from two names back does not lose the more
    // recent of the two.
    let previous = ["ai.aria.assistant", "ai.jarvis.assistant"]
        .iter()
        .map(|name| parent.join(name))
        .find(|p| p.is_dir());

    let Some(previous) = previous else {
        return;
    };
    if std::fs::create_dir_all(current).is_err() {
        return;
    }
    let _ = copy_tree(&previous, current);
}

/// Recursive copy that skips anything it cannot read.
///
/// A migration is best-effort by nature: one unreadable file should move the
/// rest, not abort and leave the user with half a profile and no explanation.
fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(from)? {
        let Ok(entry) = entry else { continue };
        let target = to.join(entry.file_name());
        let Ok(kind) = entry.file_type() else { continue };

        if kind.is_dir() {
            if std::fs::create_dir_all(&target).is_ok() {
                let _ = copy_tree(&entry.path(), &target);
            }
        } else if kind.is_file() && !target.exists() {
            let _ = std::fs::copy(entry.path(), &target);
        }
    }
    Ok(())
}
