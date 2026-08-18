//! Conversation, memory and action-log persistence (SQLite via sqlx).

use crate::state::AppState;
use crate::util::{JResult, AriaError};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use tauri::State;

fn db_err(e: sqlx::Error) -> AriaError {
    AriaError::msg(format!("database error: {e}"))
}

/// Open (creating if needed) the database under the app's data directory.
pub async fn init(app_dir: &std::path::Path) -> anyhow::Result<SqlitePool> {
    std::fs::create_dir_all(app_dir)?;
    let path = app_dir.join("aria.db");

    // `mode=rwc` creates the file; without it sqlx errors on first run.
    let url = format!("sqlite:{}?mode=rwc", path.to_string_lossy());
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await?;

    // WAL keeps the UI's reads from blocking on the agent's writes.
    sqlx::query("PRAGMA journal_mode = WAL")
        .execute(&pool)
        .await?;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS conversations (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            summary     TEXT,
            pinned      INTEGER NOT NULL DEFAULT 0
        )"#,
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS messages (
            id              TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            timestamp       INTEGER NOT NULL,
            tool_calls      TEXT,
            tool_call_id    TEXT,
            images          TEXT
        )"#,
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_messages_conversation
         ON messages(conversation_id, timestamp)",
    )
    .execute(&pool)
    .await?;

    // Long-term facts ARIA remembers across sessions.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS memories (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )"#,
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS action_log (
            id          TEXT PRIMARY KEY,
            tool        TEXT NOT NULL,
            args        TEXT NOT NULL,
            risk        TEXT NOT NULL,
            status      TEXT NOT NULL,
            started_at  INTEGER NOT NULL,
            finished_at INTEGER,
            summary     TEXT NOT NULL,
            result      TEXT,
            error       TEXT
        )"#,
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

/* ── Conversations ──────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRow {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub summary: Option<String>,
    pub pinned: bool,
    /// First line of the most recent message, for the history list. A title
    /// alone does not say what a conversation actually got to.
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    /// JSON-encoded; the frontend owns the shape.
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub images: Option<String>,
}

#[tauri::command]
pub async fn db_save_conversation(
    state: State<'_, AppState>,
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    summary: Option<String>,
    pinned: bool,
) -> JResult<()> {
    sqlx::query(
        r#"INSERT INTO conversations (id, title, created_at, updated_at, summary, pinned)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             updated_at = excluded.updated_at,
             summary = excluded.summary,
             pinned = excluded.pinned"#,
    )
    .bind(&id)
    .bind(&title)
    .bind(created_at)
    .bind(updated_at)
    .bind(&summary)
    .bind(pinned as i32)
    .execute(&state.db)
    .await
    .map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn db_list_conversations(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> JResult<Vec<ConversationRow>> {
    let rows = sqlx::query(
        // The preview comes from the newest message rather than the oldest:
        // what a conversation ended on identifies it better than how it opened.
        "SELECT c.id, c.title, c.created_at, c.updated_at, c.summary, c.pinned,
                (SELECT m.content FROM messages m
                  WHERE m.conversation_id = c.id
                  ORDER BY m.timestamp DESC LIMIT 1) AS preview
         FROM conversations c
         ORDER BY c.pinned DESC, c.updated_at DESC
         LIMIT ?1",
    )
    .bind(limit.unwrap_or(100))
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;

    Ok(rows
        .into_iter()
        .map(|r| ConversationRow {
            id: r.get("id"),
            title: r.get("title"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            summary: r.get("summary"),
            preview: r
                .get::<Option<String>, _>("preview")
                .map(|p| p.split('\n').next().unwrap_or("").chars().take(90).collect()),
            pinned: r.get::<i32, _>("pinned") != 0,
        })
        .collect())
}

#[tauri::command]
pub async fn db_get_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> JResult<Vec<MessageRow>> {
    let rows = sqlx::query(
        "SELECT id, role, content, timestamp, tool_calls, tool_call_id, images
         FROM messages WHERE conversation_id = ?1 ORDER BY timestamp ASC",
    )
    .bind(&conversation_id)
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;

    Ok(rows
        .into_iter()
        .map(|r| MessageRow {
            id: r.get("id"),
            role: r.get("role"),
            content: r.get("content"),
            timestamp: r.get("timestamp"),
            tool_calls: r.get("tool_calls"),
            tool_call_id: r.get("tool_call_id"),
            images: r.get("images"),
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn db_save_message(
    state: State<'_, AppState>,
    conversation_id: String,
    id: String,
    role: String,
    content: String,
    timestamp: i64,
    tool_calls: Option<String>,
    tool_call_id: Option<String>,
    images: Option<String>,
) -> JResult<()> {
    sqlx::query(
        r#"INSERT INTO messages
             (id, conversation_id, role, content, timestamp, tool_calls, tool_call_id, images)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(id) DO UPDATE SET
             content = excluded.content,
             tool_calls = excluded.tool_calls"#,
    )
    .bind(&id)
    .bind(&conversation_id)
    .bind(&role)
    .bind(&content)
    .bind(timestamp)
    .bind(&tool_calls)
    .bind(&tool_call_id)
    .bind(&images)
    .execute(&state.db)
    .await
    .map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn db_delete_conversation(state: State<'_, AppState>, id: String) -> JResult<()> {
    // messages cascade via the foreign key
    sqlx::query("DELETE FROM conversations WHERE id = ?1")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn db_search_messages(
    state: State<'_, AppState>,
    query: String,
) -> JResult<Vec<MessageRow>> {
    let rows = sqlx::query(
        "SELECT id, role, content, timestamp, tool_calls, tool_call_id, images
         FROM messages WHERE content LIKE ?1 ORDER BY timestamp DESC LIMIT 50",
    )
    .bind(format!("%{query}%"))
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;

    Ok(rows
        .into_iter()
        .map(|r| MessageRow {
            id: r.get("id"),
            role: r.get("role"),
            content: r.get("content"),
            timestamp: r.get("timestamp"),
            tool_calls: r.get("tool_calls"),
            tool_call_id: r.get("tool_call_id"),
            images: r.get("images"),
        })
        .collect())
}

#[tauri::command]
pub async fn db_clear_history(state: State<'_, AppState>) -> JResult<()> {
    sqlx::query("DELETE FROM conversations")
        .execute(&state.db)
        .await
        .map_err(db_err)?;
    Ok(())
}

/* ── Long-term memory ───────────────────────────────────────────── */

