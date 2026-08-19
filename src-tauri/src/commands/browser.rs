//! Browser automation over the Chrome DevTools Protocol.
//!
//! Why CDP and not Playwright: Playwright is a Node library and cannot be
//! driven from a Tauri binary without shipping a Node runtime. CDP is the same
//! protocol Playwright speaks underneath, and talking to it directly keeps the
//! app a single self-contained executable.
//!
//! Chromium-family browsers (chromium, chrome, brave, edge) support the full
//! surface below. Firefox removed its CDP implementation in version 129, so on
//! a Firefox-only system `open_url` still works via the command line while the
//! DOM-level commands report what is missing instead of failing silently.

use crate::state::AppState;
use crate::util::{expand_path, first_available, spawn_detached, JResult, NovaError};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::State;

const DEBUG_PORT: u16 = 9222;
const CDP_TIMEOUT: Duration = Duration::from_secs(30);

/// Browsers we can drive, most-capable first.
const CHROMIUM_BINARIES: &[&str] = &[
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "brave-browser",
    "microsoft-edge",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: String,
    pub title: String,
    pub url: String,
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default()
}

/// Ask the browser for its list of debuggable page targets.
async fn targets() -> JResult<Vec<Value>> {
    let url = format!("http://127.0.0.1:{DEBUG_PORT}/json/list");
    let resp = http().get(&url).send().await.map_err(|_| {
        NovaError::msg(
            "No browser is listening on the DevTools port. Ask NOVA to open a URL first, \
             or start your browser with --remote-debugging-port=9222.",
        )
    })?;

    let list: Value = resp
        .json()
        .await
        .map_err(|e| NovaError::msg(format!("could not read the target list: {e}")))?;

    Ok(list
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|t| t["type"].as_str() == Some("page"))
        .collect())
}

/// The page we act on: the most recently activated tab, which is what
/// `/json/list` returns first.
async fn active_target() -> JResult<Value> {
    targets()
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| NovaError::msg("the browser has no open tabs"))
}

/// Send one CDP command and return its `result` payload.
///
/// A connection per command keeps this stateless — the alternative, a
/// long-lived socket, has to survive tab switches, navigations and browser
/// restarts, none of which buys anything at the rate an agent issues commands.
async fn cdp(ws_url: &str, method: &str, params: Value) -> JResult<Value> {
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(ws_url),
    )
    .await
    .map_err(|_| NovaError::msg("timed out connecting to the browser"))?
    .map_err(|e| NovaError::msg(format!("could not connect to the browser: {e}")))?;

    let id = 1u64;
    let request = json!({ "id": id, "method": method, "params": params });

    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            request.to_string(),
        ))
        .await
        .map_err(|e| NovaError::msg(format!("could not send to the browser: {e}")))?;

    let deadline = tokio::time::Instant::now() + CDP_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(NovaError::msg(format!("`{method}` timed out")));
        }

        let msg = match tokio::time::timeout(remaining, socket.next()).await {
            Err(_) => return Err(NovaError::msg(format!("`{method}` timed out"))),
            Ok(None) => return Err(NovaError::msg("the browser closed the connection")),
            Ok(Some(Err(e))) => {
                return Err(NovaError::msg(format!("browser connection error: {e}")))
            }
            Ok(Some(Ok(m))) => m,
        };

        let tokio_tungstenite::tungstenite::Message::Text(text) = msg else {
            continue; // ping/pong/binary frames are not ours
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };

        // Events carry no `id`; skip until our reply arrives.
        if value["id"].as_u64() != Some(id) {
            continue;
        }
        if let Some(err) = value.get("error") {
            return Err(NovaError::msg(format!(
                "browser rejected `{method}`: {}",
                err["message"].as_str().unwrap_or("unknown error")
            )));
        }
        return Ok(value["result"].clone());
    }
}

