use serde::Deserialize;
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneInvokeRequest {
    pub command: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[tauri::command]
pub async fn control_plane_invoke(
    app: AppHandle,
    request: ControlPlaneInvokeRequest,
) -> Result<serde_json::Value, String> {
    match request.command.as_str() {
        "open_managed_webview" => {
            let payload = serde_json::from_value(request.payload)
                .map_err(|error| format!("invalid open_managed_webview payload: {error}"))?;
            crate::webview_host::open_managed_webview(app, payload).await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "clear_site_cookies" => {
            let domains: Vec<String> = request
                .payload
                .get("domains")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| format!("invalid clear_site_cookies payload: {error}"))?
                .unwrap_or_default();
            let deleted = crate::webview_host::clear_site_cookies(app, domains).await?;
            Ok(serde_json::json!({ "deleted": deleted }))
        }
        command => Err(format!("unknown control plane command: {command}")),
    }
}
