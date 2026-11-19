//! Linux implementation of the services layer.
//!
//! On Windows this module is where Kiro talks to the shell: it reserves a
//! screen edge for the dock (appbar), mirrors the notification area, installs
//! low-level keyboard and mouse hooks, and reads Direct3D/DXGI and WMI data.
//! None of that exists on Linux, and most of it is not even possible under
//! Wayland, so this file keeps exactly the same entry points — the rest of the
//! crate does not know which platform it is on — and fills them with the real
//! Linux equivalent where one exists:
//!
//! * media widget  -> MPRIS through `playerctl`
//! * app list      -> `.desktop` files from the XDG data dirs
//! * brightness    -> `/sys/class/backlight`
//! * volume        -> PulseAudio/PipeWire through `pactl`
//! * placement     -> plain always-on-top windows (no appbar reservation)
//!
//! Everything else (tray mirroring, live window thumbnails, foreground-window
//! tracking, WebView2 crash recovery, FPS/game boost) is a documented no-op: a
//! half-working imitation would be worse than an honest absence, and the
//! frontend already treats "empty" as "not available on this machine".

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::state::*;
use crate::types::{AppInfo, MediaInfo, SystemCommand, WindowKind};
use crate::utils::{get_kiro_scale, get_setting_str};

// ---------------------------------------------------------------------------
// State the Windows module exposes and the shared code reads
// ---------------------------------------------------------------------------

/// MPRIS player the user picked in the media card, if any.
pub static SELECTED_MEDIA_SOURCE: Mutex<Option<String>> = Mutex::new(None);
static ACTIVE_MEDIA_SOURCE: Mutex<String> = Mutex::new(String::new());
/// Last snapshot handed to the UI; `get_media_info` reads it.
pub static LAST_MEDIA: Mutex<Option<MediaInfo>> = Mutex::new(None);
/// Set when the user asks for an immediate refresh (kept for API parity).
pub static MEDIA_REFRESH: AtomicBool = AtomicBool::new(false);

/// Width of the small bottom-right notch window, in logical pixels.
pub const NOTCH_BR_WINDOW_W: f64 = 720.0;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// True when the notch lives in the bottom-right corner instead of the top edge.
pub fn notch_bottom_right(app: &AppHandle) -> bool {
    get_setting_str(app, "kiro-notch-position").as_deref() == Some("bottom-right")
}

// ---------------------------------------------------------------------------
// Window placement
// ---------------------------------------------------------------------------

/// The dock is a normal always-on-top window pinned to the bottom edge of its
/// monitor. Linux has no screen-edge reservation, so the dock overlaps whatever
/// is below it instead of shrinking the work area — exactly like the many dock
/// apps that live in the same position.
pub fn place_dock_window(app: &AppHandle, dock: &tauri::WebviewWindow) {
    let Some(monitor) =
        crate::monitors::monitor_for_window_label(app, WindowKind::Dock, dock.label())
    else {
        return;
    };
    let pos = monitor.position();
    let size = monitor.size();
    let height = dock
        .outer_size()
        .map(|s| s.height)
        .unwrap_or((90.0 * monitor.scale_factor()) as u32)
        .max(1);
    let _ = dock.set_size(tauri::PhysicalSize::new(size.width, height));
    let _ = dock.set_position(tauri::PhysicalPosition::new(
        pos.x,
        pos.y + size.height as i32 - height as i32,
    ));
    let _ = dock.set_always_on_top(true);
    if !dock.is_visible().unwrap_or(false) {
        let _ = dock.show();
    }
    set_flag(dock_appbar_registered(), dock.label(), true);
}

/// Same placement the Windows appbar code computes: full-width at the top edge,
/// or a floating pill in the bottom-right corner.
pub fn place_notch_window(app: &AppHandle, notch: &tauri::WebviewWindow) {
    let label = notch.label().to_string();
    let Some(monitor) = crate::monitors::monitor_for_window_label(app, WindowKind::Notch, &label)
    else {
        return;
    };
    let scale = monitor.scale_factor();
    let kiro_scale = get_kiro_scale(app);
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let height = (420.0 * kiro_scale * scale).round() as u32;

    let (width, x, y) = if notch_bottom_right(app) {
        let width = (NOTCH_BR_WINDOW_W * kiro_scale * scale).round() as u32;
        (
            width,
            m_pos.x + m_size.width as i32 - width as i32,
            m_pos.y + m_size.height as i32 - height as i32,
        )
    } else {
        (m_size.width, m_pos.x, m_pos.y)
    };

    let _ = notch.set_size(tauri::PhysicalSize::new(width, height));
    let _ = notch.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = notch.set_always_on_top(true);
    if !notch.is_visible().unwrap_or(false) {
        let _ = notch.show();
    }
    set_flag(main_appbar_registered(), &label, true);
}

