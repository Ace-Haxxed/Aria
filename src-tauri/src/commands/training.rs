//! Local capture of conversation pairs, for fine-tuning a local model later.
//!
//! The premise of the feature: a user who runs on a cloud model can have their
//! own exchanges recorded so a local model can be trained on them later. That
//! only makes sense if the data never leaves the machine, so this writes to a
//! plain file under the user's home directory — no database, no upload, and a
//! format any training script can read.
//!
//! JSONL is used because it appends in constant time and survives truncation:
//! if the app is killed mid-write, every complete line before it is still
//! valid, which a single large JSON array would not be.

use crate::util::{JResult, AriaError};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

/// One exchange, in the shape a fine-tuning script expects.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainingRecord {
    pub id: String,
    pub timestamp: String,
    pub user: String,
    pub assistant: String,
    pub model_used: String,
    /// `null` until the user rates it: 1 for a thumbs up, 0 for a thumbs down.
    pub quality_score: Option<u8>,
    /// What the user said was wrong, when they gave a thumbs down.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Roughly the number of examples below which a fine-tune is not worth running.
/// Shown as a target so the progress bar means something.
const TARGET_PAIRS: usize = 1_000;

fn training_dir() -> JResult<PathBuf> {
    crate::util::data_subdir("training_data")
}

pub fn dataset_path() -> JResult<PathBuf> {
    Ok(training_dir()?.join("conversations.jsonl"))
}

fn read_all() -> JResult<Vec<TrainingRecord>> {
    let path = dataset_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)?;
    Ok(content
        .lines()
        .filter(|l| !l.trim().is_empty())
        // A line that fails to parse is skipped rather than fatal: one corrupt
        // record must not make the whole dataset unreadable.
        .filter_map(|l| serde_json::from_str::<TrainingRecord>(l).ok())
        .collect())
}

fn write_all(records: &[TrainingRecord]) -> JResult<()> {
    let path = dataset_path()?;
    let mut out = String::new();
    for record in records {
        out.push_str(&serde_json::to_string(record).map_err(|e| AriaError::msg(e.to_string()))?);
        out.push('\n');
    }
    // Write beside the target and rename, so an interrupted rewrite cannot
    // leave the dataset half-written.
    let temp = path.with_extension("jsonl.tmp");
    std::fs::write(&temp, out)?;
    std::fs::rename(&temp, &path)?;
    Ok(())
}

/// Append one exchange. Called after every assistant reply when the user has
/// turned capture on.
#[tauri::command]
pub async fn training_append(record: TrainingRecord) -> JResult<()> {
    // Empty halves teach a model nothing and would dilute the set.
    if record.user.trim().is_empty() || record.assistant.trim().is_empty() {
        return Ok(());
    }

    let path = dataset_path()?;
    let line = serde_json::to_string(&record).map_err(|e| AriaError::msg(e.to_string()))?;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingStats {
    pub count: usize,
    pub rated_good: usize,
    pub rated_bad: usize,
    pub target: usize,
    /// 0-100 progress toward a useful fine-tune.
    pub percent: f64,
    pub ready: bool,
    pub path: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub async fn training_stats() -> JResult<TrainingStats> {
    let records = read_all()?;
    let path = dataset_path()?;
    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    let count = records.len();
    Ok(TrainingStats {
        rated_good: records.iter().filter(|r| r.quality_score == Some(1)).count(),
        rated_bad: records.iter().filter(|r| r.quality_score == Some(0)).count(),
        percent: (count as f64 / TARGET_PAIRS as f64 * 100.0).clamp(0.0, 100.0),
        ready: count >= TARGET_PAIRS,
        count,
        target: TARGET_PAIRS,
        path: path.to_string_lossy().to_string(),
        size_bytes,
    })
}

/// Attach a rating to an exchange the user has judged.
#[tauri::command]
pub async fn training_rate(id: String, score: u8, note: Option<String>) -> JResult<()> {
    let mut records = read_all()?;
    let Some(record) = records.iter_mut().find(|r| r.id == id) else {
        // The exchange was never captured — capture may have been off when it
        // happened. Rating it is a no-op rather than an error the user sees.
        return Ok(());
    };

    record.quality_score = Some(if score > 0 { 1 } else { 0 });
    record.note = note.filter(|n| !n.trim().is_empty());
    write_all(&records)
}

/// Copy the dataset somewhere the user chose.
#[tauri::command]
pub async fn training_export(destination: String) -> JResult<String> {
    let source = dataset_path()?;
    if !source.exists() {
        return Err(AriaError::msg(
            "There is nothing to export yet — no conversations have been saved.",
        ));
    }

    let target = crate::util::expand_path(&destination);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(&source, &target)?;
    Ok(target.to_string_lossy().to_string())
}

/// Delete everything captured so far.
#[tauri::command]
pub async fn training_clear() -> JResult<()> {
    let path = dataset_path()?;
    if path.exists() {
        // To the trash, not unlinked: this is the user's data and a mis-click
        // should be recoverable.
        trash::delete(&path).map_err(|e| {
            AriaError::msg(format!("Could not remove the training data: {e}"))
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, score: Option<u8>) -> TrainingRecord {
        TrainingRecord {
            id: id.into(),
            timestamp: "2026-08-13T00:00:00Z".into(),
            user: "hello".into(),
            assistant: "hi".into(),
            model_used: "llama-3.3-70b-groq".into(),
            quality_score: score,
            note: None,
        }
    }

    #[test]
    fn records_round_trip_through_jsonl() {
        let line = serde_json::to_string(&record("a", Some(1))).unwrap();
        assert!(!line.contains('\n'), "a record must occupy exactly one line");
        let back: TrainingRecord = serde_json::from_str(&line).unwrap();
        assert_eq!(back.id, "a");
        assert_eq!(back.quality_score, Some(1));
    }

    #[test]
    fn an_unrated_record_serialises_score_as_null() {
        let line = serde_json::to_string(&record("a", None)).unwrap();
        assert!(line.contains("\"quality_score\":null"), "{line}");
        // `note` is absent rather than null when unset, so the file stays tidy.
        assert!(!line.contains("note"), "{line}");
    }

    #[test]
    fn a_corrupt_line_does_not_lose_the_rest() {
        let good = serde_json::to_string(&record("a", None)).unwrap();
        let content = format!("{good}\nnot json at all\n{good}\n");
        let parsed: Vec<TrainingRecord> = content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        assert_eq!(parsed.len(), 2, "the valid records should survive");
    }
}
