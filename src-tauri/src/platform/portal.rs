//! Screen capture through xdg-desktop-portal.
//!
//! This is the only capture route that works on GNOME Wayland, and it is worth
//! being precise about why, because the two obvious alternatives both fail:
//!
//! * `grim` speaks `wlr-screencopy`, a wlroots protocol. GNOME's compositor
//!   does not implement it and answers "compositor doesn't support the screen
//!   capture protocol".
//! * `org.gnome.Shell.Screenshot` — the D-Bus interface `gnome-screenshot`
//!   itself used to call — has been restricted since GNOME 41. On a current
//!   GNOME it answers `AccessDenied: Screenshot is not allowed` to every
//!   caller outside the Shell, including gnome-screenshot, so it cannot be the
//!   primary path. It is still tried first on older GNOME, where it works and
//!   avoids a portal round trip.
//!
//! The portal is asynchronous: `Screenshot` returns a handle to a Request
//! object, and the actual result arrives later as a `Response` signal on that
//! object. The subscription therefore has to be live *before* the method call,
//! or a portal that answers immediately races us and the response is lost.

use crate::util::{JResult, NovaError};
use std::collections::HashMap;
use std::time::Duration;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

/// Ceiling on the whole exchange. Long, because a portal that has not yet been
/// granted permission shows a dialog and waits for the user; the common case
/// where permission is already granted returns in well under a second.
const PORTAL_TIMEOUT: Duration = Duration::from_secs(120);

#[zbus::proxy(
    interface = "org.freedesktop.portal.Screenshot",
    default_service = "org.freedesktop.portal.Desktop",
    default_path = "/org/freedesktop/portal/desktop"
)]
trait Screenshot {
    fn screenshot(
        &self,
        parent_window: &str,
        options: HashMap<&str, Value<'_>>,
    ) -> zbus::Result<OwnedObjectPath>;
}

#[zbus::proxy(
    interface = "org.freedesktop.portal.Request",
    default_service = "org.freedesktop.portal.Desktop"
)]
trait Request {
    #[zbus(signal)]
    fn response(&self, response: u32, results: HashMap<String, OwnedValue>) -> zbus::Result<()>;
}

/// Reconstruct the object path the portal will use for this request.
///
/// Documented in the portal spec: the caller's unique bus name with the leading
/// colon dropped and dots replaced by underscores, plus our own token. Knowing
/// it in advance is what lets us subscribe before calling.
fn request_path(unique_name: &str, token: &str) -> String {
    let sender = unique_name.trim_start_matches(':').replace('.', "_");
    format!("/org/freedesktop/portal/desktop/request/{sender}/{token}")
}

/// A token unique to this request. Reusing one would collide with a request
/// still in flight.
fn handle_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("nova_{}_{}", std::process::id(), nanos)
}

/// Turn a `file://` URI into a path, undoing percent-encoding.
fn uri_to_path(uri: &str) -> JResult<std::path::PathBuf> {
    let raw = uri
        .strip_prefix("file://")
        .ok_or_else(|| NovaError::msg(format!("the portal returned an unusable URI: {uri}")))?;

    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }

    Ok(std::path::PathBuf::from(String::from_utf8_lossy(&out).to_string()))
}

/// Capture the whole screen via the portal and return the PNG bytes.
pub async fn screenshot() -> JResult<Vec<u8>> {
    let conn = zbus::Connection::session().await.map_err(|e| {
        NovaError::msg(format!(
            "could not reach the session bus for screen capture: {e}"
        ))
    })?;

    let unique = conn
        .unique_name()
        .map(|n| n.to_string())
        .ok_or_else(|| NovaError::msg("the session bus did not assign us a name"))?;

    let token = handle_token();
    let expected = request_path(&unique, &token);

    // Subscribe first: the portal may answer before `screenshot()` returns.
    let request = RequestProxy::builder(&conn)
        .path(expected.clone())
        .map_err(|e| NovaError::msg(format!("bad portal request path: {e}")))?
        .build()
        .await
        .map_err(|e| NovaError::msg(format!("could not watch the portal request: {e}")))?;

    let mut responses = request
        .receive_response()
        .await
        .map_err(|e| NovaError::msg(format!("could not subscribe to the portal: {e}")))?;

    let proxy = ScreenshotProxy::new(&conn).await.map_err(|e| {
        NovaError::msg(format!(
            "xdg-desktop-portal is not available: {e}. Install xdg-desktop-portal \
             and the backend for your desktop (xdg-desktop-portal-gnome, -kde or -wlr)."
        ))
    })?;

    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("handle_token", Value::from(token.as_str()));
    // Non-interactive: take the shot rather than opening the picker UI. The
    // first call still raises a one-time permission prompt on some desktops,
    // and the grant is remembered afterwards.
    options.insert("interactive", Value::from(false));

    let actual = proxy
        .screenshot("", options)
        .await
        .map_err(|e| NovaError::msg(format!("the screenshot portal refused: {e}")))?;

    // Portals are supposed to use the token-derived path, but the spec allows
    // any path; if it differs our subscription is on the wrong object.
    if actual.as_str() != expected {
        return Err(NovaError::msg(format!(
            "the screenshot portal used an unexpected request path ({}); \
             this desktop's portal backend may be out of date.",
            actual.as_str()
        )));
    }

    let signal = tokio::time::timeout(PORTAL_TIMEOUT, futures_util::StreamExt::next(&mut responses))
        .await
        .map_err(|_| NovaError::msg("the screenshot portal did not respond in time"))?
        .ok_or_else(|| NovaError::msg("the screenshot portal closed without responding"))?;

    let args = signal
        .args()
        .map_err(|e| NovaError::msg(format!("could not read the portal response: {e}")))?;

    match args.response {
        0 => {}
        1 => {
            return Err(NovaError::msg(
                "The screen capture request was cancelled.",
            ))
        }
        other => {
            return Err(NovaError::msg(format!(
                "The desktop refused the screen capture request (code {other}). \
                 Check Settings → Privacy → Screen Sharing."
            )))
        }
    }

    let uri = args
        .results
        .get("uri")
        .and_then(|v| String::try_from(v.clone()).ok())
        .ok_or_else(|| NovaError::msg("the portal reported success but returned no image"))?;

    let path = uri_to_path(&uri)?;
    let bytes = std::fs::read(&path).map_err(|e| {
        NovaError::msg(format!(
            "could not read the captured image at {}: {e}",
            path.display()
        ))
    })?;

    // The portal writes into the user's Pictures directory. The file is an
    // artefact of this call, not something the user asked to keep, so it is
    // removed once read — leaving it would litter a screenshot per tool call.
    let _ = std::fs::remove_file(&path);

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_path_matches_the_portal_convention() {
        assert_eq!(
            request_path(":1.234", "tok"),
            "/org/freedesktop/portal/desktop/request/1_234/tok"
        );
    }

    #[test]
    fn uri_decoding_handles_spaces() {
        assert_eq!(
            uri_to_path("file:///home/a%20b/Screenshot%20(1).png").unwrap(),
            std::path::PathBuf::from("/home/a b/Screenshot (1).png")
        );
    }

    #[test]
    fn uri_must_be_a_file_url() {
        assert!(uri_to_path("https://example.com/x.png").is_err());
    }

    #[test]
    fn tokens_do_not_repeat() {
        assert_ne!(handle_token(), handle_token());
    }
}
