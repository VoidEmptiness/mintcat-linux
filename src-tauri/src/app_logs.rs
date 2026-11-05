//! MINTCAT's log files: one per launch, plus what the Log panel showed during that launch,
//! so earlier launches can be looked at again. The oldest launches are deleted once there are
//! more than the number kept (Settings → Logs).
//!
//! In the app's log folder (~/.local/share/com.mint.cat/logs):
//!   mintcat_2026-11-05_12-57-03.log      full log of the launch (the log plugin writes it;
//!                                        a launch over 50 MB continues in a second file
//!                                        starting with the same name)
//!   activity_2026-11-05_12-57-03.jsonl   the Log panel's entries of that launch
//!   mintcat.log                          everything from builds before per-launch logs
//! Only files named like these are ever listed, read or deleted.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, Runtime};

const STAMP_LEN: usize = 19; // 2026-11-05_12-57-03
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ACTIVITY_BYTES: u64 = 20 * 1024 * 1024;
/// Name the old single log file had
const LEGACY_LOG: &str = "mintcat.log";
const LEGACY_STAMP: &str = "0000-00-00_00-00-00";

/// When this launch started, as used in its file names (local time)
pub fn session_stamp() -> &'static str {
    static STAMP: OnceLock<String> = OnceLock::new();
    STAMP.get_or_init(|| chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string())
}

/// Log plugin file name (without ".log") for this launch
pub fn session_log_name() -> String {
    format!("mintcat_{}", session_stamp())
}

fn is_stamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == STAMP_LEN
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            10 => *b == b'_',
            13 | 16 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LogFileKind {
    Log,
    Activity,
}

/// The launch a file belongs to, if it's one of MINTCAT's log files
fn classify(name: &str) -> Option<(String, LogFileKind)> {
    if name == LEGACY_LOG {
        return Some((LEGACY_STAMP.to_string(), LogFileKind::Log));
    }
    if let Some(rest) = name.strip_prefix("mintcat_") {
        let stamp = rest.get(..STAMP_LEN)?;
        let tail = &rest[STAMP_LEN..];
        // "…03.log" or a continuation "…03_<anything>.log" (plugin rotation)
        if is_stamp(stamp) && name.ends_with(".log") && (tail == ".log" || tail.starts_with('_')) && !name.contains('/') {
            return Some((stamp.to_string(), LogFileKind::Log));
        }
        return None;
    }
    if let Some(rest) = name.strip_prefix("activity_") {
        let stamp = rest.strip_suffix(".jsonl")?;
        if is_stamp(stamp) {
            return Some((stamp.to_string(), LogFileKind::Activity));
        }
    }
    None
}

fn log_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_log_dir().map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub name: String,
    pub kind: LogFileKind,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSession {
    /// "2026-11-05_12-57-03", or "0000-00-00_00-00-00" for the log of earlier builds
    pub stamp: String,
    pub current: bool,
    /// Last change of its files (ms since 1970)
    pub modified_ms: u64,
    pub files: Vec<LogFileInfo>,
}

fn sessions_in(dir: &Path) -> Vec<LogSession> {
    let mut by_stamp: BTreeMap<String, LogSession> = BTreeMap::new();
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((stamp, kind)) = classify(&name) else { continue };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let session = by_stamp.entry(stamp.clone()).or_insert_with(|| LogSession {
            current: stamp == session_stamp(),
            stamp,
            modified_ms: 0,
            files: Vec::new(),
        });
        session.modified_ms = session.modified_ms.max(modified_ms);
        session.files.push(LogFileInfo { name, kind, size: meta.len() });
    }
    let mut sessions: Vec<LogSession> = by_stamp.into_values().collect();
    for session in &mut sessions {
        session.files.sort_by(|a, b| a.name.cmp(&b.name));
    }
    // newest first (the stamps sort by time; the old single log is the oldest)
    sessions.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    sessions
}

/// Which sessions go when only `keep` are kept: the oldest, never the current one
fn sessions_to_remove(sessions: &[LogSession], keep: usize) -> Vec<&LogSession> {
    let keep = keep.max(1);
    let mut kept = 0;
    let mut remove = Vec::new();
    for session in sessions {
        if session.current {
            kept += 1;
            continue;
        }
        if kept < keep {
            kept += 1;
        } else {
            remove.push(session);
        }
    }
    remove
}