/// The fullscreen overlay always covers exactly one monitor, so it only has to
/// follow the primary monitor when the layout changes.
pub fn sync_overlays(app: &AppHandle) {
    if OVERLAY_IN_SPLASH.load(Ordering::Relaxed) {
        return;
    }
    if let Some(ov_win) = app.get_webview_window("overlay") {
        if let Ok(Some(monitor)) = ov_win.primary_monitor() {
            let size = monitor.size();
            let pos = monitor.position();
            let _ = ov_win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
            let _ = ov_win.set_size(tauri::PhysicalSize::new(size.width, size.height));
        }
    }
}

/// Linux input handling for the notch windows.
///
/// The notch window is deliberately much larger than the pill so the panel can
/// expand inside it without moving the window. Windows hit-tests only the notch
/// rectangle, but Linux can only make a window take every event or none. The
/// window therefore starts opaque (so the notch is usable even before the
/// frontend reports its rectangle) and the watcher below keeps it click-through
/// everywhere except while the pointer is inside that rectangle: clicks in the
/// transparent part of the box reach whatever is underneath, and the webview
/// still sees the hover and the click that opens the panel.
///
/// Every request has to wait until the window is on screen: tao's
/// `set_ignore_cursor_events(true)` unwraps the window's `GdkWindow`, and a
/// panic in the GTK main loop aborts the process. That is why this cannot be
/// done from `setup`. Wayland does not report a global pointer position; there
/// the watcher leaves the window alone rather than leaving it unclickable.
pub fn watch_notch_click_through(app: AppHandle) {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    // Fast enough that the notch reacts to the pointer immediately, and a
    // handful of misses before becoming click-through again so that moving
    // from the pill into the expanding panel does not fall through the gap
    // between two rectangle reports.
    const TICK: Duration = Duration::from_millis(80);
    const MISSES_BEFORE_IGNORE: u8 = 4;
    const MARGIN: i32 = 8;

    #[derive(Default)]
    struct Track {
        // Set after the first tick that saw the window on screen; shaping it in
        // that very tick races the compositor, which may not have realised the
        // widget yet.
        seen: bool,
        misses: u8,
        applied: Option<bool>,
        logged: bool,
        note: &'static str,
    }

    // Progress markers in `KIRO_WINDOW_DEBUG`, so a headless run can tell
    // "window never shown" from "shown but no rectangle yet".
    fn note(track: &mut Track, key: &'static str) {
        if track.note == key {
            return;
        }
        track.note = key;
        if let Ok(path) = std::env::var("KIRO_WINDOW_DEBUG") {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = writeln!(f, "notch: {key}");
            }
        }
    }

    let tracks: Arc<Mutex<HashMap<String, Track>>> = Arc::new(Mutex::new(HashMap::new()));

    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);

        for (label, win) in app.webview_windows() {
            if !is_notch_label(&label) {
                continue;
            }
            let tracks = tracks.clone();
            let w = win.clone();
            // GTK/Xlib are not thread-safe here (XInitThreads is never called),
            // so everything about the window and the pointer has to be asked on
            // the GTK thread. Doing it from this thread aborted the process
            // with "Unknown request in queue while dequeuing".
            let _ = win.run_on_main_thread(move || {
                let Ok(visible) = w.is_visible() else { return };
                let Ok(mut tracks) = tracks.lock() else { return };
                let track = tracks.entry(label.clone()).or_default();

                if !visible {
                    note(track, "hidden");
                    track.seen = false;
                    track.misses = 0;
                    track.applied = None;
                    return;
                }
                if !track.seen {
                    track.seen = true;
                    note(track, "on screen");
                    return;
                }

                let Some(rect) =
                    notch_rects().lock().ok().and_then(|m| m.get(&label).copied())
                else {
                    note(track, "waiting for rectangle");
                    return;
                };
                let Some((pos, _)) = main_window_rects()
                    .lock()
                    .ok()
                    .and_then(|m| m.get(&label).copied())
                else {
                    note(track, "waiting for window position");
                    return;
                };
                // Without a global pointer (Wayland) the window keeps its
                // default, opaque behaviour instead of becoming unclickable.
                let Ok(cursor) = w.cursor_position() else {
                    note(track, "no global pointer");
                    return;
                };

                let hidden = notch_hidden()
                    .lock()
                    .ok()
                    .and_then(|m| m.get(&label).copied())
                    .unwrap_or(false);
                let over = !hidden && {
                    let scale = w.scale_factor().unwrap_or(1.0);
                    let margin = (MARGIN as f64 * scale) as i32;
                    let left = pos.x + (rect.x as f64 * scale) as i32 - margin;
                    let right = left + (rect.width as f64 * scale) as i32 + 2 * margin;
                    let top = pos.y - margin;
                    let bottom = top + (rect.height as f64 * scale) as i32 + 2 * margin;
                    cursor.x >= left as f64
                        && cursor.x <= right as f64
                        && cursor.y >= top as f64
                        && cursor.y <= bottom as f64
                };

                if over {
                    track.misses = 0;
                } else {
                    track.misses = track.misses.saturating_add(1);
                }
                let ignore = !over && track.misses >= MISSES_BEFORE_IGNORE;

                if track.applied != Some(ignore) {
                    let shaped = w.set_ignore_cursor_events(ignore).is_ok();
                    if shaped && !track.logged {
                        track.logged = true;
                        crate::diagnostics::log(&format!(
                            "notch click-through active for {label} (ignore={ignore})"
                        ));
                        // Same file the smoke test reads: seeing this line means
                        // the notch window was shown, the frontend reported its
                        // rectangle, and the input shape was applied without
                        // taking the GTK loop down.
                        if let Ok(path) = std::env::var("KIRO_WINDOW_DEBUG") {
                            use std::io::Write;
                            if let Ok(mut f) = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(path)
                            {
                                let _ =
                                    writeln!(f, "notch: click-through ignore={ignore} for {label}");
                            }
                        }
                    }
                    track.applied = Some(ignore);
                }
            });
        }
    });
}