/// Evaluate JavaScript in the active tab and return the result value.
async fn eval(expression: &str) -> JResult<Value> {
    let target = active_target().await?;
    let ws = target["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| NovaError::msg("tab is not debuggable"))?;

    let result = cdp(
        ws,
        "Runtime.evaluate",
        json!({
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": true,
            "userGesture": true,
        }),
    )
    .await?;

    if let Some(details) = result.get("exceptionDetails") {
        let text = details["exception"]["description"]
            .as_str()
            .or_else(|| details["text"].as_str())
            .unwrap_or("script error");
        return Err(NovaError::msg(format!("page script failed: {text}")));
    }
    Ok(result["result"]["value"].clone())
}

fn as_text(v: Value) -> String {
    match v {
        Value::String(s) => s,
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// JS-literal-escape a string so selectors and typed text cannot break out.
fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/* ── Launching ──────────────────────────────────────────────────── */

async fn debugger_is_up() -> bool {
    http()
        .get(format!("http://127.0.0.1:{DEBUG_PORT}/json/version"))
        .send()
        .await
        .is_ok()
}

/// Start a debuggable browser if one is not already listening.
async fn ensure_browser(state: &AppState, url: Option<&str>) -> JResult<()> {
    if debugger_is_up().await {
        return Ok(());
    }

    let profile = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("jarvis-browser-profile");
    std::fs::create_dir_all(&profile)?;
    let profile_arg = format!("--user-data-dir={}", profile.to_string_lossy());
    let port_arg = format!("--remote-debugging-port={DEBUG_PORT}");

    if let Some(bin) = first_available(CHROMIUM_BINARIES) {
        let mut args: Vec<&str> = vec![
            &port_arg,
            &profile_arg,
            "--no-first-run",
            "--no-default-browser-check",
        ];
        if let Some(u) = url {
            args.push(u);
        }
        let pid = spawn_detached(&bin, &args)?;
        *state.browser_pid.lock().unwrap() = Some(pid);

        // Chromium takes a moment to bind the port.
        for _ in 0..40 {
            if debugger_is_up().await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        return Err(NovaError::msg(
            "the browser started but never opened its DevTools port",
        ));
    }

    // Firefox-only system: navigation works, DOM control does not.
    if crate::util::has("firefox") {
        if let Some(u) = url {
            spawn_detached("firefox", &[u])?;
            return Err(NovaError::msg(
                "Opened the page in Firefox. Firefox 129+ no longer implements the DevTools \
                 protocol, so NOVA cannot read or click page content there. Install Chromium \
                 for full browser control.",
            ));
        }
    }

    Err(NovaError::missing(
        "chromium",
        "Browser automation needs a Chromium-family browser (chromium, chrome, brave or edge).",
    ))
}

/* ── Commands ───────────────────────────────────────────────────── */

#[tauri::command]
pub async fn open_url(state: State<'_, AppState>, url: String) -> JResult<String> {
    // Reject anything that isn't http(s) — `file://` and `javascript:` would
    // turn a browser tool into arbitrary local file access.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(NovaError::msg(
            "only http:// and https:// URLs can be opened",
        ));
    }

    ensure_browser(&state, Some(&url)).await?;

    let target = active_target().await?;
    let ws = target["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| NovaError::msg("tab is not debuggable"))?;
    cdp(ws, "Page.navigate", json!({ "url": url })).await?;

    // Give the document a moment to commit so a follow-up read sees the new page.
    tokio::time::sleep(Duration::from_millis(700)).await;
    Ok(format!("opened {url}"))
}

#[tauri::command]
pub async fn get_current_url() -> JResult<String> {
    Ok(as_text(eval("location.href").await?))
}

#[tauri::command]
pub async fn get_page_title() -> JResult<String> {
    Ok(as_text(eval("document.title").await?))
}

#[tauri::command]
pub async fn get_page_text() -> JResult<String> {
    // innerText (not textContent) respects visibility, so hidden nav markup and
    // script bodies stay out of the model's context.
    let text = as_text(eval("document.body ? document.body.innerText : ''").await?);
    Ok(crate::util::cap_output(&text, 30_000))
}

#[tauri::command]
pub async fn take_page_screenshot() -> JResult<String> {
    let target = active_target().await?;
    let ws = target["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| NovaError::msg("tab is not debuggable"))?;

    let result = cdp(ws, "Page.captureScreenshot", json!({ "format": "png" })).await?;
    let data = result["data"]
        .as_str()
        .ok_or_else(|| NovaError::msg("the browser returned no image data"))?;
    Ok(format!("data:image/png;base64,{data}"))
}

/// Find an element by CSS selector, falling back to a text match so the model
/// can say "the Sign in button" instead of guessing at markup.
fn locator_js(selector_or_text: &str) -> String {
    let s = js_string(selector_or_text);
    format!(
        r#"(() => {{
  const q = {s};
  let el = null;
  try {{ el = document.querySelector(q); }} catch (e) {{ /* not a valid selector */ }}
  if (!el) {{
    const needle = q.trim().toLowerCase();
    const candidates = [...document.querySelectorAll(
      'button, a, input[type=submit], input[type=button], [role=button], label, summary'
    )];
    el = candidates.find(n => (n.innerText || n.value || '').trim().toLowerCase() === needle)
      || candidates.find(n => (n.innerText || n.value || '').trim().toLowerCase().includes(needle))
      || [...document.querySelectorAll('*')].find(
           n => n.children.length === 0 &&
                (n.innerText || '').trim().toLowerCase().includes(needle)
         );
  }}
  return el;
}})()"#
    )
}

