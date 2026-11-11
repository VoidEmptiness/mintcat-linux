//! MINTCAT's icon outside its own window contents, for the app icon picked in the title bar:
//!
//! - the window icon (`set_window_icon`), used by window lists on X11, Windows and others;
//! - on Linux, the icon of the menu entry an AppImage manager (Shelly, Gear Lever,
//!   AppImageLauncher, ...) made for the running AppImage in `~/.local/share/applications`. Desktops
//!   such as KDE Plasma on Wayland take the taskbar icon from that entry, not from the window.
//!
//! Only the `Icon=` line of entries whose `Exec`/`TryExec` start this AppImage is changed. The
//! value it had is kept in the same entry (`X-MINTCAT-Original-Icon=`) and put back when the
//! default icon is chosen again. The picture itself is MINTCAT's own file in its data folder.
//! If the AppImage manager rewrites the entry (e.g. after an update), MINTCAT applies the icon
//! again at its next start.

use serde::Serialize;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::image::Image;
use tauri::{AppHandle, Manager, WebviewWindow};

const ORIGINAL_KEY: &str = "X-MINTCAT-Original-Icon";
const ICON_DIR: &str = "system-icon";
const ICON_PREFIX: &str = "mintcat-icon-";
const MAX_PNG_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemIconStatus {
    /// Menu entries found for this AppImage
    pub entries: Vec<String>,
    /// Entries that currently use MINTCAT's picked icon
    pub custom: usize,
}

/// `$XDG_DATA_HOME/applications` (default `~/.local/share/applications`)
fn applications_dir() -> Option<PathBuf> {
    let data = env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").filter(|v| !v.is_empty()).map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(data.join("applications"))
}

/// The AppImage file this process was started from (set by the AppImage runtime)
fn running_appimage() -> Option<PathBuf> {
    env::var_os("APPIMAGE").filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Split an Exec value into arguments (desktop entry quoting: "..." with \" \\ \` \$ escapes)
fn exec_args(exec: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                    has_token = true;
                }
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(current);
    }
    args
}

fn same_file(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Unescape a desktop entry string value (\s \n \t \r \\)
fn unescape_value(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('s') => out.push(' '),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Value of `key` in the [Desktop Entry] group (no locale variants)
fn entry_value(content: &str, key: &str) -> Option<String> {
    let mut in_main = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_main = trimmed == "[Desktop Entry]";
            continue;
        }
        if !in_main {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            if k.trim() == key {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Does this entry start the given AppImage?
fn entry_starts(content: &str, appimage: &Path) -> bool {
    ["Exec", "TryExec"].iter().any(|key| {
        entry_value(content, key).map_or(false, |value| {
            exec_args(&unescape_value(&value))
                .iter()
                .any(|arg| arg.starts_with('/') && same_file(Path::new(arg), appimage))
        })
    })
}

/// Entries in `dir` that start `appimage` (regular files only, not followed through links)
fn find_entries(dir: &Path, appimage: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(read) = fs::read_dir(dir) else { return found };
    for item in read.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else { continue };
        if entry_starts(&content, appimage) {
            found.push(path);
        }
    }
    found.sort();
    found
}

/// Rewrite the [Desktop Entry] group: `Icon=` gets `icon` (None removes it), and the
/// `X-MINTCAT-Original-Icon=` line is set to `original` (None removes it). Other lines stay.
fn rewrite_entry(content: &str, icon: Option<&str>, original: Option<&str>) -> String {
    let mut out = String::with_capacity(content.len() + 64);
    let mut in_main = false;
    let mut main_seen = false;
    let mut wrote_icon = false;
    let mut wrote_original = false;
    let pending_tail = |out: &mut String, wrote_icon: &mut bool, wrote_original: &mut bool| {
        if !*wrote_icon {
            if let Some(icon) = icon {
                out.push_str(&format!("Icon={icon}\n"));
            }
            *wrote_icon = true;
        }
        if !*wrote_original {
            if let Some(original) = original {
                out.push_str(&format!("{ORIGINAL_KEY}={original}\n"));
            }
            *wrote_original = true;
        }
    };
    for line in content.split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if in_main {
                // leaving the main group: add what wasn't there
                pending_tail(&mut out, &mut wrote_icon, &mut wrote_original);
            }
            in_main = trimmed == "[Desktop Entry]";
            main_seen |= in_main;
            out.push_str(line);
            continue;
        }
        if in_main {
            if let Some((k, _)) = trimmed.split_once('=') {
                let key = k.trim();
                if key == "Icon" {
                    if !wrote_icon {
                        if let Some(icon) = icon {
                            out.push_str(&format!("Icon={icon}\n"));
                        }
                        wrote_icon = true;
                        if !wrote_original {
                            if let Some(original) = original {
                                out.push_str(&format!("{ORIGINAL_KEY}={original}\n"));
                            }
                            wrote_original = true;
                        }
                    }
                    continue;
                }
                if key == ORIGINAL_KEY {
                    continue;
                }
            }
        }
        out.push_str(line);
    }
    if in_main || !main_seen {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if !main_seen {
            out.push_str("[Desktop Entry]\n");
        }
        pending_tail(&mut out, &mut wrote_icon, &mut wrote_original);
    }
    out
}

/// Replace a file through a temporary file next to it, keeping its permissions
fn write_replacing(path: &Path, content: &str) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("entry");
    let temp = path.with_file_name(format!(".{name}.mintcat-tmp"));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&temp, meta.permissions())?;
        }
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e| format!("{}: {e}", path.display()))
}