#[tauri::command]
pub async fn memory_set(state: State<'_, AppState>, key: String, value: String) -> JResult<()> {
    sqlx::query(
        "INSERT INTO memories (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(&key)
    .bind(&value)
    .bind(chrono::Utc::now().timestamp_millis())
    .execute(&state.db)
    .await
    .map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn memory_get_all(state: State<'_, AppState>) -> JResult<Vec<(String, String)>> {
    let rows = sqlx::query("SELECT key, value FROM memories ORDER BY updated_at DESC LIMIT 200")
        .fetch_all(&state.db)
        .await
        .map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get("key"), r.get("value")))
        .collect())
}

#[tauri::command]
pub async fn memory_delete(state: State<'_, AppState>, key: String) -> JResult<()> {
    sqlx::query("DELETE FROM memories WHERE key = ?1")
        .bind(&key)
        .execute(&state.db)
        .await
        .map_err(db_err)?;
    Ok(())
}

/* ── Action log ─────────────────────────────────────────────────── */

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn log_action(
    state: State<'_, AppState>,
    id: String,
    tool: String,
    args: String,
    risk: String,
    status: String,
    started_at: i64,
    finished_at: Option<i64>,
    summary: String,
    result: Option<String>,
    error: Option<String>,
) -> JResult<()> {
    sqlx::query(
        r#"INSERT INTO action_log
             (id, tool, args, risk, status, started_at, finished_at, summary, result, error)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             finished_at = excluded.finished_at,
             result = excluded.result,
             error = excluded.error"#,
    )
    .bind(&id)
    .bind(&tool)
    .bind(&args)
    .bind(&risk)
    .bind(&status)
    .bind(started_at)
    .bind(finished_at)
    .bind(&summary)
    .bind(&result)
    .bind(&error)
    .execute(&state.db)
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Full action history as JSON — backs the "Export as JSON" button.
#[tauri::command]
pub async fn export_action_log(state: State<'_, AppState>) -> JResult<String> {
    let rows = sqlx::query(
        "SELECT id, tool, args, risk, status, started_at, finished_at, summary, result, error
         FROM action_log ORDER BY started_at DESC LIMIT 5000",
    )
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;

    let entries: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.get::<String, _>("id"),
                "tool": r.get::<String, _>("tool"),
                "args": r.get::<String, _>("args"),
                "risk": r.get::<String, _>("risk"),
                "status": r.get::<String, _>("status"),
                "startedAt": r.get::<i64, _>("started_at"),
                "finishedAt": r.get::<Option<i64>, _>("finished_at"),
                "summary": r.get::<String, _>("summary"),
                "result": r.get::<Option<String>, _>("result"),
                "error": r.get::<Option<String>, _>("error"),
            })
        })
        .collect();

    serde_json::to_string_pretty(&entries)
        .map_err(|e| AriaError::msg(format!("could not serialise the action log: {e}")))
}
