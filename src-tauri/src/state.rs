//! Process-wide state shared by the command handlers.

use sqlx::SqlitePool;
use std::collections::VecDeque;
use std::sync::Mutex;

/// The clipboard history depth promised in the UI.
pub const CLIPBOARD_HISTORY_LIMIT: usize = 50;

pub struct AppState {
    /// Most-recent-first ring of clipboard entries, filled by the poller in `lib.rs`.
    pub clipboard_history: Mutex<VecDeque<String>>,
    /// PID of the browser NOVA launched, so it can be cleaned up on exit.
    pub browser_pid: Mutex<Option<u32>>,
    pub db: SqlitePool,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        Self {
            clipboard_history: Mutex::new(VecDeque::with_capacity(CLIPBOARD_HISTORY_LIMIT)),
            browser_pid: Mutex::new(None),
            db,
        }
    }

    /// Record a clipboard entry, ignoring repeats of the current head.
    pub fn push_clipboard(&self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        let mut history = self.clipboard_history.lock().unwrap();
        if history.front().is_some_and(|f| *f == text) {
            return;
        }
        // Re-copying an older entry should promote it, not duplicate it.
        if let Some(pos) = history.iter().position(|e| *e == text) {
            history.remove(pos);
        }
        history.push_front(text);
        while history.len() > CLIPBOARD_HISTORY_LIMIT {
            history.pop_back();
        }
    }
}