#[tauri::command]
pub async fn click_element(selector: String) -> JResult<String> {
    let js = format!(
        r#"(() => {{
  const el = {};
  if (!el) return 'NOT_FOUND';
  el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
  el.click();
  return 'OK';
}})()"#,
        locator_js(&selector)
    );

    match as_text(eval(&js).await?).as_str() {
        "OK" => Ok(format!("clicked `{selector}`")),
        _ => Err(NovaError::msg(format!(
            "no element matching `{selector}` on this page"
        ))),
    }
}

#[tauri::command]
pub async fn type_in_element(selector: String, text: String) -> JResult<String> {
    let js = format!(
        r#"(() => {{
  const el = {};
  if (!el) return 'NOT_FOUND';
  el.focus();
  const value = {};
  if ('value' in el) {{
    // React and friends track the native setter; bypassing it drops the update.
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }} else {{
    el.textContent = value;
  }}
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  return 'OK';
}})()"#,
        locator_js(&selector),
        js_string(&text)
    );

    match as_text(eval(&js).await?).as_str() {
        "OK" => Ok(format!("typed into `{selector}`")),
        _ => Err(NovaError::msg(format!(
            "no element matching `{selector}` on this page"
        ))),
    }
}

#[tauri::command]
pub async fn scroll_page(direction: String, amount: Option<i32>) -> JResult<String> {
    let px = amount.unwrap_or(600);
    let dy = if direction == "up" { -px } else { px };
    eval(&format!("window.scrollBy(0, {dy}); 'OK'")).await?;
    Ok(format!("scrolled {direction}"))
}

#[tauri::command]
pub async fn go_back() -> JResult<String> {
    eval("history.back(); 'OK'").await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    Ok("went back".into())
}

#[tauri::command]
pub async fn go_forward() -> JResult<String> {
    eval("history.forward(); 'OK'").await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    Ok("went forward".into())
}

