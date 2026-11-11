//! Zip files for backups and mod settings exports, and running rclone for cloud backups.
//!
//! The frontend decides what goes into an archive; these commands only read/write zip files
//! and run the `rclone` program (nothing else can be run through them).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipInput {
    /// Path inside the archive (forward slashes)
    pub name: String,
    /// File on disk to store
    pub source: Option<String>,
    /// Or text to store directly (e.g. a manifest)
    pub content: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipItem {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

fn safe_archive_name(name: &str) -> Result<String, String> {
    let name = name.replace('\\', "/");
    let trimmed = name.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.split('/').any(|part| part == ".." || part.is_empty()) {
        return Err(format!("invalid name in archive: {name}"));
    }
    Ok(trimmed.to_string())
}

/// `<file>.<suffix>` next to `path` (keeps the whole file name, so two files never share one)
fn temp_next_to(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".{suffix}"));
    path.with_file_name(name)
}

fn create_zip(dest: &Path, entries: &[ZipInput]) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = temp_next_to(dest, "part");
    let written = (|| -> Result<(), String> {
        let file = File::create(&temp).map_err(|e| format!("{}: {e}", temp.display()))?;
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(true);
        for entry in entries {
            let name = safe_archive_name(&entry.name)?;
            zip.start_file(name.as_str(), options).map_err(|e| e.to_string())?;
            if let Some(content) = &entry.content {
                zip.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
            } else if let Some(source) = &entry.source {
                let mut input = BufReader::new(File::open(source).map_err(|e| format!("{source}: {e}"))?);
                io::copy(&mut input, &mut zip).map_err(|e| format!("{source}: {e}"))?;
            }
        }
        zip.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = written.and_then(|_| fs::rename(&temp, dest).map_err(|e| e.to_string())) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    Ok(fs::metadata(dest).map(|m| m.len()).unwrap_or(0))
}

fn list_zip(path: &str) -> Result<Vec<ZipItem>, String> {
    let file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
    let mut items = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.enclosed_name().is_none() {
            continue;
        }
        items.push(ZipItem {
            name: entry.name().to_string(),
            size: entry.size(),
            is_dir: entry.is_dir(),
        });
    }
    Ok(items)
}

fn read_zip_text(path: &str, name: &str) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
    let mut entry = archive.by_name(name).map_err(|e| e.to_string())?;
    let mut text = String::new();
    entry.read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(text)
}

fn extract_zip(path: &str, files: &[(String, String)]) -> Result<u32, String> {
    let file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
    let mut count = 0;
    for (name, dest) in files {
        let mut entry = archive.by_name(name).map_err(|e| format!("{name}: {e}"))?;
        if entry.enclosed_name().is_none() || entry.is_dir() {
            return Err(format!("invalid entry: {name}"));
        }
        let dest = PathBuf::from(dest);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = temp_next_to(&dest, "mintcat-part");
        let written = (|| -> Result<(), String> {
            let mut out = BufWriter::new(File::create(&temp).map_err(|e| format!("{}: {e}", temp.display()))?);
            io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(e) = written.and_then(|_| fs::rename(&temp, &dest).map_err(|e| e.to_string())) {
            let _ = fs::remove_file(&temp);
            return Err(e);
        }
        count += 1;
    }
    Ok(count)
}

/// Write a zip archive (written next to `dest` first, so a failure never leaves half a file).
#[tauri::command]
pub async fn zip_create(dest: String, entries: Vec<ZipInput>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || create_zip(Path::new(&dest), &entries))
        .await
        .map_err(|e| e.to_string())?
}

/// List what a zip archive contains.
#[tauri::command]
pub async fn zip_list(path: String) -> Result<Vec<ZipItem>, String> {
    tauri::async_runtime::spawn_blocking(move || list_zip(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Read one text file (e.g. a manifest) from a zip archive.
#[tauri::command]
pub async fn zip_read_text(path: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_zip_text(&path, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Extract chosen entries of a zip archive. Each pair is (name in archive, destination file);
/// destinations are written through a temporary file so a failure keeps the old file.
#[tauri::command]
pub async fn zip_extract(path: String, files: Vec<(String, String)>) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || extract_zip(&path, &files))
        .await
        .map_err(|e| e.to_string())?
}

/// Set a file's modification time (ms since 1970), e.g. to keep an imported file's own date.
#[tauri::command]
pub fn file_set_mtime(path: String, mtime_ms: u64) -> Result<(), String> {
    let time = std::time::UNIX_EPOCH + Duration::from_millis(mtime_ms);
    let file = fs::OpenOptions::new().write(true).open(&path).map_err(|e| format!("{path}: {e}"))?;
    file.set_modified(time).map_err(|e| format!("{path}: {e}"))
}

/// Make a file read-only (for everyone) or writable again (for its owner). The game can't
/// write over a read-only config file; MINTCAT lifts it for a moment when it saves one.
#[tauri::command]
pub fn file_set_readonly(path: String, readonly: bool) -> Result<(), String> {
    let mut perms = fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = perms.mode();
        perms.set_mode(if readonly { mode & !0o222 } else { mode | 0o200 });
    }
    #[cfg(not(unix))]
    perms.set_readonly(readonly);
    fs::set_permissions(&path, perms).map_err(|e| format!("{path}: {e}"))
}

static RUNNING: LazyLock<Mutex<HashMap<String, Arc<Mutex<Child>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RcloneLine {
    run_id: String,
    line: String,
}

fn read_lines<R: Read + Send + 'static>(
    reader: R,
    app: Option<(AppHandle, String)>,
) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut all = String::new();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Some((app, run_id)) = &app {
                        let _ = app.emit(
                            "rclone-output",
                            RcloneLine { run_id: run_id.clone(), line: line.trim_end().to_string() },
                        );
                    }
                    if all.len() < 4 * 1024 * 1024 {
                        all.push_str(&line);
                    }
                }
            }
        }
        all
    })
}