/// Point the entry at `icon_path`, remembering the icon it had (once)
fn apply_to_entry(entry: &Path, icon_path: &str) -> Result<bool, String> {
    let content = fs::read_to_string(entry).map_err(|e| format!("{}: {e}", entry.display()))?;
    let current = entry_value(&content, "Icon");
    let original = entry_value(&content, ORIGINAL_KEY).or_else(|| current.clone()).unwrap_or_default();
    if current.as_deref() == Some(icon_path) && entry_value(&content, ORIGINAL_KEY).is_some() {
        return Ok(false);
    }
    write_replacing(entry, &rewrite_entry(&content, Some(icon_path), Some(&original)))?;
    Ok(true)
}

/// Put back the icon the entry had before MINTCAT changed it
fn restore_entry(entry: &Path) -> Result<bool, String> {
    let content = fs::read_to_string(entry).map_err(|e| format!("{}: {e}", entry.display()))?;
    let Some(original) = entry_value(&content, ORIGINAL_KEY) else { return Ok(false) };
    let icon = if original.is_empty() { None } else { Some(original.as_str()) };
    write_replacing(entry, &rewrite_entry(&content, icon, None))?;
    Ok(true)
}

fn is_our_icon(value: Option<String>, icon_dir: &Path) -> bool {
    value.map_or(false, |v| Path::new(&v).starts_with(icon_dir))
}

fn status_of(entries: &[PathBuf], icon_dir: &Path) -> SystemIconStatus {
    let custom = entries
        .iter()
        .filter(|e| fs::read_to_string(e).map_or(false, |c| is_our_icon(entry_value(&c, "Icon"), icon_dir)))
        .count();
    SystemIconStatus { entries: entries.iter().map(|e| e.display().to_string()).collect(), custom }
}

/// Small stable hash so a changed picture gets a new file name (icon caches go by path)
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn icon_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(ICON_DIR))
}

/// Remove MINTCAT's icon files except `keep`
fn remove_old_icons(dir: &Path, keep: Option<&Path>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for item in read.flatten() {
        let path = item.path();
        let name = item.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(ICON_PREFIX) && name.ends_with(".png") && Some(path.as_path()) != keep {
            let _ = fs::remove_file(&path);
        }
    }
}

fn entries_for_this_appimage() -> Vec<PathBuf> {
    match (applications_dir(), running_appimage()) {
        (Some(dir), Some(appimage)) => find_entries(&dir, &appimage),
        _ => Vec::new(),
    }
}