#[tauri::command]
pub async fn reload_page() -> JResult<String> {
    let target = active_target().await?;
    let ws = target["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| NovaError::msg("tab is not debuggable"))?;
    cdp(ws, "Page.reload", json!({})).await?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    Ok("reloaded".into())
}

#[tauri::command]
pub async fn new_tab(state: State<'_, AppState>, url: Option<String>) -> JResult<String> {
    ensure_browser(&state, None).await?;
    let target_url = url.unwrap_or_else(|| "about:blank".to_string());

    let resp = http()
        .put(format!(
            "http://127.0.0.1:{DEBUG_PORT}/json/new?{}",
            urlencode(&target_url)
        ))
        .send()
        .await
        .map_err(|e| NovaError::msg(format!("could not open a tab: {e}")))?;

    let tab: Value = resp
        .json()
        .await
        .map_err(|e| NovaError::msg(format!("could not read the new tab: {e}")))?;
    Ok(format!(
        "opened tab {}",
        tab["id"].as_str().unwrap_or_default()
    ))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[tauri::command]
pub async fn close_tab(id: Option<String>) -> JResult<String> {
    let tab_id = match id {
        Some(i) => i,
        None => active_target()
            .await?
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    };
    http()
        .get(format!("http://127.0.0.1:{DEBUG_PORT}/json/close/{tab_id}"))
        .send()
        .await
        .map_err(|e| NovaError::msg(format!("could not close the tab: {e}")))?;
    Ok("closed tab".into())
}

#[tauri::command]
pub async fn list_tabs() -> JResult<Vec<TabInfo>> {
    Ok(targets()
        .await?
        .into_iter()
        .map(|t| TabInfo {
            id: t["id"].as_str().unwrap_or_default().to_string(),
            title: t["title"].as_str().unwrap_or_default().to_string(),
            url: t["url"].as_str().unwrap_or_default().to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn switch_tab(index: usize) -> JResult<String> {
    let tabs = targets().await?;
    let tab = tabs
        .get(index)
        .ok_or_else(|| NovaError::msg(format!("no tab at index {index}")))?;
    let id = tab["id"].as_str().unwrap_or_default();

    http()
        .get(format!("http://127.0.0.1:{DEBUG_PORT}/json/activate/{id}"))
        .send()
        .await
        .map_err(|e| NovaError::msg(format!("could not switch tabs: {e}")))?;
    Ok(format!(
        "switched to `{}`",
        tab["title"].as_str().unwrap_or_default()
    ))
}

#[tauri::command]
pub async fn wait_for_element(selector: String, timeout: Option<u64>) -> JResult<String> {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout.unwrap_or(10_000));

    while std::time::Instant::now() < deadline {
        let js = format!("({} ) !== null", locator_js(&selector));
        if eval(&js).await.ok().and_then(|v| v.as_bool()) == Some(true) {
            return Ok(format!("`{selector}` appeared"));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(NovaError::msg(format!(
        "`{selector}` did not appear within the timeout"
    )))
}

#[tauri::command]
pub async fn execute_js(code: String) -> JResult<String> {
    Ok(crate::util::cap_output(
        &as_text(eval(&code).await?),
        20_000,
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormField {
    pub selector: String,
    pub value: String,
}

#[tauri::command]
pub async fn fill_form(fields: Vec<FormField>) -> JResult<String> {
    let mut filled = 0;
    for f in &fields {
        type_in_element(f.selector.clone(), f.value.clone()).await?;
        filled += 1;
    }
    Ok(format!("filled {filled} field(s)"))
}

#[tauri::command]
pub async fn download_file(url: String, dest: String) -> JResult<String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(NovaError::msg(
            "only http:// and https:// URLs can be downloaded",
        ));
    }

    let path = expand_path(&dest);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| NovaError::msg(e.to_string()))?
        .get(&url)
        .send()
        .await
        .map_err(|e| NovaError::msg(format!("download failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(NovaError::msg(format!(
            "download failed: HTTP {}",
            resp.status()
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| NovaError::msg(format!("download failed: {e}")))?;
    std::fs::write(&path, &bytes)?;

    Ok(format!(
        "saved {} bytes to {}",
        bytes.len(),
        path.to_string_lossy()
    ))
}