/// Run rclone with the given arguments (only rclone; no shell). Gives up after `timeout_secs`.
/// With a `run_id`, every output line is also sent as an "rclone-output" event as it comes
/// (used to show the sign-in link while connecting an account) and `rclone_cancel` can stop it.
#[tauri::command]
pub async fn rclone_run(
    app: AppHandle,
    args: Vec<String>,
    timeout_secs: Option<u64>,
    run_id: Option<String>,
) -> Result<CommandOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("rclone")
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == io::ErrorKind::NotFound {
                    "rclone-not-found".to_string()
                } else {
                    e.to_string()
                }
            })?;
        // Read output on threads so a chatty rclone never blocks on a full pipe
        let stream = run_id.clone().map(|id| (app.clone(), id));
        let out_thread = read_lines(child.stdout.take().unwrap(), stream.clone());
        let err_thread = read_lines(child.stderr.take().unwrap(), stream);
        let child = Arc::new(Mutex::new(child));
        if let Some(id) = &run_id {
            RUNNING.lock().unwrap().insert(id.clone(), child.clone());
        }
        let limit = Duration::from_secs(timeout_secs.unwrap_or(600));
        let started = Instant::now();
        let mut timed_out = false;
        let status = loop {
            {
                let mut guard = child.lock().unwrap();
                match guard.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) => {}
                    Err(_) => break None,
                }
                if started.elapsed() > limit {
                    let _ = guard.kill();
                    timed_out = true;
                    break guard.wait().ok();
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        if let Some(id) = &run_id {
            RUNNING.lock().unwrap().remove(id);
        }
        Ok(CommandOutput {
            code: status.and_then(|s| s.code()),
            stdout: out_thread.join().unwrap_or_default(),
            stderr: err_thread.join().unwrap_or_default(),
            timed_out,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stop an rclone run started with a `run_id` (e.g. the user closed the sign-in dialog).
#[tauri::command]
pub fn rclone_cancel(run_id: String) -> bool {
    let child = RUNNING.lock().unwrap().get(&run_id).cloned();
    match child {
        Some(child) => child.lock().unwrap().kill().is_ok(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mintcat-backup-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn input(name: &str, source: Option<&Path>, content: Option<&str>) -> ZipInput {
        ZipInput {
            name: name.to_string(),
            source: source.map(|p| p.display().to_string()),
            content: content.map(|c| c.to_string()),
        }
    }

    #[test]
    fn archive_names_are_checked() {
        assert_eq!(safe_archive_name("a/b.sav").unwrap(), "a/b.sav");
        assert_eq!(safe_archive_name("/a/b.sav").unwrap(), "a/b.sav");
        assert_eq!(safe_archive_name("a\\b.sav").unwrap(), "a/b.sav");
        for bad in ["", "/", "../x", "a/../x", "a//b", "a\\..\\b", "a/"] {
            assert!(safe_archive_name(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn zip_round_trip() {
        let dir = temp_dir("roundtrip");
        let src = dir.join("source.sav");
        fs::write(&src, b"hello settings").unwrap();
        let big = dir.join("big.pak");
        fs::write(&big, vec![7u8; 3 * 1024 * 1024]).unwrap();
        let zip = dir.join("out/backup.zip");
        let size = create_zip(&zip, &[
            input("manifest.json", None, Some("{\"kind\":\"x\"}")),
            input("SaveGames/Mods/A/source.sav", Some(&src), None),
            input("local-mods/1/big.pak", Some(&big), None),
        ]).unwrap();
        assert!(size > 0 && zip.exists());
        assert!(!temp_next_to(&zip, "part").exists());

        let items = list_zip(&zip.display().to_string()).unwrap();
        let names: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["manifest.json", "SaveGames/Mods/A/source.sav", "local-mods/1/big.pak"]);
        assert_eq!(items[2].size, 3 * 1024 * 1024);
        assert_eq!(read_zip_text(&zip.display().to_string(), "manifest.json").unwrap(), "{\"kind\":\"x\"}");

        // extract over an existing file and into a new folder
        let target = dir.join("game/SaveGames/Mods/A/source.sav");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"old").unwrap();
        let other = dir.join("restored/big.pak");
        let count = extract_zip(&zip.display().to_string(), &[
            ("SaveGames/Mods/A/source.sav".into(), target.display().to_string()),
            ("local-mods/1/big.pak".into(), other.display().to_string()),
        ]).unwrap();
        assert_eq!(count, 2);
        assert_eq!(fs::read(&target).unwrap(), b"hello settings");
        assert_eq!(fs::read(&other).unwrap().len(), 3 * 1024 * 1024);
        assert!(!temp_next_to(&target, "mintcat-part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_zip_leaves_nothing_behind() {
        let dir = temp_dir("fail");
        let zip = dir.join("backup.zip");
        let missing = dir.join("missing.pak");
        assert!(create_zip(&zip, &[input("a.pak", Some(&missing), None)]).is_err());
        assert!(create_zip(&zip, &[input("../evil", None, Some("x"))]).is_err());
        assert!(!zip.exists());
        assert!(!temp_next_to(&zip, "part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_extract_keeps_the_old_file() {
        let dir = temp_dir("extract-fail");
        let zip = dir.join("b.zip");
        create_zip(&zip, &[input("a.sav", None, Some("new"))]).unwrap();
        let target = dir.join("a.sav");
        fs::write(&target, b"old").unwrap();
        // the second name doesn't exist: the call fails, the first file was already replaced,
        // the missing one leaves no temp file and nothing else is touched
        let result = extract_zip(&zip.display().to_string(), &[
            ("nope.sav".into(), target.display().to_string()),
        ]);
        assert!(result.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert!(!temp_next_to(&target, "mintcat-part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mtime_is_set() {
        let dir = temp_dir("mtime");
        let f = dir.join("x.sav");
        fs::write(&f, b"x").unwrap();
        file_set_mtime(f.display().to_string(), 1_790_870_400_000).unwrap();
        let modified = fs::metadata(&f).unwrap().modified().unwrap();
        let ms = modified.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        assert_eq!(ms, 1_790_870_400_000);
        assert!(file_set_mtime(dir.join("missing").display().to_string(), 0).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn readonly_round_trip() {
        let dir = temp_dir("readonly");
        let f = dir.join("Engine.ini");
        fs::write(&f, b"[Core.System]").unwrap();
        let p = f.display().to_string();
        file_set_readonly(p.clone(), true).unwrap();
        assert!(fs::metadata(&f).unwrap().permissions().readonly());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o222, 0);
        }
        file_set_readonly(p.clone(), false).unwrap();
        assert!(!fs::metadata(&f).unwrap().permissions().readonly());
        fs::write(&f, b"changed").unwrap();
        assert!(file_set_readonly(dir.join("missing.ini").display().to_string(), true).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn temp_names_keep_the_whole_file_name() {
        assert_eq!(temp_next_to(Path::new("/a/b.zip"), "part"), PathBuf::from("/a/b.zip.part"));
        assert_eq!(temp_next_to(Path::new("/a/Settings"), "mintcat-part"), PathBuf::from("/a/Settings.mintcat-part"));
        assert_ne!(temp_next_to(Path::new("/a/x.sav"), "p"), temp_next_to(Path::new("/a/x.cfg"), "p"));
    }
}
