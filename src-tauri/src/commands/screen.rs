//! Screen capture. Returns PNG data URLs the frontend can render directly and
//! the vision model can consume without another round trip.

use crate::platform::{self, Region};
use crate::util::{JResult, AriaError};
use base64::Engine;
use std::path::PathBuf;

/// A unique temp file per capture — two concurrent screenshots must not race
/// on the same path.
pub fn temp_capture_path() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "aria-capture-{}-{}.png",
        std::process::id(),
        nanos
    ))
}

/// Crop a PNG in memory. Used when the platform's capture tool cannot restrict
/// the region itself (gnome-screenshot, spectacle).
pub fn crop_png(bytes: &[u8], r: Region) -> JResult<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| AriaError::msg(format!("could not decode screenshot: {e}")))?;

    let (iw, ih) = (img.width() as i32, img.height() as i32);
    // Clamp to the image so an out-of-range region degrades instead of failing.
    let x = r.x.clamp(0, iw.saturating_sub(1)) as u32;
    let y = r.y.clamp(0, ih.saturating_sub(1)) as u32;
    let w = (r.w.max(1) as u32).min(iw as u32 - x);
    let h = (r.h.max(1) as u32).min(ih as u32 - y);

    let cropped = image::imageops::crop_imm(&img, x, y, w, h).to_image();
    let mut out = std::io::Cursor::new(Vec::new());
    cropped
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| AriaError::msg(format!("could not encode screenshot: {e}")))?;
    Ok(out.into_inner())
}

pub fn to_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Downscale so a 4K screenshot doesn't cost tens of thousands of vision tokens.
/// 1568px is the point beyond which the major vision models resample anyway.
fn downscale(bytes: &[u8], max_edge: u32) -> JResult<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| AriaError::msg(format!("could not decode screenshot: {e}")))?;
    if img.width() <= max_edge && img.height() <= max_edge {
        return Ok(bytes.to_vec());
    }
    let resized = img.resize(max_edge, max_edge, image::imageops::FilterType::Triangle);
    let mut out = std::io::Cursor::new(Vec::new());
    resized
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| AriaError::msg(format!("could not encode screenshot: {e}")))?;
    Ok(out.into_inner())
}

#[tauri::command]
pub async fn take_screenshot(region: Option<Region>) -> JResult<String> {
    let bytes = platform::screenshot(region).await?;
    let bytes = downscale(&bytes, 1568)?;
    Ok(to_data_url(&bytes))
}

/// Full-resolution capture written to disk — used by the annotate/record skills
/// and by "save this screenshot" requests. Returns the path.
#[tauri::command]
pub async fn save_screenshot(path: String, region: Option<Region>) -> JResult<String> {
    let bytes = platform::screenshot(region).await?;
    let target = crate::util::expand_path(&path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, &bytes)?;
    Ok(target.to_string_lossy().to_string())
}

/// A full-screen capture as bare base64 PNG.
///
/// `take_screenshot` returns a `data:` URL because that is what an `<img>` and
/// the vision APIs want. This returns the payload alone, for callers that need
/// to hand the bytes to something else.
#[tauri::command]
pub async fn capture_screen() -> JResult<String> {
    use base64::Engine as _;
    let bytes = platform::screenshot(None).await?;
    let bytes = downscale(&bytes, 1568)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// Whether the description was actually located. Check this before acting.
    pub found: bool,
    pub x: i32,
    pub y: i32,
    /// What was matched, or why nothing was.
    pub detail: String,
}

/// Pick the highest-confidence OCR word containing `needle`, and return the
/// centre of its bounding box — the point to click.
///
/// tesseract's TSV columns are: level, page, block, par, line, word, left,
/// top, width, height, conf, text.
fn best_match(tsv: &str, needle: &str) -> Option<(f32, i32, i32, String)> {
    let needle = needle.trim().to_lowercase();
    let mut best: Option<(f32, i32, i32, String)> = None;

    for line in tsv.lines().skip(1) {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 12 {
            continue;
        }
        let text = cols[11].trim();
        if text.is_empty() || !text.to_lowercase().contains(&needle) {
            continue;
        }
        // Below this, tesseract is mostly reporting noise as words.
        let conf: f32 = cols[10].parse().unwrap_or(-1.0);
        if conf < 40.0 {
            continue;
        }
        let (left, top, w, h) = (
            cols[6].parse::<i32>().unwrap_or(0),
            cols[7].parse::<i32>().unwrap_or(0),
            cols[8].parse::<i32>().unwrap_or(0),
            cols[9].parse::<i32>().unwrap_or(0),
        );
        if best.as_ref().is_none_or(|(c, ..)| conf > *c) {
            best = Some((conf, left + w / 2, top + h / 2, text.to_string()));
        }
    }
    best
}

