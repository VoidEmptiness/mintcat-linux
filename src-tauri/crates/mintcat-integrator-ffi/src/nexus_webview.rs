use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const EVENT_NEXUS_DOWNLOAD_CAPTURED: &str = "nexus-download-captured";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenNexusDownloadWebviewRequest {
    pub page_url: String,
    pub profile_url: String,
    pub domain: String,
    pub mod_id: u32,
    pub file_id: Option<u32>,
    pub auto_start: Option<bool>,
    /// Nexus's id of the game, when known (saves searching the page for it)
    #[serde(default)]
    pub game_id: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewDecisionRequest {
    pub event: String,
    pub url: String,
    pub context: OpenNexusDownloadWebviewRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWebviewRequest {
    pub label: String,
    pub url: String,
    pub title: String,
    pub initialization_script: String,
    pub width: f64,
    pub height: f64,
    pub decision_command: String,
    pub context: OpenNexusDownloadWebviewRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewDecision {
    pub allow: bool,
    pub close: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emit_event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emit_payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub navigate_url: Option<String>,
}

pub fn open_request(payload: Value) -> Result<Value> {
    let request: OpenNexusDownloadWebviewRequest = serde_json::from_value(payload)?;
    let response = ManagedWebviewRequest {
        label: format!(
            "nexus-download-{}-{}-{}",
            sanitize_label_part(&request.domain),
            request.mod_id,
            request.file_id.unwrap_or(0)
        ),
        url: request.page_url.clone(),
        title: "Nexus Mods Download".to_string(),
        initialization_script: build_auto_download_script(&request),
        width: 1100.0,
        height: 760.0,
        decision_command: "nexus_download_webview_decide".to_string(),
        context: request,
    };
    serde_json::to_value(response).map_err(Into::into)
}

pub fn decide(payload: Value) -> Result<Value> {
    let request: WebviewDecisionRequest = serde_json::from_value(payload)?;
    let Some(source) = capture_source(&request.url) else {
        return serde_json::to_value(WebviewDecision {
            allow: request.event != "newWindow",
            close: false,
            emit_event: None,
            emit_payload: None,
            navigate_url: if request.event == "newWindow" {
                Some(request.url)
            } else {
                None
            },
        })
        .map_err(Into::into);
    };

    let payload = json!({
        "url": request.url,
        "source": source,
        "domain": request.context.domain,
        "modId": request.context.mod_id,
        "fileId": request.context.file_id,
        "profileUrl": request.context.profile_url,
    });
    serde_json::to_value(WebviewDecision {
        allow: false,
        close: true,
        emit_event: Some(EVENT_NEXUS_DOWNLOAD_CAPTURED.to_string()),
        emit_payload: Some(payload),
        navigate_url: None,
    })
    .map_err(Into::into)
}

fn build_auto_download_script(context: &OpenNexusDownloadWebviewRequest) -> String {
    let config = json!({
        "autoStart": context.auto_start.unwrap_or(true),
        "domain": context.domain.as_str(),
        "modId": context.mod_id,
        "fileId": context.file_id,
        "gameId": context.game_id,
    });
    let mut script = String::from("(function () {\nconst config = ");
    script.push_str(&config.to_string());
    script.push_str(AUTO_DOWNLOAD_SCRIPT_BODY);
    script
}

/// Starts the download of the chosen file on the mod's Nexus page (what the Slow download /
/// Manual download buttons do). It is kept cheap so the page stays responsive: page changes are
/// handled at most every 300 ms, the page's HTML is searched for the game id at most every 2 s,
/// and everything stops after 45 s, once the page is left, or as soon as the user clicks or types
/// in the window (from then on the page is theirs; a download they start is still caught).
const AUTO_DOWNLOAD_SCRIPT_BODY: &str = r#";
if (!config.autoStart || window.__mintcatNexusAutoDownloadStarted) {
    return;
}
window.__mintcatNexusAutoDownloadStarted = true;

const maxRuntimeMs = 45000;
const intervalMs = 700;
const minGapMs = 300;
const startedAt = Date.now();
const attempts = new WeakMap();
let timer = null;
let observer = null;
let pending = null;
let lastRun = 0;
let stopped = false;
let generateDownloadUrlStarted = false;
let gameId = Number(config.gameId) || 0;
let lastGameIdSearch = 0;

function stop() {
    stopped = true;
    if (timer) window.clearInterval(timer);
    timer = null;
    if (observer) observer.disconnect();
    observer = null;
    if (pending) window.clearTimeout(pending);
    pending = null;
}

function findGameIdInText(text) {
    const match = text.match(/["']game_?id["']\s*:\s*["']?(\d+)/i)
        || text.match(/data-game-?id=["'](\d+)/i);
    return match ? Number(match[1]) : 0;
}

function getGameId() {
    if (gameId) return gameId;
    const candidates = [
        document.querySelector('[data-gameid]'),
        document.querySelector('[data-game-id]'),
        document.querySelector('[data-game-id-text]'),
        document.body,
        document.documentElement,
    ].filter(Boolean);
    for (const element of candidates) {
        const dataset = element.dataset || {};
        const value = dataset.gameid
            || dataset.gameId
            || dataset.gameIdText
            || element.getAttribute('data-gameid')
            || element.getAttribute('data-game-id');
        const id = Number(value || 0);
        if (Number.isFinite(id) && id > 0) {
            gameId = id;
            return gameId;
        }
    }
    // The page's HTML is large: search it now and then, not on every change
    const now = Date.now();
    if (now - lastGameIdSearch < 2000) return 0;
    lastGameIdSearch = now;
    const data = document.getElementById('__NEXT_DATA__');
    const id = (data && findGameIdInText(data.textContent || ''))
        || findGameIdInText(document.documentElement ? document.documentElement.innerHTML : '');
    if (Number.isFinite(id) && id > 0) gameId = id;
    return gameId;
}

function generateDownloadUrl() {
    if (generateDownloadUrlStarted || !config.fileId) return false;
    const id = getGameId();
    if (!id) return false;
    generateDownloadUrlStarted = true;
    const body = new URLSearchParams();
    body.set('fid', String(config.fileId));
    body.set('game_id', String(id));
    fetch(window.location.origin + '/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl', {
        method: 'POST',
        credentials: 'include',
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest',
        },
        body,
    })
        .then((response) => response.text())
        .then((text) => {
            const data = JSON.parse(text);
            if (data && data.url && !stopped) {
                window.location.href = data.url;
            }
        })
        .catch(() => {});
    return true;
}

function isTargetPage() {
    const host = window.location.hostname.toLowerCase();
    if (host !== 'www.nexusmods.com' && host !== 'nexusmods.com') return false;
    const parts = window.location.pathname.split('/').filter(Boolean);
    const gameOffset = parts[0] && parts[0].toLowerCase() === 'games' ? 1 : 0;
    const domain = (parts[gameOffset] || '').toLowerCase();
    const modsSegment = (parts[gameOffset + 1] || '').toLowerCase();
    const modId = Number(parts[gameOffset + 2] || 0);
    return domain === String(config.domain).toLowerCase()
        && modsSegment === 'mods'
        && modId === Number(config.modId);
}

function textOf(element) {
    return [
        element.textContent || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('href') || '',
        element.getAttribute('data-download-url') || '',
        element.getAttribute('data-file-id') || '',
        element.id || '',
    ].join(' ').toLowerCase();
}

function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && !element.hasAttribute('disabled')
        && element.getAttribute('aria-disabled') !== 'true';
}

function attributesText(element) {
    const parts = [];
    for (const attr of Array.from(element.attributes || [])) {
        if (attr.name !== 'class' && attr.name !== 'style') parts.push(attr.value);
    }
    return parts.join(' ').toLowerCase();
}

const fileIdPattern = config.fileId ? new RegExp('(^|\\D)' + String(config.fileId) + '(\\D|$)') : null;

// The button itself or its nearby containers name the file (in a link, id or data attribute).
// Only the button's own text is read: a container's text can be the whole page.
function mentionsFileId(element) {
    if (!fileIdPattern) return true;
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        if (current === document.body || current === document.documentElement) break;
        const text = depth === 0 ? textOf(current) + ' ' + attributesText(current) : attributesText(current);
        if (fileIdPattern.test(text)) return true;
    }
    return false;
}

// `onlyOneFile`: the page shows the buttons of one file only, so they can't be another file's
function matchesFileId(element, onlyOneFile) {
    if (!config.fileId) return true;
    if (mentionsFileId(element)) return true;
    return onlyOneFile && Date.now() - startedAt > 6000;
}

function canAttempt(element, key, cooldownMs, maxAttempts) {
    const now = Date.now();
    const entry = attempts.get(element) || {};
    const state = entry[key] || { count: 0, lastAt: 0 };
    if (state.count >= maxAttempts || now - state.lastAt < cooldownMs) return false;
    entry[key] = { count: state.count + 1, lastAt: now };
    attempts.set(element, entry);
    return true;
}

function dispatchSlowDownload(component, onlyOneFile) {
    if (!component || !matchesFileId(component, onlyOneFile)) return false;
    if (!canAttempt(component, 'slowDownloadEvent', 900, 30)) return false;
    component.dispatchEvent(new CustomEvent('slowDownload', { bubbles: true, composed: true }));
    return true;
}

function clickElement(element, onlyOneFile) {
    if (!element || !isVisible(element) || !matchesFileId(element, onlyOneFile)) return false;
    if (!canAttempt(element, 'click', 1600, 8)) return false;
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.click();
    return true;
}

function findDownloadButtons() {
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    const buttons = candidates.filter((element) => {
        const text = textOf(element);
        if (!text) return false;
        if (text.includes('preview file contents') || text.includes('requirements') || text.includes('changelog')) {
            return false;
        }
        return text.includes('slow download')
            || text.includes('mod manager download')
            || text.includes('manual download')
            || text.includes('download with manager')
            || text.includes('nxm://')
            || text.includes('nexus-cdn.com');
    });
    const priority = (element) => {
        const text = textOf(element);
        if (text.includes('slow download')) return 0;
        if (text.includes('manual download')) return 1;
        if (text.includes('mod manager download') || text.includes('download with manager')) return 2;
        return 3;
    };
    return buttons.sort((a, b) => priority(a) - priority(b));
}

function tick() {
    if (stopped) return;
    lastRun = Date.now();
    if (lastRun - startedAt > maxRuntimeMs) {
        stop();
        return;
    }
    if (!isTargetPage()) return;
    if (generateDownloadUrl()) return;
    const components = Array.from(document.querySelectorAll('mod-file-download'));
    const onlyOneComponent = components.length === 1;
    const matchingComponents = components.filter((component) => matchesFileId(component, onlyOneComponent));
    let dispatchedComponentEvent = false;
    for (const component of matchingComponents) {
        if (dispatchSlowDownload(component, onlyOneComponent)) {
            dispatchedComponentEvent = true;
        }
    }
    if (dispatchedComponentEvent && Date.now() - startedAt < 3500) return;
    const buttons = findDownloadButtons();
    // Slow + manual + manager download of one file at most
    const onlyOneFile = buttons.length <= 3;
    for (const element of buttons) {
        if (clickElement(element, onlyOneFile)) return;
    }
}

// Page changes come in bursts: handle them together, at most every `minGapMs`
function scheduleTick() {
    if (stopped || pending) return;
    const wait = Math.max(50, minGapMs - (Date.now() - lastRun));
    pending = window.setTimeout(() => {
        pending = null;
        tick();
    }, wait);
}

function startObserver() {
    if (stopped || !window.MutationObserver || observer || !document.documentElement) return;
    observer = new MutationObserver(scheduleTick);
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

// The user took over (logging in, picking another file, reading): leave the page to them
function onUserInput(event) {
    if (event.isTrusted) stop();
}
for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, onUserInput, { capture: true, passive: true });
}

timer = window.setInterval(scheduleTick, intervalMs);
startObserver();
if (window.customElements && window.customElements.whenDefined) {
    window.customElements.whenDefined('mod-file-download').then(scheduleTick).catch(() => {});
}
window.addEventListener('DOMContentLoaded', () => {
    startObserver();
    scheduleTick();
}, { once: true });
window.addEventListener('load', scheduleTick, { once: true });
window.addEventListener('pagehide', stop, { once: true });
scheduleTick();
})();"#;

fn capture_source(value: &str) -> Option<&'static str> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme().eq_ignore_ascii_case("nxm") {
        return Some("nxm");
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if (url.scheme() == "http" || url.scheme() == "https") && host.ends_with("nexus-cdn.com") {
        return Some("cdn");
    }
    None
}

fn sanitize_label_part(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}