pub fn register_appbar(window: tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    place_notch_window(&app, &window);
}

pub fn register_dock_appbar(window: tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    place_dock_window(&app, &window);
}

/// There is no appbar registration to tear down; the flag only keeps the shared
/// bookkeeping consistent.
pub fn unregister_appbar_native(_hwnd: isize) {
    // Reset by label in `monitors::destroy_monitor_window` via clear_window_state.
}

/// Keeps the per-window geometry the hit-testing code on Windows relies on, and
/// re-places the window when the compositor changes its scale.
pub fn wire_window_events(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    kind: WindowKind,
    is_dynamic: bool,
) {
    let label = window.label().to_string();

    let win_for_rect = window.clone();
    let label_for_rect = label.clone();
    let update_rect = move || {
        if let (Ok(p), Ok(s)) = (win_for_rect.outer_position(), win_for_rect.outer_size()) {
            let map = match kind {
                WindowKind::Dock => dock_window_rects(),
                WindowKind::Notch => main_window_rects(),
            };
            if let Ok(mut m) = map.lock() {
                m.insert(label_for_rect.clone(), (p, s));
            }
        }
    };
    update_rect();

    let u = update_rect.clone();
    let win_for_events = window.clone();
    let app_for_events = app.clone();
    window.on_window_event(move |e| {
        crate::memory_saver::mark_interaction();
        match e {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                u();
                sync_overlays(&app_for_events);
            }
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                let w = win_for_events.clone();
                let h = app_for_events.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    match kind {
                        WindowKind::Notch => place_notch_window(&h, &w),
                        WindowKind::Dock => place_dock_window(&h, &w),
                    }
                    sync_overlays(&h);
                });
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if is_dynamic {
                    let _ = win_for_events.hide();
                } else {
                    crate::commands::restore_taskbar_and_exit(&app_for_events);
                }
            }
            _ => {}
        }
    });
}

