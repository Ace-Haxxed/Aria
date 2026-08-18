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
pub enum AriaError {
    #[error("{0}")]
    Msg(String),
    #[error("required tool `{tool}` is not installed. {hint}")]
    MissingTool { tool: String, hint: String },
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl AriaError {
    pub fn msg(s: impl Into<String>) -> Self {
        AriaError::Msg(s.into())
    }

    pub fn missing(tool: &str, hint: &str) -> Self {
        AriaError::MissingTool {
            tool: tool.to_string(),
            hint: hint.to_string(),
        }
    }
}

impl From<anyhow::Error> for AriaError {
    fn from(e: anyhow::Error) -> Self {
        AriaError::Msg(e.to_string())
    }
}

impl serde::Serialize for AriaError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type JResult<T> = Result<T, AriaError>;

/// Default ceiling on any external process ARIA spawns, so a hung helper
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
        // Keep console windows from flashing up behind the UI.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AriaError::missing(program, "See Settings → Setup for install instructions.")
        } else {
            AriaError::Io(e)
        }
    })?;

    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r?,
        Err(_) => {
            return Err(AriaError::msg(format!(
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
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AriaError::missing(program, "See Settings → Voice for install instructions.")
        } else {
            AriaError::Io(e)
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
        .map_err(|_| AriaError::msg(format!("`{program}` timed out")))??;

    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        exit_code: out.status.code().unwrap_or(-1),
    })
}

/// Fire-and-forget spawn: used for launching apps and browsers that should
/// outlive the call and keep running after ARIA returns.
/// The directory ARIA keeps its data in: models, training data, wake-word
/// templates.
///
/// New installs use `~/.aria`. An existing `~/.jarvis` is honoured instead,
/// because that directory holds a multi-gigabyte downloaded model and the
/// recorded wake-word templates — switching paths on an upgrade would strand
/// all of it and silently re-download the model.
pub fn data_dir() -> JResult<std::path::PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| AriaError::msg("ARIA could not locate your home directory."))?;

    let aria = home.join(".aria");
    let legacy = home.join(".jarvis");
    let dir = if aria.exists() || !legacy.exists() { aria } else { legacy };

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
            AriaError::missing(program, "Check that the application is installed.")
        } else {
            AriaError::Io(e)
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
