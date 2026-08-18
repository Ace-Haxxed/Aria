//! File system commands.
//!
//! Deletion always goes to the OS trash. Permanent deletion is deliberately not
//! exposed as a tool — the safety layer can gate a confirmation, but it cannot
//! bring a file back, and "move to trash" keeps every action reversible.

use crate::util::{cap_output, expand_path, spawn_detached, JResult, AriaError};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Unix millis; 0 when the platform does not report it.
    pub modified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub created: u64,
    pub readonly: bool,
    pub extension: Option<String>,
}

fn modified_millis(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Guard against handing a multi-gigabyte file to the model.
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MODEL_CHARS: usize = 40_000;

#[tauri::command]
pub async fn read_file(path: String) -> JResult<String> {
    let p = expand_path(&path);
    let meta = std::fs::metadata(&p)?;

    if meta.is_dir() {
        return Err(AriaError::msg(format!("`{path}` is a directory")));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(AriaError::msg(format!(
            "`{path}` is {} bytes — too large to read into context. \
             Use search_files or read a specific section instead.",
            meta.len()
        )));
    }

    let bytes = std::fs::read(&p)?;
    // Binary files would otherwise arrive as replacement characters.
    if bytes.contains(&0) {
        return Err(AriaError::msg(format!(
            "`{path}` appears to be a binary file"
        )));
    }
    Ok(cap_output(
        &String::from_utf8_lossy(&bytes),
        MAX_MODEL_CHARS,
    ))
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> JResult<String> {
    let p = expand_path(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&p, content.as_bytes())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn append_file(path: String, content: String) -> JResult<String> {
    let p = expand_path(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)?;
    f.write_all(content.as_bytes())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn copy_file(src: String, dst: String) -> JResult<String> {
    let s = expand_path(&src);
    let d = expand_path(&dst);
    if let Some(parent) = d.parent() {
        std::fs::create_dir_all(parent)?;
    }

    if s.is_dir() {
        copy_dir_recursive(&s, &d)?;
    } else {
        std::fs::copy(&s, &d)?;
    }
    Ok(d.to_string_lossy().to_string())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn move_file(src: String, dst: String) -> JResult<String> {
    let s = expand_path(&src);
    let d = expand_path(&dst);
    if let Some(parent) = d.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // `rename` fails across filesystems; fall back to copy + remove.
    match std::fs::rename(&s, &d) {
        Ok(()) => {}
        Err(_) => {
            if s.is_dir() {
                copy_dir_recursive(&s, &d)?;
                std::fs::remove_dir_all(&s)?;
            } else {
                std::fs::copy(&s, &d)?;
                std::fs::remove_file(&s)?;
            }
        }
    }
    Ok(d.to_string_lossy().to_string())
}

/// Move to the OS trash. The returned path is what an undo would restore.
#[tauri::command]
pub async fn delete_file(path: String) -> JResult<String> {
    let p = expand_path(&path);
    if !p.exists() {
        return Err(AriaError::msg(format!("`{path}` does not exist")));
    }
    trash::delete(&p).map_err(|e| AriaError::msg(format!("could not move to trash: {e}")))?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_directory(path: String) -> JResult<Vec<FileEntry>> {
    let p = expand_path(&path);
    let mut entries = Vec::new();

    for entry in std::fs::read_dir(&p)? {
        let entry = entry?;
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // broken symlink, or raced deletion
        };
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: modified_millis(&meta),
        });
    }

    // Directories first, then alphabetical — matches every file manager.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn create_directory(path: String) -> JResult<String> {
    let p = expand_path(&path);
    std::fs::create_dir_all(&p)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn search_files(query: String, dir: Option<String>) -> JResult<Vec<String>> {
    let root = expand_path(&dir.unwrap_or_else(|| "~".to_string()));
    let needle = query.to_lowercase();
    let mut hits = Vec::new();

    for entry in WalkDir::new(&root)
        .max_depth(8)
        .follow_links(false)
        .into_iter()
        // Skip the directories that would otherwise dominate every result set.
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git" | "node_modules" | "target" | ".cache" | "__pycache__" | ".venv"
            )
        })
        .filter_map(Result::ok)
    {
        if entry
            .file_name()
            .to_string_lossy()
            .to_lowercase()
            .contains(&needle)
        {
            hits.push(entry.path().to_string_lossy().to_string());
            if hits.len() >= 200 {
                break;
            }
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn get_file_info(path: String) -> JResult<FileInfo> {
    let p = expand_path(&path);
    let meta = std::fs::metadata(&p)?;

    Ok(FileInfo {
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        is_dir: meta.is_dir(),
        size: meta.len(),
        modified: modified_millis(&meta),
        created: meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        readonly: meta.permissions().readonly(),
        extension: p.extension().map(|e| e.to_string_lossy().to_string()),
        path: p.to_string_lossy().to_string(),
    })
}

/// Open a path with the user's default application.
#[tauri::command]
pub async fn open_file(path: String) -> JResult<()> {
    let p = expand_path(&path);
    let s = p.to_string_lossy().to_string();

    #[cfg(target_os = "linux")]
    spawn_detached("xdg-open", &[&s])?;
    #[cfg(target_os = "macos")]
    spawn_detached("open", &[&s])?;
    #[cfg(target_os = "windows")]
    spawn_detached("cmd", &["/C", "start", "", &s])?;

    Ok(())
}

#[tauri::command]
pub async fn zip_files(files: Vec<String>, output: String) -> JResult<String> {
    let out_path = expand_path(&output);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = std::fs::File::create(&out_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for f in &files {
        let p = expand_path(f);
        if p.is_dir() {
            // Store directory trees under their own top-level folder name.
            let base = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            for entry in WalkDir::new(&p).into_iter().filter_map(Result::ok) {
                if !entry.file_type().is_file() {
                    continue;
                }
                let rel = entry.path().strip_prefix(&p).unwrap_or(entry.path());
                let name = format!("{base}/{}", rel.to_string_lossy());
                zip.start_file(name, options)
                    .map_err(|e| AriaError::msg(e.to_string()))?;
                let bytes = std::fs::read(entry.path())?;
                zip.write_all(&bytes)?;
            }
        } else {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            zip.start_file(name, options)
                .map_err(|e| AriaError::msg(e.to_string()))?;
            let bytes = std::fs::read(&p)?;
            zip.write_all(&bytes)?;
        }
    }

    zip.finish().map_err(|e| AriaError::msg(e.to_string()))?;
    Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn unzip_file(path: String, dest: String) -> JResult<Vec<String>> {
    let archive_path = expand_path(&path);
    let dest_dir = expand_path(&dest);
    std::fs::create_dir_all(&dest_dir)?;

    let file = std::fs::File::open(&archive_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AriaError::msg(e.to_string()))?;
    let mut written = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AriaError::msg(e.to_string()))?;

        // `enclosed_name` rejects `../` traversal — a zip must never be able to
        // write outside the destination directory.
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest_dir.join(rel);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        std::fs::write(&out_path, &buf)?;
        written.push(out_path.to_string_lossy().to_string());
    }
    Ok(written)
}

/// Restore a trashed file. Backs the `undo` action in the action log.
#[tauri::command]
pub async fn restore_from_trash(original_path: String) -> JResult<String> {
    let p = expand_path(&original_path);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| AriaError::msg("invalid path"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let items = trash::os_limited::list()
            .map_err(|e| AriaError::msg(format!("could not read trash: {e}")))?;

        let item = items
            .into_iter()
            .filter(|i| i.name.to_string_lossy() == name)
            .max_by_key(|i| i.time_deleted)
            .ok_or_else(|| AriaError::msg(format!("`{name}` is not in the trash")))?;

        trash::os_limited::restore_all([item])
            .map_err(|e| AriaError::msg(format!("could not restore: {e}")))?;
        Ok(p.to_string_lossy().to_string())
    }

    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        Err(AriaError::msg(format!(
            "Restoring from the trash is not scriptable on this platform. \
             Open the Trash and restore `{name}` manually."
        )))
    }
}