/// Menu entries for the running AppImage and whether they use the picked icon
#[tauri::command]
pub fn system_icon_status(app: AppHandle) -> Result<SystemIconStatus, String> {
    let dir = icon_dir(&app)?;
    Ok(status_of(&entries_for_this_appimage(), &dir))
}

/// Use `png` (the picked app icon) for the AppImage's menu entries
#[tauri::command]
pub fn system_icon_apply(app: AppHandle, png: Vec<u8>) -> Result<SystemIconStatus, String> {
    if png.len() < 8 || &png[..8] != b"\x89PNG\r\n\x1a\n" || png.len() > MAX_PNG_BYTES {
        return Err("not a PNG image".into());
    }
    let dir = icon_dir(&app)?;
    let entries = entries_for_this_appimage();
    if entries.is_empty() {
        return Ok(status_of(&entries, &dir));
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let icon_path = dir.join(format!("{ICON_PREFIX}{:016x}.png", fnv1a(&png)));
    if fs::read(&icon_path).ok().as_deref() != Some(png.as_slice()) {
        let temp = dir.join(".mintcat-icon.tmp");
        fs::write(&temp, &png).map_err(|e| e.to_string())?;
        fs::rename(&temp, &icon_path).map_err(|e| e.to_string())?;
    }
    let icon_str = icon_path.to_string_lossy().to_string();
    let mut errors = Vec::new();
    for entry in &entries {
        if let Err(e) = apply_to_entry(entry, &icon_str) {
            errors.push(e);
        }
    }
    remove_old_icons(&dir, Some(&icon_path));
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(status_of(&entries, &dir))
}

/// Put the menu entries' own icon back
#[tauri::command]
pub fn system_icon_restore(app: AppHandle) -> Result<SystemIconStatus, String> {
    let dir = icon_dir(&app)?;
    let entries = entries_for_this_appimage();
    let mut errors = Vec::new();
    for entry in &entries {
        if let Err(e) = restore_entry(entry) {
            errors.push(e);
        }
    }
    if errors.is_empty() {
        remove_old_icons(&dir, None);
    } else {
        return Err(errors.join("; "));
    }
    Ok(status_of(&entries, &dir))
}

/// Window icon from RGBA pixels, or back to the app's own icon when `rgba` is empty
#[tauri::command]
pub fn set_window_icon(app: AppHandle, window: WebviewWindow, rgba: Vec<u8>, width: u32, height: u32) -> Result<(), String> {
    if rgba.is_empty() {
        if let Some(icon) = app.default_window_icon() {
            window.set_icon(icon.clone()).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if width == 0 || height == 0 || width > 512 || height > 512 || rgba.len() != (width * height * 4) as usize {
        return Err("bad icon size".into());
    }
    window.set_icon(Image::new_owned(rgba, width, height)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELLY_LIKE: &str = "[Desktop Entry]\nCategories=\nComment=Mod Integrate Tool\nExec=\"/home/u/.local/bin/MINTCAT Linux.AppImage\" %U\nStartupWMClass=mintcat\nIcon=mintcat\nName=mintcat\nType=Application\n\n[Desktop Action New]\nName=New\nIcon=other\n";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("mintcat-sysicon-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn exec_args_handles_quotes_and_escapes() {
        assert_eq!(exec_args(r#""/a b/c.AppImage" --x %U"#), vec!["/a b/c.AppImage", "--x", "%U"]);
        assert_eq!(exec_args(r#"env A=1 /opt/x\ y.AppImage"#), vec!["env", "A=1", "/opt/x y.AppImage"]);
        assert_eq!(exec_args(r#""""#), vec![""]);
        assert!(exec_args("   ").is_empty());
    }

    #[test]
    fn apply_and_restore_only_touch_icon_lines() {
        let applied = rewrite_entry(SHELLY_LIKE, Some("/data/mintcat-icon-1.png"), Some("mintcat"));
        assert_eq!(entry_value(&applied, "Icon").as_deref(), Some("/data/mintcat-icon-1.png"));
        assert_eq!(entry_value(&applied, ORIGINAL_KEY).as_deref(), Some("mintcat"));
        // the action group keeps its own icon, other lines unchanged
        assert!(applied.contains("[Desktop Action New]\nName=New\nIcon=other\n"));
        assert!(applied.contains("StartupWMClass=mintcat\n"));
        let restored = rewrite_entry(&applied, Some("mintcat"), None);
        assert_eq!(restored, SHELLY_LIKE);
    }

    #[test]
    fn entry_without_icon_gets_one_and_loses_it_again() {
        let plain = "[Desktop Entry]\nName=x\nExec=/a/b.AppImage";
        let applied = rewrite_entry(plain, Some("/i.png"), Some(""));
        assert_eq!(entry_value(&applied, "Icon").as_deref(), Some("/i.png"));
        assert_eq!(entry_value(&applied, ORIGINAL_KEY).as_deref(), Some(""));
        let restored = rewrite_entry(&applied, None, None);
        assert_eq!(restored, "[Desktop Entry]\nName=x\nExec=/a/b.AppImage\n");
    }

    #[test]
    fn finds_only_entries_for_this_appimage_and_round_trips() {
        let dir = temp_dir("find");
        let appimage = dir.join("MINTCAT Linux.AppImage");
        fs::write(&appimage, b"x").unwrap();
        let mine = SHELLY_LIKE.replace("/home/u/.local/bin/MINTCAT Linux.AppImage", &appimage.to_string_lossy());
        fs::write(dir.join("mintcat.desktop"), &mine).unwrap();
        fs::write(dir.join("other.desktop"), "[Desktop Entry]\nExec=/usr/bin/other\nIcon=other\n").unwrap();
        // an entry mentioning the AppImage only in another group doesn't count
        fs::write(dir.join("action.desktop"), format!("[Desktop Entry]\nExec=/usr/bin/x\n[Desktop Action A]\nExec={}\n", appimage.display())).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("mintcat.desktop"), dir.join("link.desktop")).unwrap();

        let found = find_entries(&dir, &appimage);
        assert_eq!(found, vec![dir.join("mintcat.desktop")]);

        let icon = dir.join("icons").join("mintcat-icon-1.png");
        assert!(apply_to_entry(&found[0], &icon.to_string_lossy()).unwrap());
        // applying the same icon again changes nothing
        assert!(!apply_to_entry(&found[0], &icon.to_string_lossy()).unwrap());
        // a newer picture keeps the first original
        let icon2 = dir.join("icons").join("mintcat-icon-2.png");
        assert!(apply_to_entry(&found[0], &icon2.to_string_lossy()).unwrap());
        let content = fs::read_to_string(&found[0]).unwrap();
        assert_eq!(entry_value(&content, ORIGINAL_KEY).as_deref(), Some("mintcat"));
        assert_eq!(status_of(&found, &dir.join("icons")).custom, 1);

        assert!(restore_entry(&found[0]).unwrap());
        assert_eq!(fs::read_to_string(&found[0]).unwrap(), mine);
        assert!(!restore_entry(&found[0]).unwrap());
        assert_eq!(fs::read_to_string(dir.join("other.desktop")).unwrap(), "[Desktop Entry]\nExec=/usr/bin/other\nIcon=other\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_entry_rewritten_by_the_appimage_manager_is_applied_again() {
        let dir = temp_dir("rewrite");
        let appimage = dir.join("m.AppImage");
        fs::write(&appimage, b"x").unwrap();
        let entry = dir.join("m.desktop");
        let fresh = format!("[Desktop Entry]\nExec={}\nIcon=m\n", appimage.display());
        fs::write(&entry, &fresh).unwrap();
        assert!(apply_to_entry(&entry, "/icons/a.png").unwrap());
        // e.g. Shelly writes the entry again after an update
        fs::write(&entry, &fresh).unwrap();
        assert!(apply_to_entry(&entry, "/icons/a.png").unwrap());
        assert_eq!(entry_value(&fs::read_to_string(&entry).unwrap(), "Icon").as_deref(), Some("/icons/a.png"));
        let _ = fs::remove_dir_all(&dir);
    }
}
