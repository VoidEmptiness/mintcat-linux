use serde::{Deserialize, Serialize};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// Sent with `{ label }` when a managed window is gone (closed by the user or after a capture)
pub const EVENT_MANAGED_WEBVIEW_CLOSED: &str = "managed-webview-closed";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenManagedWebviewRequest {
    pub label: String,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub initialization_script: Option<String>,
    #[serde(default = "default_width")]
    pub width: f64,
    #[serde(default = "default_height")]
    pub height: f64,
    #[serde(default)]
    pub decision_command: Option<String>,
    #[serde(default)]
    pub context: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebviewDecisionRequest<'a> {
    event: &'a str,
    url: String,
    context: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebviewDecision {
    #[serde(default = "default_allow")]
    allow: bool,
    #[serde(default)]
    close: bool,
    #[serde(default)]
    emit_event: Option<String>,
    #[serde(default)]
    emit_payload: Option<serde_json::Value>,
    #[serde(default)]
    navigate_url: Option<String>,
}

fn default_width() -> f64 {
    1100.0
}

fn default_height() -> f64 {
    760.0
}

fn default_allow() -> bool {
    true
}

pub async fn open_managed_webview(
    app: AppHandle,
    request: OpenManagedWebviewRequest,
) -> Result<(), String> {
    let page_url = request
        .url
        .parse::<Url>()
        .map_err(|error| format!("invalid webview URL: {error}"))?;
    let label = sanitize_label(&request.label);

    // Already open (the same mod and file): bring it back instead of opening a second one.
    // Closing and re-creating it under the same label fails, because closing takes a moment.
    if let Some(window) = app.get_webview_window(&label) {
        if let Err(error) = window.navigate(page_url) {
            log::warn!("[WebviewHost] could not reload {}: {}", label, error);
        }
        let _ = window.unminimize();
        focus_window(&app, &window);
        return Ok(());
    }

    let nav_app = app.clone();
    let nav_label = label.clone();
    let nav_command = request.decision_command.clone();
    let nav_context = request.context.clone();
    let download_command = request.decision_command.clone();
    let download_context = request.context.clone();
    let new_window_app = app.clone();
    let new_window_label = label.clone();
    let new_window_command = request.decision_command.clone();
    let new_window_context = request.context.clone();

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(page_url))
        .title(request.title)
        .inner_size(request.width, request.height)
        .min_inner_size(480.0, 360.0)
        .resizable(true)
        .maximizable(true)
        .center()
        .decorations(true)
        .visible(true)
        .focusable(true)
        .focused(true)
        .accept_first_mouse(true);
    if let Some(script) = &request.initialization_script {
        builder = builder.initialization_script(script);
    }

    let window = builder
        .on_navigation(move |url| {
            decide_deferred(
                nav_app.clone(),
                nav_label.clone(),
                nav_command.clone(),
                "navigation",
                url.to_string(),
                nav_context.clone(),
            )
            .map(|decision| decision.allow)
            .unwrap_or(true)
        })
        .on_download(move |webview, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                return decide_deferred(
                    webview.app_handle().clone(),
                    webview.label().to_string(),
                    download_command.clone(),
                    "download",
                    url.to_string(),
                    download_context.clone(),
                )
                .map(|decision| decision.allow)
                .unwrap_or(true);
            }
            true
        })
        .on_new_window(move |url, _features| {
            let decision = decide_deferred(
                new_window_app.clone(),
                new_window_label.clone(),
                new_window_command.clone(),
                "newWindow",
                url.to_string(),
                new_window_context.clone(),
            );
            if decision
                .as_ref()
                .and_then(|decision| decision.navigate_url.as_ref())
                .is_none()
            {
                navigate_deferred(new_window_app.clone(), new_window_label.clone(), url);
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| error.to_string())?;

    let closed_app = app.clone();
    let closed_label = label.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let _ = closed_app.emit(
                EVENT_MANAGED_WEBVIEW_CLOSED,
                serde_json::json!({ "label": closed_label }),
            );
        }
    });
    focus_window(&app, &window);

    Ok(())
}

/// Delete the cookies of these sites (and their subdomains) from MINTCAT's web views, e.g. to
/// sign out of the Nexus Mods website. Windows showing those sites are closed first.
/// Returns how many cookies were deleted.
pub async fn clear_site_cookies(app: AppHandle, domains: Vec<String>) -> Result<usize, String> {
    let domains: Vec<String> = domains
        .iter()
        .map(|d| d.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|d| !d.is_empty())
        .collect();
    if domains.is_empty() {
        return Ok(0);
    }
    let matches = |host: &str| {
        let host = host.trim_start_matches('.').to_ascii_lowercase();
        domains
            .iter()
            .any(|d| host == *d || host.ends_with(&format!(".{d}")))
    };

    for (label, window) in app.webview_windows() {
        if label == "main" {
            continue;
        }
        let shows_site = window
            .url()
            .ok()
            .and_then(|url| url.host_str().map(|h| matches(h)))
            .unwrap_or(false);
        if shows_site {
            let _ = window.close();
        }
    }

    // All windows share one cookie store; the main window is always there to reach it
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let cookies = main.cookies().map_err(|error| error.to_string())?;
    let mut deleted = 0;
    for cookie in cookies {
        let on_site = cookie.domain().map(|d| matches(d)).unwrap_or(false);
        if on_site {
            match main.delete_cookie(cookie) {
                Ok(()) => deleted += 1,
                Err(error) => log::warn!("[WebviewHost] could not delete a cookie: {}", error),
            }
        }
    }
    Ok(deleted)
}

fn decide_deferred(
    app: AppHandle,
    window_label: String,
    command: Option<String>,
    event: &'static str,
    url: String,
    context: serde_json::Value,
) -> Option<WebviewDecision> {
    let command = command?;
    let payload = serde_json::to_value(WebviewDecisionRequest {
        event,
        url: url.clone(),
        context,
    })
    .ok()?;
    let decision = tauri::async_runtime::block_on(crate::integrator::runtime::backend_invoke(
        app.clone(),
        command,
        payload,
    ))
    .ok()
    .and_then(|value| serde_json::from_value::<WebviewDecision>(value).ok())?;

    if let Some(event) = &decision.emit_event {
        let payload = decision.emit_payload.clone().unwrap_or(serde_json::Value::Null);
        let _ = app.emit(event, payload);
    }
    if let Some(navigate_url) = &decision.navigate_url {
        if let Ok(url) = navigate_url.parse::<Url>() {
            navigate_deferred(app.clone(), window_label.clone(), url);
        }
    }
    if decision.close {
        if let Some(window) = app.get_webview_window(&window_label) {
            let _ = window.close();
        }
    }

    Some(decision)
}

fn navigate_deferred(app: AppHandle, window_label: String, url: Url) {
    tauri::async_runtime::spawn(async move {
        if let Some(window) = app.get_webview_window(&window_label) {
            if let Err(error) = window.navigate(url) {
                log::warn!(
                    "[WebviewHost] failed to navigate popup in {}: {}",
                    window_label,
                    error
                );
            }
        }
    });
}

fn focus_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.show();
    }

    let _ = window.set_focusable(true);
    let _ = window.show();
    let _ = window.set_focus();
}

fn sanitize_label(value: &str) -> String {
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
