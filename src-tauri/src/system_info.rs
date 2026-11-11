//! A one-line description of the system for the Log, to help with bug reports:
//! the OS, the desktop and whether it's Wayland or X11, and how MINTCAT runs.

#[tauri::command]
pub fn session_summary() -> String {
    let mut parts: Vec<String> = Vec::new();
    #[cfg(target_os = "linux")]
    {
        let os = std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|text| {
                text.lines()
                    .find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_string()))
            })
            .unwrap_or_else(|| "Linux".into());
        parts.push(os);
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        if let Some(desktop) = var("XDG_CURRENT_DESKTOP") {
            parts.push(desktop);
        }
        let session = var("XDG_SESSION_TYPE").unwrap_or_else(|| {
            if var("WAYLAND_DISPLAY").is_some() { "wayland".into() } else if var("DISPLAY").is_some() { "x11".into() } else { "unknown".into() }
        });
        parts.push(session);
        if var("APPIMAGE").is_some() {
            parts.push("AppImage".into());
        }
        if let Some(backend) = var("GDK_BACKEND") {
            parts.push(format!("GDK_BACKEND={backend}"));
        }
    }
    #[cfg(not(target_os = "linux"))]
    parts.push(std::env::consts::OS.to_string());
    parts.push(format!("clipboard watch: {}", crate::clipboard_watch::mode()));
    parts.join(" · ")
}