/// Locate on-screen text and return where to click.
///
/// This reads the screen with OCR and matches `description` against the words
/// it finds, so it locates labels, buttons and menu items by their text.
///
/// When nothing matches it reports `found: false` and returns screen centre as
/// a neutral coordinate. It deliberately does **not** report success in that
/// case: an agent with a live mouse that trusts a fabricated hit would click
/// the middle of whatever happens to be open, and a wrong click is not
/// recoverable the way an honest "I could not find it" is.
#[tauri::command]
pub async fn find_on_screen(description: String) -> JResult<Found> {
    let bytes = platform::screenshot(None).await?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| AriaError::msg(format!("could not decode screenshot: {e}")))?;
    let centre = Found {
        found: false,
        x: img.width() as i32 / 2,
        y: img.height() as i32 / 2,
        detail: String::new(),
    };

    if !crate::util::has("tesseract") {
        return Ok(Found {
            detail: "Locating things by description needs `tesseract` installed; \
                     ask ARIA to look at the screen instead."
                .into(),
            ..centre
        });
    }

    let shot = temp_capture_path();
    std::fs::write(&shot, &bytes)?;

    // `--psm 11` finds sparse text anywhere on the image, which is what a
    // desktop is: scattered labels rather than a page of prose.
    let out = tokio::process::Command::new("tesseract")
        .args([&shot.to_string_lossy(), "stdout", "--psm", "11", "tsv"])
        .output()
        .await;
    let _ = std::fs::remove_file(&shot);

    let Ok(out) = out else {
        return Ok(Found { detail: "Could not run tesseract.".into(), ..centre });
    };

    // tesseract exits 0 even when it cannot load its language data, so the
    // only signal is on stderr. Without this the caller is told "no match",
    // which sends them looking at the screen instead of at their packages.
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("Failed loading language") || stderr.contains("couldn't load any languages")
    {
        return Ok(Found {
            detail: "tesseract is installed but has no language data — install \
                     `tesseract-data-eng` to locate things by their text."
                .into(),
            ..centre
        });
    }

    let tsv = String::from_utf8_lossy(&out.stdout);

    let best = best_match(&tsv, &description);

    Ok(match best {
        Some((conf, x, y, text)) => Found {
            found: true,
            x,
            y,
            detail: format!("matched \"{text}\" ({conf:.0}% confidence)"),
        },
        None => Found {
            detail: format!("No on-screen text matching \"{description}\"."),
            ..centre
        },
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSize {
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn get_screen_size() -> JResult<ScreenSize> {
    let bytes = platform::screenshot(None).await?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| AriaError::msg(format!("could not decode screenshot: {e}")))?;
    Ok(ScreenSize {
        width: img.width(),
        height: img.height(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real tesseract output for a label at left=60 top=60 width=32 height=13,
    /// captured from a generated test image. The click point must be the
    /// centre of that box.
    const TSV: &str = "level\tpage\tblock\tpar\tline\tword\tleft\ttop\twidth\theight\tconf\ttext\n\
5\t1\t1\t1\t1\t1\t60\t60\t32\t13\t74\tCancel\n\
5\t1\t2\t1\t1\t1\t350\t198\t28\t12\t91\tSave\n";

    #[test]
    fn the_click_point_is_the_centre_of_the_word() {
        let (conf, x, y, text) = best_match(TSV, "cancel").unwrap();
        assert_eq!((x, y), (76, 66));
        assert_eq!(text, "Cancel");
        assert_eq!(conf, 74.0);
    }

    #[test]
    fn matching_ignores_case_and_allows_substrings() {
        assert!(best_match(TSV, "SAVE").is_some());
        assert!(best_match(TSV, "anc").is_some());
    }

    #[test]
    fn nothing_matching_finds_nothing() {
        // The caller must be told it failed rather than handed a coordinate.
        assert!(best_match(TSV, "Delete").is_none());
    }

    #[test]
    fn low_confidence_rows_are_noise_and_are_dropped() {
        let junk = "l\tp\tb\tr\tl\tw\tleft\ttop\tw\th\tconf\ttext\n\
5\t1\t1\t1\t1\t1\t10\t10\t5\t5\t12\tSave\n";
        assert!(best_match(junk, "save").is_none());
    }

    #[test]
    fn a_malformed_row_does_not_panic() {
        assert!(best_match("header\nnot\tenough\tcolumns\n", "x").is_none());
    }
}