/// Builds the dock/notch window for an additional monitor (`all monitors` mode).
/// This is plain Tauri code, identical to the Windows version.
pub fn create_monitor_window(
    app: &AppHandle,
    kind: WindowKind,
    label: &str,
    monitor: &tauri::Monitor,
) {
    let app = app.clone();
    let label = label.to_string();
    let monitor = monitor.clone();
    let base_label = match kind {
        WindowKind::Dock => "dock",
        WindowKind::Notch => "main",
    };

    tauri::async_runtime::spawn(async move {
        let base_config = match app
            .config()
            .app
            .windows
            .iter()
            .find(|c| c.label == base_label)
        {
            Some(c) => c.clone(),
            None => return,
        };

        let mut conf = base_config;
        conf.label = label.clone();

        let pos = monitor.position();
        let scale = monitor.scale_factor();
        conf.x = Some(pos.x as f64 / scale);
        conf.y = Some(pos.y as f64 / scale);
        conf.visible = false;

        let builder = match tauri::WebviewWindowBuilder::from_config(&app, &conf) {
            Ok(b) => b,
            Err(_) => return,
        };
        let window = match builder.build() {
            Ok(w) => w,
            Err(_) => return,
        };

        // No set_ignore_cursor_events here: the window is created hidden, and
        // tao panics when the GdkWindow does not exist yet. The click-through
        // watcher applies it once the window is actually on screen.
        wire_window_events(&app, &window, kind, true);

        match kind {
            WindowKind::Dock => {
                let mode =
                    get_setting_str(&app, "kiro-dock-mode").unwrap_or_else(|| "smart".to_string());
                crate::commands::init_dock_window(&app, window, &mode).await;
            }
            WindowKind::Notch => {
                let mode = get_setting_str(&app, "kiro-notch-mode")
                    .unwrap_or_else(|| "fixed".to_string());
                crate::commands::init_notch_window(&app, window, &mode).await;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Installed applications: .desktop entries
// ---------------------------------------------------------------------------

pub(crate) fn application_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push_data_dir = |root: PathBuf| {
        let candidate = root.join("applications");
        if candidate.is_dir() {
            dirs.push(candidate);
        }
    };

    if let Some(home) = std::env::var_os("HOME") {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&home).join(".local/share"));
        push_data_dir(data_home);
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    for dir in data_dirs.split(':').filter(|d| !d.is_empty()) {
        push_data_dir(PathBuf::from(dir));
    }
    // Sandboxed packages publish their entries outside XDG_DATA_DIRS.
    for extra in [
        "/var/lib/flatpak/exports/share",
        "/var/lib/snapd/desktop",
    ] {
        push_data_dir(PathBuf::from(extra));
    }
    dirs
}

pub(crate) struct DesktopEntry {
    pub name: String,
    pub exec: String,
    pub icon: String,
    pub startup_wm_class: String,
    pub no_display: bool,
    pub hidden: bool,
    pub is_application: bool,
}

/// Reads the `[Desktop Entry]` group. Keys before the first group header belong
/// to no group and are ignored, which is what the spec asks for.
pub(crate) fn parse_desktop_entry(content: &str) -> DesktopEntry {
    let mut entry = DesktopEntry {
        name: String::new(),
        exec: String::new(),
        icon: String::new(),
        startup_wm_class: String::new(),
        no_display: false,
        hidden: false,
        is_application: false,
    };
    let mut in_entry = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Name" => entry.name = value.to_string(),
            "Exec" => entry.exec = value.to_string(),
            "Icon" => entry.icon = value.to_string(),
            "StartupWMClass" => entry.startup_wm_class = value.to_string(),
            "NoDisplay" => entry.no_display = value.eq_ignore_ascii_case("true"),
            "Hidden" => entry.hidden = value.eq_ignore_ascii_case("true"),
            "Type" => entry.is_application = value.eq_ignore_ascii_case("application"),
            _ => {}
        }
    }
    entry
}

/// `Exec=foo %U --flag` -> ("foo", "%U --flag")
pub(crate) fn split_exec(exec: &str) -> (String, Option<String>) {
    let mut parts = exec.split_whitespace();
    // Field codes like %f/%U are placeholders for files the launcher supplies;
    // Kiro launches apps without documents, so they are dropped.
    let program = parts.next().unwrap_or_default().to_string();
    let rest: Vec<&str> = parts.filter(|p| !p.starts_with('%')).collect();
    let args = if rest.is_empty() {
        None
    } else {
        Some(rest.join(" "))
    };
    (program, args)
}

fn looks_like_helper(name: &str) -> bool {
    const HELPER_WORDS: &[&str] = &[
        "uninstall",
        "uninstaller",
        "installer",
        "readme",
        "manual",
        "documentation",
        "troubleshoot",
        "troubleshooting",
        "release notes",
    ];
    let lower = name.to_lowercase();
    HELPER_WORDS.iter().any(|word| lower.contains(word))
}

/// Scans every XDG application directory for launchable entries. Runs on a
/// background thread because the first launch touches a few hundred files.
pub fn trigger_app_scan() {
    if IS_SCANNING.swap(true, Ordering::Relaxed) {
        return;
    }

    std::thread::spawn(|| {
        let mut apps: Vec<AppInfo> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for dir in application_dirs() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let parsed = parse_desktop_entry(&content);
                if !parsed.is_application || parsed.no_display || parsed.hidden {
                    continue;
                }
                if parsed.name.is_empty() || parsed.exec.is_empty() || looks_like_helper(&parsed.name)
                {
                    continue;
                }
                let (program, args) = split_exec(&parsed.exec);
                if program.is_empty() {
                    continue;
                }
                // Entries are shadowed by file name: the first directory in XDG
                // order wins, and duplicates from flatpak/snap export dirs are
                // dropped here.
                let key = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| parsed.name.clone());
                if !seen.insert(key) {
                    continue;
                }
                let executable = Path::new(&program)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string());
                apps.push(AppInfo {
                    name: parsed.name,
                    path: path.to_string_lossy().to_string(),
                    icon: None,
                    is_running: false,
                    hwnd: None,
                    executable,
                    all_hwnds: None,
                    args,
                });
            }
        }

        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        if let Some(cache) = INSTALLED_APPS_CACHE.get() {
            if let Ok(mut lock) = cache.lock() {
                *lock = apps;
            }
        }
        IS_SCANNING.store(false, Ordering::Relaxed);
    });
}

