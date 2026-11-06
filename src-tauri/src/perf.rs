//! Automatic performance mode.
//!
//! When a fullscreen app (a game, a video player, a fullscreen call) owns the
//! screen, the dock/notch are hidden anyway, so there is no reason to keep
//! spending CPU and GPU on them. In this mode Kiro:
//!
//! * stops capturing window thumbnails and icons,
//! * slows the foreground and mouse polling loops down,
//! * stops trimming its own working set (page faults would only fight the game
//!   for disk I/O),
//! * tells the frontend to drop blur and animations (`perf-mode` event).
//!
//! Everything is restored automatically when the fullscreen app goes away.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

/// Setting key that allows the user to turn the behaviour off.
pub const SETTING: &str = "nectar-auto-perf";

/// A window has to stay fullscreen this long before the mode engages. Splash
/// screens, alt-tab animations and screenshot tools go fullscreen for a moment
/// and must not make the UI flicker.
const HOLD: Duration = Duration::from_millis(1500);

static ACTIVE: AtomicBool = AtomicBool::new(false);
static SINCE: Mutex<Option<Instant>> = Mutex::new(None);

/// True while the automatic performance mode is engaged.
pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

fn enabled(app: &AppHandle) -> bool {
    // Default on: the whole point of the mode is that it requires no setup.
    crate::utils::get_setting_str(app, SETTING)
        .map(|v| v != "false")
        .unwrap_or(true)
}

fn deactivate(app: &AppHandle) {
    if let Ok(mut since) = SINCE.lock() {
        *since = None;
    }
    if ACTIVE.swap(false, Ordering::Relaxed) {
        crate::diagnostics::log("auto perf mode: off");
        let _ = app.emit("perf-mode", false);
    }
}

/// Re-evaluate the mode. Called from the foreground watcher on every tick, so
/// it reacts within one polling interval of a game starting or closing.
pub fn update(app: &AppHandle, fullscreen: bool, window_title: &str) {
    if !fullscreen || !enabled(app) {
        deactivate(app);
        return;
    }

    let Ok(mut since) = SINCE.lock() else {
        return;
    };
    let start = *since.get_or_insert_with(Instant::now);
    if start.elapsed() < HOLD || ACTIVE.load(Ordering::Relaxed) {
        return;
    }

    ACTIVE.store(true, Ordering::Relaxed);
    drop(since);
    crate::diagnostics::log(&format!(
        "auto perf mode: on (fullscreen app in foreground: {window_title})"
    ));
    let _ = app.emit("perf-mode", true);
}

/// Current state, for the frontend to sync right after a window is created.
pub fn state() -> bool {
    active()
}
