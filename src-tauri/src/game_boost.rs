//! Native game boost.
//!
//! Kiro's dock and notch are transparent, layered, always-on-top windows that
//! cover a big part of the screen even when their content has been moved
//! off-screen with CSS. DWM still has to composite those windows on top of
//! whatever is running, so a fullscreen game loses independent flip (direct
//! scanout) and renders through the compositor instead of straight to the
//! display. That costs a noticeable amount of frame rate.
//!
//! While a fullscreen game owns a monitor this module hides the dock/notch
//! windows on *that* monitor at the OS level (`ShowWindow(SW_HIDE)`). A hidden
//! window is not part of the composition tree at all, which gives the game its
//! flip path back. Only windows that were visible when the game started are
//! hidden, and only those are shown again when the game exits, so a dock the
//! user turned off stays off and the other monitors keep their UI.
//!
//! This is deliberately independent from `perf.rs`: the user can keep the
//! automatic performance mode on while turning native hiding off (or the other
//! way around). The foreground watcher passes the fullscreen state and the
//! monitor origin, both already computed there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoA, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};

/// Setting key that lets the user turn native hiding off.
pub const SETTING: &str = "kiro-game-boost";

/// A window has to stay fullscreen this long before we touch it. Splash
/// screens, alt-tab animations and screenshot tools go fullscreen for a moment
/// and must not make the UI flicker.
const HOLD: Duration = Duration::from_millis(1500);

/// Once the game disappears, wait this long before giving the windows back.
/// Focus blips (notifications, our own OSD) would otherwise toggle visibility
/// several times a minute.
const RELEASE_HOLD: Duration = Duration::from_millis(1200);

static ACTIVE: AtomicBool = AtomicBool::new(false);
static ACTIVE_SINCE: Mutex<Option<Instant>> = Mutex::new(None);
static RELEASE_SINCE: Mutex<Option<Instant>> = Mutex::new(None);
/// Labels of the windows we hid, so we only show those again.
static HIDDEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Monitor the hidden windows belong to, so a game moving to another monitor
/// retargets the hide instead of leaving the old monitor empty.
static HIDDEN_MONITOR: Mutex<Option<(i32, i32)>> = Mutex::new(None);

fn enabled(app: &AppHandle) -> bool {
    // Default on: this is the main source of the FPS win.
    crate::utils::get_setting_str(app, SETTING)
        .map(|v| v != "false")
        .unwrap_or(true)
}

fn monitor_origin(hwnd: HWND) -> Option<(i32, i32)> {
    unsafe {
        let h_monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoA(h_monitor, &mut mi).as_bool() {
            Some((mi.rcMonitor.left, mi.rcMonitor.top))
        } else {
            None
        }
    }
}

/// Dock and notch windows that are visible right now and live on the game's
/// monitor. If the monitor is unknown we hide all of them: a game is fullscreen
/// anyway, so nothing on screen would be usable regardless.
fn target_windows(app: &AppHandle, game_monitor: Option<(i32, i32)>) -> Vec<(String, tauri::WebviewWindow)> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, win)| {
            if !(crate::state::is_dock_label(label) || crate::state::is_notch_label(label)) {
                return false;
            }
            if !win.is_visible().unwrap_or(false) {
                return false;
            }
            match (game_monitor, win.hwnd().ok().and_then(monitor_origin)) {
                (Some(want), Some(have)) => want == have,
                // Unknown monitor for either side: keep the FPS win.
                _ => true,
            }
        })
        .collect()
}

fn engage(app: &AppHandle, game_monitor: Option<(i32, i32)>) {
    let windows = target_windows(app, game_monitor);
    let mut hidden = match HIDDEN.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    hidden.clear();
    for (label, win) in windows {
        if win.hide().is_ok() {
            hidden.push(label);
        }
    }
    if let Ok(mut monitor) = HIDDEN_MONITOR.lock() {
        *monitor = game_monitor;
    }
    ACTIVE.store(true, Ordering::Relaxed);
    crate::diagnostics::log(&format!(
        "game boost: hiding {} dock/notch window(s) for direct scanout",
        hidden.len()
    ));
}

/// Show the windows we hid. Anything else stays untouched.
fn release(app: &AppHandle) {
    let labels = match HIDDEN.lock() {
        Ok(mut hidden) => std::mem::take(&mut *hidden),
        Err(_) => Vec::new(),
    };
    let was_active = ACTIVE.swap(false, Ordering::Relaxed);
    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.show();
        }
    }
    if let Ok(mut monitor) = HIDDEN_MONITOR.lock() {
        *monitor = None;
    }
    if was_active {
        crate::diagnostics::log("game boost: off");
    }
}

fn clear_timers() {
    if let Ok(mut since) = ACTIVE_SINCE.lock() {
        *since = None;
    }
    if let Ok(mut since) = RELEASE_SINCE.lock() {
        *since = None;
    }
}

/// Hide any relevant window that became visible again while the boost is on
/// (a monitor window created mid-game, a stray `show()` from the shell).
fn hide_new(app: &AppHandle, game_monitor: Option<(i32, i32)>) {
    let windows = target_windows(app, game_monitor);
    if windows.is_empty() {
        return;
    }
    let Ok(mut hidden) = HIDDEN.lock() else {
        return;
    };
    for (label, win) in windows {
        if win.hide().is_ok() && !hidden.contains(&label) {
            hidden.push(label);
        }
    }
}

/// Re-evaluate the boost. Called from the foreground watcher on every tick.
pub fn update(app: &AppHandle, fullscreen: bool, game_monitor: Option<(i32, i32)>) {
    if !enabled(app) {
        release(app);
        clear_timers();
        return;
    }

    if !fullscreen {
        if !ACTIVE.load(Ordering::Relaxed) {
            clear_timers();
            return;
        }
        let give_back = match RELEASE_SINCE.lock() {
            Ok(mut since) => {
                let start = *since.get_or_insert_with(Instant::now);
                start.elapsed() >= RELEASE_HOLD
            }
            Err(_) => true,
        };
        if give_back {
            release(app);
            clear_timers();
        }
        return;
    }

    if let Ok(mut since) = RELEASE_SINCE.lock() {
        *since = None;
    }

    if !ACTIVE.load(Ordering::Relaxed) {
        let Ok(mut since) = ACTIVE_SINCE.lock() else {
            return;
        };
        let start = *since.get_or_insert_with(Instant::now);
        if start.elapsed() < HOLD {
            return;
        }
        drop(since);
        engage(app, game_monitor);
        return;
    }

    let hidden_monitor = HIDDEN_MONITOR.lock().ok().and_then(|m| *m);
    // Only retarget when both sides know their monitor. A focus blip can make
    // the fullscreen flag sticky for a moment while the foreground window is
    // already on another monitor; treating that as "the game moved" would hide
    // (and later re-show) the UI on the wrong screen.
    if let (Some(current), Some(want)) = (hidden_monitor, game_monitor) {
        if current != want {
            release(app);
            engage(app, game_monitor);
            return;
        }
    }

    hide_new(app, hidden_monitor);
}