// ---------------------------------------------------------------------------
// Brightness: /sys/class/backlight
// ---------------------------------------------------------------------------

fn backlight_dir() -> Option<PathBuf> {
    let entries = std::fs::read_dir("/sys/class/backlight").ok()?;
    entries
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.join("brightness").exists() && path.join("max_brightness").exists())
}

/// Windows keeps a WMI worker because brightness can be changed from outside
/// the app (Fn keys, vendor tools). The Linux equivalent reads and writes the
/// kernel backlight device, which the desktop's own Fn-key handling also uses,
/// so both stay in sync.
pub fn setup_brightness_worker() {
    let (tx, rx) = std::sync::mpsc::channel::<u32>();
    let _ = BRIGHTNESS_SENDER.set(tx);

    std::thread::spawn(move || {
        let Some(dir) = backlight_dir() else {
            // No controllable backlight (desktop, or a driver that only exposes
            // raw values): drain the channel so senders never block.
            while rx.recv().is_ok() {}
            return;
        };
        let max = std::fs::read_to_string(dir.join("max_brightness"))
            .ok()
            .and_then(|v| v.trim().parse::<u32>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(100);

        if let Some(raw) = std::fs::read_to_string(dir.join("brightness"))
            .ok()
            .and_then(|v| v.trim().parse::<u32>().ok())
        {
            let percent = ((raw as f64 / max as f64) * 100.0).round().clamp(0.0, 100.0) as u32;
            CURRENT_BRIGHTNESS.store(percent, Ordering::Relaxed);
        }

        for percent in rx.iter() {
            let raw = ((percent.min(100) as f64 / 100.0) * max as f64)
                .round()
                .clamp(1.0, max as f64) as u32;
            let _ = std::fs::write(dir.join("brightness"), raw.to_string());
        }
    });
}

// ---------------------------------------------------------------------------
// Media: MPRIS through playerctl
// ---------------------------------------------------------------------------

fn playerctl(args: &[&str]) -> Option<String> {
    let output = Command::new("playerctl").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

fn artwork_data_url(art_url: &str) -> Option<Vec<String>> {
    let path = art_url.strip_prefix("file://")?;
    let path = if let Some(rest) = path.strip_prefix("localhost") {
        rest
    } else {
        path
    };
    let bytes = std::fs::read(path).ok()?;
    // A broken cover would make the media card render a blank rectangle, so
    // only hand back something the webview can actually decode.
    let mime = match Path::new(path).extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return None,
    };
    use base64::Engine;
    Some(vec![format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )])
}