#[tauri::command]
pub fn list_app_logs<R: Runtime>(app: AppHandle<R>) -> Result<Vec<LogSession>, String> {
    Ok(sessions_in(&log_dir(&app)?))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneResult {
    pub removed_files: u32,
    pub removed_bytes: u64,
}

/// Delete the logs of all but the newest `keep` launches (this one always stays)
#[tauri::command]
pub fn prune_app_logs<R: Runtime>(app: AppHandle<R>, keep: u32) -> Result<PruneResult, String> {
    let dir = log_dir(&app)?;
    let sessions = sessions_in(&dir);
    let mut result = PruneResult { removed_files: 0, removed_bytes: 0 };
    for session in sessions_to_remove(&sessions, keep as usize) {
        for file in &session.files {
            // checked again by name right before deleting
            if classify(&file.name).is_none() {
                continue;
            }
            let path = dir.join(&file.name);
            match fs::remove_file(&path) {
                Ok(()) => {
                    result.removed_files += 1;
                    result.removed_bytes += file.size;
                }
                Err(e) => log::warn!("[AppLogs] could not delete {}: {}", file.name, e),
            }
        }
    }
    if result.removed_files > 0 {
        log::info!("[AppLogs] removed {} old log file(s), keeping {} launch(es)", result.removed_files, keep.max(1));
    }
    Ok(result)
}

/// Add Log panel entries (JSON lines) to this launch's activity file
#[tauri::command]
pub fn append_activity_log<R: Runtime>(app: AppHandle<R>, lines: String) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let dir = log_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("activity_{}.jsonl", session_stamp()));
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_ACTIVITY_BYTES {
        return Ok(()); // a runaway launch doesn't fill the disk
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    let mut text = lines;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

/// Text of one of MINTCAT's log files (the last 4 MB of a bigger one)
#[tauri::command]
pub fn read_app_log<R: Runtime>(app: AppHandle<R>, name: String) -> Result<String, String> {
    if classify(&name).is_none() || name.contains('/') || name.contains('\\') {
        return Err("not a log file".into());
    }
    let path = log_dir(&app)?.join(&name);
    let len = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let bytes = if len > MAX_READ_BYTES {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(len - MAX_READ_BYTES)).map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(MAX_READ_BYTES as usize);
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        // start at a whole line
        match buf.iter().position(|b| *b == b'\n') {
            Some(i) => buf[i + 1..].to_vec(),
            None => buf,
        }
    } else {
        fs::read(&path).map_err(|e| e.to_string())?
    };
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(classify("mintcat.log").unwrap().0, LEGACY_STAMP);
        assert_eq!(classify("mintcat_2026-11-05_12-57-03.log").unwrap(), ("2026-11-05_12-57-03".into(), LogFileKind::Log));
        assert_eq!(classify("mintcat_2026-11-05_12-57-03_2026-11-05_13-00-00.log").unwrap().0, "2026-11-05_12-57-03");
        assert_eq!(classify("activity_2026-11-05_12-57-03.jsonl").unwrap().1, LogFileKind::Activity);
        for other in ["mintcat_2026-11-05.log", "mintcat_2026-11-05_12-57-03.txt", "notes.log", "mintcat_2026-11-05_12-57-03x.log",
            "activity_2026-11-05_12-57-03.json", "mintcat.log.bak", "Mintcat.log"] {
            assert!(classify(other).is_none(), "{other}");
        }
    }

    #[test]
    fn keeps_newest_and_current() {
        let session = |stamp: &str, current: bool| LogSession { stamp: stamp.into(), current, modified_ms: 0, files: vec![] };
        let sessions = vec![
            session("2026-11-05_12-00-00", true),
            session("2026-11-04_12-00-00", false),
            session("2026-11-03_12-00-00", false),
            session(LEGACY_STAMP, false),
        ];
        let removed: Vec<&str> = sessions_to_remove(&sessions, 2).iter().map(|s| s.stamp.as_str()).collect();
        assert_eq!(removed, vec!["2026-11-03_12-00-00", LEGACY_STAMP]);
        assert_eq!(sessions_to_remove(&sessions, 0).len(), 3); // at least this launch stays
        assert!(sessions_to_remove(&sessions, 10).is_empty());
    }
}
