//! Tells the page when the clipboard was set again, also with the same text. Polling the text
//! can't see a link copied a second time (after removing that mod, say), so the system's own
//! notifications are counted: Wayland's data-control protocol (KDE, wlroots compositors; works
//! while the window isn't focused) or X11's XFixes (X11 sessions, and XWayland elsewhere).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static CHANGES: AtomicU64 = AtomicU64::new(0);
/// When the clipboard was last emptied (its owner quit)
static EMPTIED: Mutex<Option<Instant>> = Mutex::new(None);
/// A clipboard manager (e.g. KDE's Klipper) puts the last text back right after its owner quits;
/// that is not a new copy
const RESTORE_WINDOW: Duration = Duration::from_millis(1500);
static WATCHING: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
/** 0: none, 1: Wayland, 2: X11 */
static MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// How the clipboard is watched, for the Log
pub fn mode() -> &'static str {
    if !WATCHING.load(Ordering::SeqCst) {
        return "off";
    }
    match MODE.load(Ordering::SeqCst) {
        1 => "Wayland data-control",
        2 => "X11 XFixes",
        _ => "off",
    }
}

/// Starts watching in the background (once); without a way to watch, nothing happens
pub fn start() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::thread::Builder::new()
            .name("clipboard-watch".into())
            .spawn(|| {
                if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                    match linux::wayland() {
                        Ok(()) => return,
                        Err(e) => log::info!("[Clipboard] Wayland clipboard watch unavailable: {e}"),
                    }
                }
                if std::env::var_os("DISPLAY").is_some() {
                    if let Err(e) = linux::x11() {
                        log::info!("[Clipboard] X11 clipboard watch unavailable: {e}");
                    }
                }
                WATCHING.store(false, Ordering::SeqCst);
            });
    }
}

fn changed() {
    let restored = EMPTIED.lock().map(|mut t| t.take().is_some_and(|at| at.elapsed() < RESTORE_WINDOW)).unwrap_or(false);
    if !restored {
        CHANGES.fetch_add(1, Ordering::SeqCst);
    }
}

fn emptied() {
    if let Ok(mut t) = EMPTIED.lock() {
        *t = Some(Instant::now());
    }
}

/// How many times the clipboard was set so far, or None when it can't be watched here
#[tauri::command]
pub fn clipboard_change_count() -> Option<u64> {
    if WATCHING.load(Ordering::SeqCst) {
        Some(CHANGES.load(Ordering::SeqCst))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{changed, emptied, WATCHING};
    use std::sync::atomic::Ordering;

    pub fn wayland() -> Result<(), String> {
        use wl_clipboard_rs::paste::Seat;
        use wl_clipboard_rs::watch::{ClipboardEvent, ClipboardType, Watcher};
        let mut watcher = Watcher::new(ClipboardType::Regular, Seat::Unspecified).map_err(|e| e.to_string())?;
        super::MODE.store(1, Ordering::SeqCst);
        WATCHING.store(true, Ordering::SeqCst);
        loop {
            match watcher.next_event() {
                // set, also with the same text
                Ok(Some(ClipboardEvent::Changed { .. })) => changed(),
                Ok(Some(ClipboardEvent::Cleared { .. })) => emptied(),
                Ok(None) => return Ok(()),
                Err(e) => {
                    WATCHING.store(false, Ordering::SeqCst);
                    return Err(e.to_string());
                }
            }
        }
    }

    pub fn x11() -> Result<(), String> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEvent, SelectionEventMask};
        use x11rb::protocol::xproto::ConnectionExt as _;
        use x11rb::protocol::Event;
        let err = |e: &dyn std::fmt::Display| e.to_string();
        let (conn, screen) = x11rb::connect(None).map_err(|e| err(&e))?;
        conn.xfixes_query_version(5, 0).map_err(|e| err(&e))?.reply().map_err(|e| err(&e))?;
        let root = conn.setup().roots[screen].root;
        let clipboard = conn.intern_atom(false, b"CLIPBOARD").map_err(|e| err(&e))?.reply().map_err(|e| err(&e))?.atom;
        conn.xfixes_select_selection_input(
            root,
            clipboard,
            SelectionEventMask::SET_SELECTION_OWNER
                | SelectionEventMask::SELECTION_WINDOW_DESTROY
                | SelectionEventMask::SELECTION_CLIENT_CLOSE,
        )
        .map_err(|e| err(&e))?;
        conn.flush().map_err(|e| err(&e))?;
        super::MODE.store(2, Ordering::SeqCst);
        WATCHING.store(true, Ordering::SeqCst);
        loop {
            match conn.wait_for_event() {
                Ok(Event::XfixesSelectionNotify(e)) => {
                    if e.subtype == SelectionEvent::SET_SELECTION_OWNER && e.owner != x11rb::NONE {
                        changed();
                    } else {
                        emptied();
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    WATCHING.store(false, Ordering::SeqCst);
                    return Err(e.to_string());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_after_owner_quit_is_not_a_copy() {
        let start = CHANGES.load(Ordering::SeqCst);
        changed();
        assert_eq!(CHANGES.load(Ordering::SeqCst), start + 1, "a copy counts");
        changed();
        assert_eq!(CHANGES.load(Ordering::SeqCst), start + 2, "the same text copied again counts");
        emptied();
        changed();
        assert_eq!(CHANGES.load(Ordering::SeqCst), start + 2, "a clipboard manager putting it back doesn't");
        changed();
        assert_eq!(CHANGES.load(Ordering::SeqCst), start + 3, "the next copy counts again");
    }
}