fn select_player() -> Option<String> {
    if let Ok(selected) = SELECTED_MEDIA_SOURCE.lock() {
        if let Some(id) = selected.as_ref() {
            if !id.is_empty() {
                return Some(id.clone());
            }
        }
    }
    let out = playerctl(&["-l"])?;
    let players: Vec<&str> = out.lines().filter(|l| !l.trim().is_empty()).collect();
    players.first().map(|p| p.trim().to_string())
}

type MediaSignature = (String, String, bool, bool, Option<String>, i64);

fn poll_media(app: &AppHandle, last: &mut Option<MediaSignature>) {
    let info = read_media();
    let art_str = info.artwork.as_ref().and_then(|a| a.first()).cloned();
    let signature: MediaSignature = (
        info.title.clone(),
        info.artist.clone(),
        info.is_playing,
        info.has_media,
        art_str.clone(),
        info.position_ms,
    );
    let changed = last.as_ref().is_none_or(|previous| {
        previous.0 != signature.0
            || previous.1 != signature.1
            || previous.2 != signature.2
            || previous.3 != signature.3
            || previous.4 != signature.4
            // Position moves every second while playing; the UI extrapolates
            // from `position_updated_at`, so only re-emit on a real jump.
            || (previous.5 - signature.5).abs() > 1000
    });
    if !changed {
        return;
    }

    let art_is_new = last.as_ref().is_none_or(|previous| previous.4 != art_str);
    let mut payload = info.clone();
    if !art_is_new {
        payload.artwork = None;
    }
    if let Ok(mut stored) = LAST_MEDIA.lock() {
        *stored = Some(info.clone());
    }
    if let Ok(mut active) = ACTIVE_MEDIA_SOURCE.lock() {
        *active = info.source_id.clone();
    }
    ANY_MEDIA_PLAYING.store(info.is_playing, Ordering::Relaxed);
    let _ = app.emit("media-update", payload);
    *last = Some(signature);
}

fn read_media() -> MediaInfo {
    let empty = || MediaInfo {
        title: String::new(),
        artist: String::new(),
        is_playing: false,
        has_media: false,
        artwork: None,
        position_ms: 0,
        duration_ms: 0,
        seek_enabled: false,
        position_updated_at: 0,
        source_id: String::new(),
    };

    let Some(player) = select_player() else {
        return empty();
    };
    // One call returns everything; playerctl prints empty fields when a player
    // does not implement a property, which is why every field is optional.
    let Some(out) = playerctl(&[
        "--player",
        &player,
        "metadata",
        "--format",
        "{{status}}\t{{artist}}\t{{title}}\t{{mpris:length}}\t{{position}}\t{{mpris:artUrl}}",
    ]) else {
        return empty();
    };
    let line = out.lines().next().unwrap_or_default();
    let fields: Vec<&str> = line.split('\t').collect();
    if fields.len() < 6 {
        return empty();
    }
    let status = fields[0].trim();
    let micros = |value: &str| value.trim().parse::<i64>().unwrap_or(0);
    // MPRIS reports microseconds.
    let duration_ms = micros(fields[3]) / 1000;
    let position_ms = micros(fields[4]) / 1000;
    let title = fields[2].trim().to_string();
    let artist = fields[1].trim().to_string();
    if title.is_empty() && artist.is_empty() {
        return empty();
    }
    MediaInfo {
        title,
        artist,
        is_playing: status == "Playing",
        has_media: true,
        artwork: artwork_data_url(fields[5].trim()),
        position_ms,
        duration_ms,
        seek_enabled: duration_ms > 0,
        position_updated_at: now_ms() as u64,
        source_id: player,
    }
}

fn media_command(action: &str) {
    let Some(player) = select_player() else { return };
    let _ = Command::new("playerctl")
        .args(["--player", &player, action])
        .status();
}

// ---------------------------------------------------------------------------
// System command worker: volume keys, media keys, brightness
// ---------------------------------------------------------------------------

fn pactl(args: &[&str]) {
    let _ = Command::new("pactl").args(args).status();
}

fn default_sink() -> Option<String> {
    let output = Command::new("pactl").arg("get-default-sink").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let sink = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sink.is_empty() {
        None
    } else {
        Some(sink)
    }
}

/// Same contract as the Windows worker: it owns every system-wide action the
/// frontend triggers through `COMMAND_SENDER`. The receiver also doubles as the
/// media poller, so Kiro keeps exactly one background loop for both.
pub fn setup_system_worker(app: AppHandle) -> Sender<SystemCommand> {
    let (tx, rx) = std::sync::mpsc::channel::<SystemCommand>();
    std::thread::spawn(move || {
        let mut last_media: Option<MediaSignature> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(1500)) {
                Ok(command) => match command {
                    SystemCommand::SetVolume(volume) => {
                        let percent = (volume.clamp(0.0, 1.5) * 100.0).round() as u32;
                        CURRENT_VOLUME.store(percent.min(150), Ordering::Relaxed);
                        pactl(&["set-sink-volume", "@DEFAULT_SINK@", &format!("{percent}%")]);
                    }
                    SystemCommand::VolumeUp => pactl(&["set-sink-volume", "@DEFAULT_SINK@", "+5%"]),
                    SystemCommand::VolumeDown => {
                        pactl(&["set-sink-volume", "@DEFAULT_SINK@", "-5%"])
                    }
                    SystemCommand::VolumeMute => {
                        pactl(&["set-sink-mute", "@DEFAULT_SINK@", "toggle"])
                    }
                    SystemCommand::MediaPlayPause => media_command("play-pause"),
                    SystemCommand::MediaNext => media_command("next"),
                    SystemCommand::MediaPrevious => media_command("previous"),
                    SystemCommand::MediaSeek(position_ms) => {
                        // playerctl takes a duration string ("+12s", "45s").
                        if let Some(player) = select_player() {
                            let _ = Command::new("playerctl")
                                .args([
                                    "--player",
                                    &player,
                                    "position",
                                    &format!("{}s", (position_ms / 1000).max(0)),
                                ])
                                .status();
                        }
                    }
                    SystemCommand::BrightnessUp | SystemCommand::BrightnessDown => {
                        let step: i32 = if matches!(command, SystemCommand::BrightnessUp) {
                            5
                        } else {
                            -5
                        };
                        let current = CURRENT_BRIGHTNESS.load(Ordering::Relaxed) as i32;
                        let next = (current + step).clamp(0, 100) as u32;
                        CURRENT_BRIGHTNESS.store(next, Ordering::Relaxed);
                        if let Some(sender) = BRIGHTNESS_SENDER.get() {
                            let _ = sender.send(next);
                        }
                    }
                    // Visibility is a window concern now; MPRIS clients own
                    // play/pause and there is no universal "show desktop" verb.
                    SystemCommand::ToggleVisibility(_) => {}
                },
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            poll_media(&app, &mut last_media);
        }
    });
    tx
}

// ---------------------------------------------------------------------------
// Hooks that have no Linux equivalent
// ---------------------------------------------------------------------------

/// Wayland gives no global keyboard access, and under X11 refusing every other
/// app's labels/volume keys would be hostile. The desktop already handles them.
pub fn setup_keyboard_hook(_app: AppHandle) -> Option<()> {
    None
}

pub fn setup_taskbar_hook() {}

/// There is no portable "the foreground window changed" signal, so the media
/// poller (which is the only consumer of that signal here) runs on its own
/// timer instead.
pub fn setup_window_change_hook(app: AppHandle) {
    std::thread::spawn(move || {
        // First sample immediately so the media card is populated on startup.
        let mut last: Option<MediaSignature> = None;
        loop {
            poll_media(&app, &mut last);
            std::thread::sleep(Duration::from_millis(1500));
        }
    });
}

pub fn setup_thumbnail_capture(_app: AppHandle) {}

/// Audio visualisation needs to tap the output stream; Wayland/PipeWire requires
/// a capture session for that and a permission prompt on every start.
pub fn setup_audio_visualization(_app: AppHandle) {}

/// Logs what the process actually sees (session, backend, monitors) and makes
/// sure a broken startup is at least visible.
///
/// Kiro's main surface is a transparent always-on-top window, so "the app runs
/// but draws nothing" looks identical to "the app never started" — exactly the
/// report that came back from Linux. The fingerprint makes that distinguishable
/// in the log, and if no window is on screen after 20 seconds the Settings
/// window is opened: it is an ordinary opaque window, so the user gets a visible
/// Kiro and the log says what went wrong instead of nothing happening at all.
pub fn watch_startup_visibility(app: AppHandle) {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "?".into());
    let backend = std::env::var("GDK_BACKEND").unwrap_or_else(|_| "default".into());
    let monitors = crate::monitors::available_monitors(&app);
    crate::diagnostics::log(&format!(
        "startup: session={session} backend={backend} wayland_display={} display={} monitors={}",
        std::env::var("WAYLAND_DISPLAY").unwrap_or_else(|_| "-".into()),
        std::env::var("DISPLAY").unwrap_or_else(|_| "-".into()),
        monitors.len()
    ));
    for m in &monitors {
        let p = m.position();
        let s = m.size();
        crate::diagnostics::log(&format!(
            "startup: monitor {:?} at {}x{}+{}+{} scale {}",
            m.name(),
            s.width,
            s.height,
            p.x,
            p.y,
            m.scale_factor()
        ));
    }

    std::thread::spawn(move || {
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(500));
            if app
                .webview_windows()
                .values()
                .any(|w| w.is_visible().unwrap_or(false))
            {
                crate::diagnostics::log("startup: a window is on screen");
                return;
            }
        }
        crate::diagnostics::log(
            "startup: no window became visible after 20s; opening Settings instead of staying invisible",
        );
        crate::commands::open_settings_window(app.clone());
    });
}

/// No global mouse hook: hover is delivered per window through pointer events.
pub fn setup_mouse_hook(_app: AppHandle) {}

pub fn watch_webview_processes(_app: &AppHandle) {}

// ---------------------------------------------------------------------------
// Display changes and topmost guard
// ---------------------------------------------------------------------------

fn monitor_signature(app: &AppHandle) -> Vec<(i32, i32, u32, u32)> {
    let mut list: Vec<(i32, i32, u32, u32)> = crate::monitors::available_monitors(app)
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            (p.x, p.y, s.width, s.height)
        })
        .collect();
    list.sort_unstable();
    list
}

/// Tauri only tells us about changes to *our* windows, so a resolution change or
/// a monitor being plugged in is detected by comparing the monitor list on a
/// timer. Three seconds is fast enough to feel immediate and cheap enough to
/// keep in a always-running desktop app.
pub fn setup_display_change_monitor(app_handle: AppHandle) {
    let _ = DISPLAY_MONITOR_HANDLE.set(app_handle.clone());

    std::thread::spawn(move || {
        let mut last = monitor_signature(&app_handle);
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let now = monitor_signature(&app_handle);
            if now == last {
                continue;
            }
            last = now;
            LAST_DISPLAY_CHANGE_MS.store(now_ms(), Ordering::Relaxed);
            let ah = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                // Give the compositor a moment to finish the new layout.
                tokio::time::sleep(Duration::from_millis(400)).await;
                crate::monitors::sync_monitor_windows(&ah);
                for (label, win) in ah.webview_windows() {
                    if is_notch_label(&label) {
                        place_notch_window(&ah, &win);
                    } else if is_dock_label(&label) {
                        place_dock_window(&ah, &win);
                    }
                }
                sync_overlays(&ah);
                let _ = ah.emit("monitors-changed", ());
            });
        }
    });
}

/// Re-asserts always-on-top for Kiro's own surfaces. Some window managers drop
/// the hint when another window is mapped, which would hide the dock behind a
/// maximised app.
pub fn start_window_style_guard(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(2000));
        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            return;
        }
        for (label, win) in app.webview_windows() {
            if is_notch_label(&label) || is_dock_label(&label) || label == "overlay" {
                let keyboard_focus = KEYBOARD_FOCUS_LABEL
                    .lock()
                    .ok()
                    .is_some_and(|current| current.as_deref() == Some(label.as_str()));
                if keyboard_focus {
                    continue;
                }
                let _ = win.set_always_on_top(true);
            }
        }
    });
}
