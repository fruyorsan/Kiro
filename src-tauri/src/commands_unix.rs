//! Linux implementations for the commands that are pure Win32 integration on
//! Windows.
//!
//! The rule used throughout this file: do the real thing when Linux has a
//! portable equivalent (NetworkManager for Wi-Fi, `pactl` for volume, `/proc`
//! for processes and memory, `.desktop` files for app launching and icons), and
//! return an honest empty/default value when it does not. Nothing here panics
//! or blocks the UI: the frontend already treats "empty" as "this panel has
//! nothing to show on this machine".

use base64::Engine;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, Window};

use crate::commands::{AppMediaSession, DockDrive, ProcessInfo};
use crate::state::*;
use crate::types::{AppInfo, AudioSessionInfo, VolumeChangeEvent, WifiStatus};
use crate::utils::get_setting_str;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program} is not available: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() { format!("{program} failed") } else { stderr });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn have(program: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {program}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn percent_to_unit(text: &str) -> Option<f32> {
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let digits: String = text[start..].chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok().map(|p| (p as f32 / 100.0).clamp(0.0, 1.5))
}

fn default_sink() -> Option<String> {
    run("pactl", &["get-default-sink"]).ok().map(|s| s.trim().to_string())
}

fn active_wifi_ssid() -> Option<String> {
    let out = run("nmcli", &["-t", "-f", "ACTIVE,SSID", "device", "wifi"]).ok()?;
    out.lines().find_map(|line| {
        let mut fields = line.splitn(2, ':');
        if fields.next()? == "yes" {
            fields.next().map(|s| s.to_string())
        } else {
            None
        }
    })
}

// ---------------------------------------------------------------------------
// window / shell lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn set_window_keyboard_focus(window: Window, enabled: bool) {
    if let Ok(mut label) = crate::state::KEYBOARD_FOCUS_LABEL.lock() {
        if enabled {
            *label = Some(window.label().to_string());
        } else if label.as_deref() == Some(window.label()) {
            *label = None;
        }
    }
    // X11/Wayland window managers decide focus; asking for it is all a client
    // may do, and only while the user is actually typing into Kiro.
    if enabled {
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub async fn init_dock(app: AppHandle, _mode: String) {
    let enabled = get_setting_str(&app, "kiro-dock-enabled").unwrap_or_else(|| "true".into());
    let Some(dock) = app.get_webview_window("dock") else { return };
    if enabled != "true" {
        let _ = dock.hide();
        return;
    }
    crate::services::place_dock_window(&app, &dock);
}

pub async fn init_dock_window(app: &AppHandle, dock_win: tauri::WebviewWindow, _mode: &str) {
    crate::services::place_dock_window(app, &dock_win);
}

#[tauri::command]
pub async fn toggle_dock(app: AppHandle, enable: bool) {
    let Some(dock) = app.get_webview_window("dock") else { return };
    if enable {
        let mode = get_setting_str(&app, "kiro-dock-mode").unwrap_or_else(|| "smart".into());
        init_dock(app.clone(), mode).await;
    } else {
        let _ = dock.hide();
        crate::state::set_flag(crate::state::dock_appbar_registered(), dock.label(), false);
    }
}

#[tauri::command]
pub async fn sync_appbar(app: AppHandle) {
    // Called whenever geometry settings change. Re-run the same positioning the
    // init paths use, then refresh the fullscreen overlay.
    let dock_enabled = get_setting_str(&app, "kiro-dock-enabled").unwrap_or_else(|| "true".into());
    for (label, win) in app.webview_windows() {
        if crate::state::is_notch_label(&label) {
            crate::services::place_notch_window(&app, &win);
        } else if crate::state::is_dock_label(&label) && dock_enabled == "true" {
            crate::services::place_dock_window(&app, &win);
        }
    }
    crate::services::sync_overlays(&app);
}

pub async fn init_notch_window(app: &AppHandle, main_win: tauri::WebviewWindow, _mode: &str) {
    crate::services::place_notch_window(app, &main_win);
}

/// Linux has no DWM/acrylic affordance to hand back to the compositor, and
/// there is no notification area to mirror: the dock simply has no tray button.
#[tauri::command]
pub fn hide_native_osd() {}
#[tauri::command]
pub fn open_tray_at_cursor() {}
#[tauri::command]
pub fn open_tray_from_button(_dx: f64, _dy: f64) {}
#[tauri::command]
pub fn show_desktop() {
    let _ = run("wmctrl", &["-k", "on"]);
}

#[tauri::command]
pub fn open_wifi_settings() {
    let candidates = ["gnome-control-center wifi", "systemsettings kcm_networkmanagement", "xfce4-network-settings"];
    for candidate in candidates {
        let mut parts = candidate.split(' ');
        if let Some(program) = parts.next() {
            if have(program) {
                let _ = Command::new(program).args(parts).spawn();
                return;
            }
        }
    }
}

#[tauri::command]
pub fn open_sound_settings() {
    let _ = Command::new("pavucontrol").spawn();
}

#[tauri::command]
pub fn open_notification_center() {}

#[tauri::command]
pub fn open_bluetooth_settings() {
    let _ = Command::new("bluetoothctl").arg("show").spawn();
}

#[tauri::command]
pub fn open_airplane_mode_settings() {}

#[tauri::command]
pub fn restore_taskbar_and_exit(handle: &AppHandle) {
    SHUTTING_DOWN.store(true, Ordering::Relaxed);
    handle.exit(0);
}

#[tauri::command]
pub async fn uninstall_kiro(_handle: AppHandle) -> Result<(), String> {
    Err("Remove Kiro with your package manager or by deleting the AppImage.".into())
}

// ---------------------------------------------------------------------------
// processes, drives, launching
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_drives() -> Vec<DockDrive> {
    let mut drives = vec![DockDrive {
        letter: "/".into(),
        label: "File System".into(),
        removable: false,
    }];
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else { return drives };
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(device), Some(mount)) = (fields.next(), fields.next()) else { continue };
        let removable = device.starts_with("/dev/sd") || device.starts_with("/dev/mmcblk");
        let user_mount = mount.starts_with("/media/")
            || mount.starts_with("/run/media/")
            || mount.starts_with("/mnt/");
        if !(removable && user_mount) {
            continue;
        }
        if drives.iter().any(|d| d.letter == mount) {
            continue;
        }
        let label = std::path::Path::new(mount)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| mount.to_string());
        drives.push(DockDrive { letter: mount.to_string(), label, removable: true });
    }
    drives
}

#[tauri::command]
pub async fn open_app(_app: AppHandle, _window: Window, app_name: String, args: Option<String>) {
    let mut argv: Vec<String> = Vec::new();
    if let Some(extra) = args.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        // Split on whitespace; Kiro only ever hands over simple launch arguments.
        argv.extend(extra.split_whitespace().map(|s| s.to_string()));
    }
    let mut command = if app_name.ends_with(".desktop") {
        let mut c = Command::new("gio");
        c.arg("launch").arg(&app_name);
        c
    } else {
        let mut c = Command::new(&app_name);
        c.args(&argv);
        c
    };
    let _ = command.spawn();
}

#[tauri::command]
pub async fn activate_app(app: AppInfo) -> Result<(), String> {
    let path = app.path.trim();
    if path.is_empty() {
        return Err("App has no launch path".into());
    }
    if path.ends_with(".desktop") {
        return run("gio", &["launch", path]).map(|_| ());
    }
    Command::new(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not launch {path}: {e}"))
}

#[tauri::command]
pub async fn focus_window(hwnd: isize) {
    let _ = tauri::async_runtime::spawn_blocking(move || focus_x11(hwnd)).await;
}

#[tauri::command]
pub async fn focus_app_windows(hwnds: Vec<isize>) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        for hwnd in hwnds {
            focus_x11(hwnd);
        }
    })
    .await;
}

#[tauri::command]
pub async fn close_window(hwnd: isize) {
    let _ = tauri::async_runtime::spawn_blocking(move || close_x11(hwnd)).await;
}

#[tauri::command]
pub async fn end_task(hwnd: isize, all_hwnds: Option<Vec<isize>>) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let windows = all_hwnds.unwrap_or_default();
        let mut pids: Vec<u32> = windows
            .iter()
            .chain(std::iter::once(&hwnd))
            .filter_map(|id| window_pid(*id))
            .collect();
        pids.sort_unstable();
        pids.dedup();
        // Ask the windows to close first so the app can save, then terminate
        // whatever is left — the same two-step the Windows `end_task` uses.
        for id in windows {
            close_x11(id);
        }
        close_x11(hwnd);
        for pid in pids {
            if pid == std::process::id() {
                continue;
            }
            let ok = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                let _ = Command::new("sh")
                    .args(["-c", &format!("kill -TERM {pid}")])
                    .status();
            }
        }
    })
    .await;
}

#[tauri::command]
pub async fn focus_agent_window(_window: u64) {}

/// The shell-ish window list: X11 exposes the stacking order through
/// `_NET_CLIENT_LIST`, so the dock can show and switch apps on X11 sessions and
/// on Wayland desktops that still run XWayland clients. Native Wayland clients
/// deliberately hide themselves from other processes, so they cannot appear.
#[tauri::command]
pub async fn get_active_windows() -> Vec<AppInfo> {
    tauri::async_runtime::spawn_blocking(active_windows)
        .await
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// running windows (X11 / XWayland)
// ---------------------------------------------------------------------------

struct X11Window {
    id: u64,
    pid: u32,
    class: String,
    title: String,
    skip: bool,
}

struct DesktopApp {
    path: String,
    name: String,
    program: String,
    wm_class: String,
    icon: String,
}

fn x11_id(hwnd: isize) -> String {
    format!("0x{:x}", hwnd as u64)
}

fn x11_ids() -> Vec<u64> {
    let Ok(out) = run("xprop", &["-root", "_NET_CLIENT_LIST"]) else {
        return Vec::new();
    };
    let Some((_, rest)) = out.split_once('#') else {
        return Vec::new();
    };
    rest.split(',')
        .filter_map(|id| u64::from_str_radix(id.trim().trim_start_matches("0x"), 16).ok())
        .filter(|id| *id != 0)
        .collect()
}

fn x11_window(id: u64) -> Option<X11Window> {
    let hex = format!("0x{id:x}");
    let out = run(
        "xprop",
        &[
            "-id",
            &hex,
            "WM_CLASS",
            "_NET_WM_PID",
            "_NET_WM_NAME",
            "WM_NAME",
            "_NET_WM_WINDOW_TYPE",
            "_NET_WM_STATE",
        ],
    )
    .ok()?;
    let mut class = String::new();
    let mut title = String::new();
    let mut pid = 0u32;
    let mut kind = String::new();
    let mut state = String::new();
    for line in out.lines() {
        if line.starts_with("WM_CLASS") {
            let quoted: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
            if let Some(value) = quoted.get(1).or_else(|| quoted.first()) {
                class = (*value).to_string();
            }
        } else if line.starts_with("_NET_WM_PID") {
            pid = line
                .split('=')
                .nth(1)
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
        } else if (line.starts_with("_NET_WM_NAME") || line.starts_with("WM_NAME")) && title.is_empty()
        {
            if let Some((_, value)) = line.split_once('=') {
                title = value.trim().trim_matches('"').to_string();
            }
        } else if line.starts_with("_NET_WM_WINDOW_TYPE") {
            kind = line.to_string();
        } else if line.starts_with("_NET_WM_STATE") {
            state = line.to_string();
        }
    }
    if pid == 0 && class.is_empty() && title.is_empty() {
        return None;
    }
    // Panels, top bars, menus and tooltips are not applications the dock should
    // offer; the window manager marks them with a type or the skip-taskbar hint.
    let skip = ["DOCK", "DESKTOP", "TOOLTIP", "MENU", "SPLASH", "NOTIFICATION", "TOOLBAR"]
        .iter()
        .any(|t| kind.contains(t))
        || state.contains("SKIP_TASKBAR");
    Some(X11Window { id, pid, class, title, skip })
}

fn desktop_index() -> Vec<DesktopApp> {
    let mut apps: Vec<DesktopApp> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for dir in crate::services::application_dirs() {
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
            let parsed = crate::services::parse_desktop_entry(&content);
            if !parsed.is_application || parsed.no_display || parsed.hidden {
                continue;
            }
            if parsed.name.is_empty() || parsed.exec.is_empty() {
                continue;
            }
            let (program, _) = crate::services::split_exec(&parsed.exec);
            let Some(program) = std::path::Path::new(&program)
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
            else {
                continue;
            };
            let Some(file_name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
                continue;
            };
            if !seen.insert(file_name) {
                continue;
            }
            apps.push(DesktopApp {
                path: path.to_string_lossy().into_owned(),
                name: parsed.name,
                program,
                wm_class: parsed.startup_wm_class.to_lowercase(),
                icon: parsed.icon.to_lowercase(),
            });
        }
    }
    apps
}

fn match_desktop<'a>(
    apps: &'a [DesktopApp],
    class: &str,
    exe: &str,
    comm: &str,
) -> Option<&'a DesktopApp> {
    let class = class.to_lowercase();
    let exe = exe.to_lowercase();
    let comm = comm.to_lowercase();
    // 1. A declared StartupWMClass is authoritative.
    if !class.is_empty() {
        if let Some(app) = apps
            .iter()
            .find(|a| !a.wm_class.is_empty() && a.wm_class == class)
        {
            return Some(app);
        }
    }
    // 2. The executable behind the window matches the entry's Exec program.
    for probe in [&exe, &comm].into_iter().filter(|v| !v.is_empty()) {
        if let Some(app) = apps.iter().find(|a| &a.program == probe) {
            return Some(app);
        }
    }
    // 3. Last resort: the WM_CLASS / icon name equals the entry's icon name.
    if !class.is_empty() {
        if let Some(app) = apps
            .iter()
            .find(|a| !a.icon.is_empty() && a.icon == class)
        {
            return Some(app);
        }
        if let Some(app) = apps.iter().find(|a| a.program == class) {
            return Some(app);
        }
    }
    None
}

fn active_windows() -> Vec<AppInfo> {
    let ids = x11_ids();
    if ids.is_empty() {
        return Vec::new();
    }
    let own_pid = std::process::id();
    let desktops = desktop_index();
    let mut groups: Vec<AppInfo> = Vec::new();
    for id in ids {
        let Some(window) = x11_window(id) else {
            continue;
        };
        if window.skip || window.pid == own_pid {
            continue;
        }
        let exe_path = std::fs::read_link(format!("/proc/{}/exe", window.pid)).ok();
        let exe = exe_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let comm = std::fs::read_to_string(format!("/proc/{}/comm", window.pid))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let entry = match_desktop(&desktops, &window.class, &exe, &comm);
        let (path, name, executable) = match entry {
            Some(app) => (app.path.clone(), app.name.clone(), Some(app.program.clone())),
            None => {
                let path = exe_path
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let name = if !window.class.is_empty() {
                    window.class.clone()
                } else if !comm.is_empty() {
                    comm.clone()
                } else {
                    window.title.clone()
                };
                let executable = if exe.is_empty() { None } else { Some(exe) };
                (path, name, executable)
            }
        };
        if path.is_empty() {
            continue;
        }
        if let Some(group) = groups.iter_mut().find(|g| g.path == path) {
            group
                .all_hwnds
                .get_or_insert_with(Vec::new)
                .push((window.id as isize, window.title));
            continue;
        }
        groups.push(AppInfo {
            name,
            path,
            icon: None,
            is_running: true,
            hwnd: Some(window.id as isize),
            executable,
            all_hwnds: Some(vec![(window.id as isize, window.title)]),
            args: None,
        });
    }
    groups.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    groups
}

fn window_pid(hwnd: isize) -> Option<u32> {
    let id = x11_id(hwnd);
    let out = run("xprop", &["-id", &id, "_NET_WM_PID"]).ok()?;
    out.split('=').nth(1)?.trim().parse().ok()
}

fn focus_x11(hwnd: isize) {
    if hwnd <= 0 {
        return;
    }
    let id = x11_id(hwnd);
    if have("wmctrl") && run("wmctrl", &["-i", "-a", &id]).is_ok() {
        return;
    }
    if have("xdotool") {
        let _ = run("xdotool", &["windowactivate", &id]);
    }
}

fn close_x11(hwnd: isize) {
    if hwnd <= 0 {
        return;
    }
    let id = x11_id(hwnd);
    if have("wmctrl") && run("wmctrl", &["-i", "-c", &id]).is_ok() {
        return;
    }
    if have("xdotool") {
        let _ = run("xdotool", &["windowclose", &id]);
    }
}

// ---------------------------------------------------------------------------
// icons
// ---------------------------------------------------------------------------

fn icon_dirs(name: &str) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    let sizes = ["scalable", "512x512", "256x256", "128x128", "64x64", "48x48", "32x32"];
    let themes = ["hicolor", "Adwaita", "breeze", "Papirus"];
    for theme in themes {
        for size in sizes {
            for ext in ["svg", "png"] {
                found.push(format!("/usr/share/icons/{theme}/{size}/apps/{name}.{ext}").into());
                found.push(format!("/usr/share/icons/{theme}/{size}/apps/{name}-symbolic.{ext}").into());
            }
        }
    }
    for ext in ["svg", "png", "xpm"] {
        found.push(format!("/usr/share/pixmaps/{name}.{ext}").into());
    }
    found
}

fn png_data_url(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mime = if path.extension().map(|e| e.eq_ignore_ascii_case("svg")).unwrap_or(false) {
        "image/svg+xml"
    } else if path.extension().map(|e| e.eq_ignore_ascii_case("png")).unwrap_or(false) {
        "image/png"
    } else {
        return None;
    };
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn desktop_icon_name(desktop_path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(desktop_path).ok()?;
    content
        .lines()
        .find_map(|line| line.strip_prefix("Icon=").map(|v| v.trim().to_string()))
        .filter(|v| !v.is_empty())
}

#[tauri::command]
pub async fn get_app_icon(
    _app: AppHandle,
    path: String,
    name: Option<String>,
    _hwnd: Option<isize>,
) -> Result<Option<String>, String> {
    let candidate = std::path::Path::new(&path);
    if candidate.extension().map(|e| e.eq_ignore_ascii_case("png") || e.eq_ignore_ascii_case("svg")).unwrap_or(false)
    {
        if let Some(url) = png_data_url(candidate) {
            return Ok(Some(url));
        }
    }
    // A .desktop entry names its icon; an executable usually matches one of the
    // installed icon names, so try both.
    let mut names: Vec<String> = Vec::new();
    if path.ends_with(".desktop") {
        if let Some(icon) = desktop_icon_name(candidate) {
            if icon.starts_with('/') {
                if let Some(url) = png_data_url(std::path::Path::new(&icon)) {
                    return Ok(Some(url));
                }
            } else {
                names.push(icon);
            }
        }
    }
    if let Some(name) = name {
        names.push(name);
    }
    if let Some(stem) = candidate.file_stem().map(|s| s.to_string_lossy().to_string()) {
        names.push(stem);
    }
    for name in names {
        let lower = name.to_lowercase();
        for dir in icon_dirs(&name).into_iter().chain(icon_dirs(&lower)) {
            if let Some(url) = png_data_url(&dir) {
                return Ok(Some(url));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn load_pinned_apps(app: AppHandle) -> Vec<AppInfo> {
    let cfg_dir = app.path().app_config_dir().unwrap_or_default();
    if let Ok(content) = std::fs::read_to_string(cfg_dir.join("pinned_apps.json")) {
        if let Ok(apps) = serde_json::from_str::<Vec<AppInfo>>(&content) {
            if !apps.is_empty() {
                return apps;
            }
        }
    }
    // Fresh profile: a small, desktop-agnostic starting set.
    let defaults = [
        ("Files", "org.gnome.Nautilus", "system-file-manager"),
        ("Terminal", "org.gnome.Terminal", "utilities-terminal"),
        ("Browser", "firefox", "web-browser"),
        ("Settings", "kiro-settings", "preferences-system"),
    ];
    defaults
        .iter()
        .map(|(name, path, _icon)| AppInfo {
            name: (*name).into(),
            path: (*path).into(),
            icon: None,
            is_running: false,
            hwnd: None,
            executable: None,
            all_hwnds: None,
            args: None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_app_media_sessions() -> Vec<AppMediaSession> {
    Vec::new()
}

#[tauri::command]
pub fn app_media_control(_app_id: String, _action: String) -> Result<(), String> {
    Err("Per-app media control is a Windows feature".into())
}

#[tauri::command]
pub fn open_media_source_app() {}

// ---------------------------------------------------------------------------
// audio mixer
// ---------------------------------------------------------------------------

struct SinkInput {
    index: u32,
    pid: u32,
    name: String,
    volume: f32,
    muted: bool,
}

fn sink_inputs() -> Vec<SinkInput> {
    let Ok(out) = run("pactl", &["list", "sink-inputs"]) else { return Vec::new() };
    let mut result = Vec::new();
    let mut current: Option<SinkInput> = None;
    let mut in_properties = false;
    for line in out.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Sink Input #") {
            if let Some(input) = current.take() {
                result.push(input);
            }
            current = Some(SinkInput {
                index: rest.trim().parse().unwrap_or(0),
                pid: 0,
                name: String::new(),
                volume: 1.0,
                muted: false,
            });
            in_properties = false;
            continue;
        }
        let Some(input) = current.as_mut() else { continue };
        if trimmed == "Properties:" {
            in_properties = true;
            continue;
        }
        if trimmed.starts_with("Volume:") {
            if let Some(part) = trimmed.split('/').nth(1) {
                if let Some(volume) = percent_to_unit(part) {
                    input.volume = volume;
                }
            }
        } else if trimmed == "Mute: yes" {
            input.muted = true;
        } else if trimmed == "Mute: no" {
            input.muted = false;
        } else if in_properties {
            if let Some(value) = trimmed.strip_prefix("application.process.id = ") {
                input.pid = value.trim_matches('"').parse().unwrap_or(0);
            } else if let Some(value) = trimmed.strip_prefix("application.name = ") {
                input.name = value.trim_matches('"').to_string();
            }
        }
    }
    if let Some(input) = current {
        result.push(input);
    }
    result
}

#[tauri::command]
pub async fn get_audio_sessions() -> Result<Vec<AudioSessionInfo>, String> {
    Ok(sink_inputs()
        .into_iter()
        .map(|input| AudioSessionInfo {
            pid: input.pid,
            name: if input.name.is_empty() { format!("Stream {}", input.index) } else { input.name },
            process_path: None,
            volume: input.volume,
            is_muted: input.muted,
        })
        .collect())
}

fn input_for_pid(pid: u32) -> Option<SinkInput> {
    sink_inputs().into_iter().find(|i| i.pid == pid)
}

#[tauri::command]
pub async fn set_app_volume(pid: u32, volume: f32) -> Result<(), String> {
    let input = input_for_pid(pid).ok_or("That app is not playing audio")?;
    let percent = (volume.clamp(0.0, 1.5) * 100.0).round() as u32;
    run("pactl", &["set-sink-input-volume", &input.index.to_string(), &format!("{percent}%")])
        .map(|_| ())
}

#[tauri::command]
pub async fn set_app_mute(pid: u32, muted: bool) -> Result<(), String> {
    let input = input_for_pid(pid).ok_or("That app is not playing audio")?;
    run(
        "pactl",
        &["set-sink-input-mute", &input.index.to_string(), if muted { "1" } else { "0" }],
    )
    .map(|_| ())
}

#[tauri::command]
pub async fn get_volume_state() -> Result<VolumeChangeEvent, String> {
    let sink = default_sink().unwrap_or_else(|| "@DEFAULT_SINK@".into());
    let volume_out = run("pactl", &["get-sink-volume", &sink])?;
    let volume = volume_out
        .lines()
        .next()
        .and_then(|l| l.split('/').nth(1))
        .and_then(percent_to_unit)
        .unwrap_or(1.0);
    let is_muted = run("pactl", &["get-sink-mute", &sink])
        .map(|m| m.trim().ends_with("yes"))
        .unwrap_or(false);
    Ok(VolumeChangeEvent { volume, is_muted })
}

// ---------------------------------------------------------------------------
// radios, battery, power
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_wifi_status() -> Result<WifiStatus, String> {
    let enabled = run("nmcli", &["radio", "wifi"])
        .map(|out| out.trim() == "enabled")
        .unwrap_or(false);
    Ok(WifiStatus { enabled, connected: enabled && active_wifi_ssid().is_some() })
}

#[tauri::command]
pub async fn set_wifi_state(enabled: bool) -> Result<(), String> {
    run("nmcli", &["radio", "wifi", if enabled { "on" } else { "off" }]).map(|_| ())
}

#[tauri::command]
pub async fn get_bluetooth_state() -> Result<bool, String> {
    run("bluetoothctl", &["show"])
        .map(|out| out.lines().any(|l| l.trim() == "Powered: yes"))
        .or_else(|_| Ok(false))
}

#[tauri::command]
pub async fn set_bluetooth_state(enabled: bool) -> Result<(), String> {
    run("bluetoothctl", &["power", if enabled { "on" } else { "off" }]).map(|_| ())
}

fn battery_present() -> bool {
    std::fs::read_dir("/sys/class/power_supply")
        .map(|entries| {
            entries.flatten().any(|entry| {
                std::fs::read_to_string(entry.path().join("type"))
                    .map(|t| t.trim() == "Battery")
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn has_battery() -> Result<bool, String> {
    Ok(battery_present())
}

#[tauri::command]
pub async fn get_battery_saver_state() -> Result<bool, String> {
    // No portable "power saver" query; upower reports the profile on some
    // desktops but not all, so Kiro leaves the toggle off instead of lying.
    Ok(false)
}

// ---------------------------------------------------------------------------
// system metrics
// ---------------------------------------------------------------------------

fn cpu_times() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().next()?;
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse().ok())
        .collect();
    if values.len() < 4 {
        return None;
    }
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    let total: u64 = values.iter().sum();
    Some((idle, total))
}

static LAST_CPU: OnceLock<Mutex<(u64, u64)>> = OnceLock::new();

#[tauri::command]
pub fn get_cpu_usage() -> Result<u32, String> {
    let (idle, total) = cpu_times().ok_or("/proc/stat is not readable")?;
    let cell = LAST_CPU.get_or_init(|| Mutex::new((idle, total)));
    let mut previous = cell.lock().map_err(|e| e.to_string())?;
    let (prev_idle, prev_total) = *previous;
    *previous = (idle, total);
    let total_delta = total.saturating_sub(prev_total);
    let idle_delta = idle.saturating_sub(prev_idle);
    if total_delta == 0 {
        return Ok(0);
    }
    let busy = 100.0 * (total_delta.saturating_sub(idle_delta)) as f64 / total_delta as f64;
    Ok(busy.clamp(0.0, 100.0).round() as u32)
}

#[tauri::command]
pub fn get_ram_usage() -> Result<f32, String> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").map_err(|e| e.to_string())?;
    let mut total = 0f64;
    let mut available = 0f64;
    for line in meminfo.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let value: f64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
        match key {
            "MemTotal:" => total = value,
            "MemAvailable:" => available = value,
            _ => {}
        }
    }
    if total <= 0.0 {
        return Ok(0.0);
    }
    Ok((100.0 * (total - available) / total).clamp(0.0, 100.0) as f32)
}

#[tauri::command]
pub fn get_disk_space() -> Result<u64, String> {
    // `df -kP /` -> "Filesystem 1024-blocks Used Available Capacity Mounted on"
    let out = run("df", &["-kP", "/"])?;
    let line = out.lines().nth(1).ok_or("df returned no data")?;
    let available_kb: u64 = line
        .split_whitespace()
        .nth(3)
        .and_then(|v| v.parse().ok())
        .ok_or("unexpected df output")?;
    Ok(available_kb * 1024)
}

#[tauri::command]
pub fn get_running_processes() -> Result<Vec<ProcessInfo>, String> {
    let entries = std::fs::read_dir("/proc").map_err(|e| e.to_string())?;
    let mut processes = Vec::new();
    for entry in entries.flatten() {
        let pid: u32 = match entry.file_name().to_string_lossy().parse() {
            Ok(pid) => pid,
            Err(_) => continue,
        };
        let status = match std::fs::read_to_string(entry.path().join("status")) {
            Ok(status) => status,
            Err(_) => continue,
        };
        let mut name = String::new();
        let mut memory_kb = 0u64;
        for line in status.lines() {
            if let Some(value) = line.strip_prefix("Name:") {
                name = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("VmRSS:") {
                memory_kb = value
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
            }
        }
        if name.is_empty() {
            continue;
        }
        let exe_path = std::fs::read_link(entry.path().join("exe"))
            .ok()
            .map(|p| p.to_string_lossy().to_string());
        processes.push(ProcessInfo { pid, name, exe_path, memory_kb });
    }
    processes.sort_by(|a, b| b.memory_kb.cmp(&a.memory_kb));
    Ok(processes)
}

#[tauri::command]
pub fn kill_process(pid: u32, _name: Option<String>) -> Result<(), String> {
    if pid <= 2 {
        return Err("Refusing to signal a kernel process".into());
    }
    run("kill", &["-TERM", &pid.to_string()]).map(|_| ())
}

struct NetSample {
    rx: u64,
    tx: u64,
    at: std::time::Instant,
}

static LAST_NET: OnceLock<Mutex<Option<NetSample>>> = OnceLock::new();

#[tauri::command]
pub fn get_network_speed() -> Result<(u64, u64), String> {
    let dev = std::fs::read_to_string("/proc/net/dev").map_err(|e| e.to_string())?;
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in dev.lines().skip(2) {
        let Some((iface, rest)) = line.split_once(':') else { continue };
        let iface = iface.trim();
        if iface == "lo" {
            continue;
        }
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        rx += fields[0].parse::<u64>().unwrap_or(0);
        tx += fields[8].parse::<u64>().unwrap_or(0);
    }
    let now = std::time::Instant::now();
    let cell = LAST_NET.get_or_init(|| Mutex::new(None));
    let mut last = cell.lock().map_err(|e| e.to_string())?;
    let (down, up) = match last.as_ref() {
        Some(previous) => {
            let secs = now.duration_since(previous.at).as_secs_f64().max(0.001);
            (
                ((rx.saturating_sub(previous.rx)) as f64 / secs) as u64,
                ((tx.saturating_sub(previous.tx)) as f64 / secs) as u64,
            )
        }
        None => (0, 0),
    };
    *last = Some(NetSample { rx, tx, at: now });
    Ok((down, up))
}

#[tauri::command]
pub fn get_system_accent_color() -> Result<String, String> {
    // GNOME stores the accent colour in a schema that older releases do not
    // have; fall back to Kiro's own blue rather than failing the panel.
    let candidates: [(&str, &str); 2] = [
        ("org.gnome.desktop.interface", "accent-color"),
        ("org.gnome.desktop.interface", "gtk-theme"),
    ];
    let accent = run(
        "gsettings",
        &["get", candidates[0].0, candidates[0].1],
    )
    .ok()
    .map(|s| s.trim().trim_matches('\'').to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_default();
    let hex = match accent.as_str() {
        "blue" => "#3584e4",
        "teal" => "#2190a4",
        "green" => "#3a944a",
        "yellow" => "#c88800",
        "orange" => "#ed5b00",
        "red" => "#e62d42",
        "pink" => "#d56199",
        "purple" => "#9141ac",
        "slate" => "#6f8396",
        _ => "#4f8cff",
    };
    Ok(hex.to_string())
}

// ---------------------------------------------------------------------------
// overdue OS features
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_dnd_enabled() -> bool {
    false
}

#[tauri::command]
pub fn set_dnd_enabled(_enabled: bool) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub async fn capture_window_thumbnail(
    _hwnd: isize,
    _max_width: u32,
    _max_height: u32,
) -> Result<Option<(String, i64)>, String> {
    Ok(None)
}

// ---------------------------------------------------------------------------
// settings file watcher
// ---------------------------------------------------------------------------

/// The settings file can be edited by hand (or synced by the user's dotfiles),
/// so Kiro watches it and pushes the differences to the UI. Windows uses
/// `ReadDirectoryChangesW`; here the file's mtime is polled, which is portable,
/// cheap (one `stat` every half second) and needs no inotify handle.
pub fn setup_settings_watcher(app: AppHandle) {
    use tauri::Manager;

    let Ok(config_dir) = app.path().app_config_dir() else { return };
    let settings_path = config_dir.join("settings.json");

    std::thread::spawn(move || {
        let mut last_stamp = std::fs::metadata(&settings_path)
            .and_then(|m| m.modified())
            .ok();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let stamp = std::fs::metadata(&settings_path)
                .and_then(|m| m.modified())
                .ok();
            if stamp == last_stamp {
                continue;
            }
            last_stamp = stamp;

            let Some(new_settings) = crate::utils::read_settings_map(&settings_path) else {
                continue;
            };
            let (changed, removed) = {
                let mut cache = crate::state::SETTINGS_CACHE
                    .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let changed: Vec<(String, serde_json::Value)> = new_settings
                    .iter()
                    .filter(|(key, value)| cache.get(*key) != Some(*value))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                let removed: Vec<String> = cache
                    .keys()
                    .filter(|key| !new_settings.contains_key(*key))
                    .cloned()
                    .collect();
                *cache = new_settings;
                (changed, removed)
            };
            for (key, value) in &changed {
                let _ = app.emit(
                    "settings-external-changed",
                    serde_json::json!({ "key": key, "value": value }),
                );
            }
            for key in removed {
                let _ = app.emit(
                    "settings-external-changed",
                    serde_json::json!({ "key": key, "value": null }),
                );
            }
        }
    });
}

// ---------------------------------------------------------------------------
// lifecycle helpers
// ---------------------------------------------------------------------------

/// Restarts Kiro in place. The single-instance lock is a file, so it has to be
/// released first or the new process would exit straight away.
#[cfg(not(kiro_windows))]
#[allow(dead_code)] // called from the release build only (dev restarts reload pages)
pub fn relaunch_kiro(handle: &AppHandle) {
    SHUTTING_DOWN.store(true, Ordering::Relaxed);
    std::env::set_var("KIRO_RESTARTING", "1");
    crate::state::close_single_instance_handles();
    crate::single_instance::release();
    handle.restart();
}

/// Linux power saving is owned by the desktop's power profile daemon
/// (power-profiles-daemon / TLP). Kiro reports "unsupported" instead of
/// pretending to control it.
#[tauri::command]
pub async fn set_battery_saver(_app: tauri::AppHandle, _enabled: bool) -> Result<bool, String> {
    Ok(false)
}

/// Trash and removable media are the two "dock extra" shortcuts the dock shows.
/// Linux exposes the trash through gio, which every GTK desktop understands.
#[tauri::command]
pub fn open_dock_extra(target: String) -> Result<(), String> {
    if target == "recycle" {
        return Command::new("gio")
            .args(["open", "trash://"])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open the trash: {e}"));
    }
    if target.len() == 1 {
        // A single letter is a drive on Windows; on Linux removable media is
        // mounted under /media or /run/media, so open the mount root instead.
        let mount = format!("/run/media/{}", std::env::var("USER").unwrap_or_default());
        if std::path::Path::new(&mount).exists() {
            return Command::new("gio")
                .args(["open", &mount])
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
    }
    Err(format!("unknown dock extra: {target}"))
}

/// Opens a document with a specific application (`Exec=... %f`).
#[tauri::command]
pub fn open_file_with(app_path: String, file_path: String) -> Result<(), String> {
    if !std::path::Path::new(&file_path).exists() {
        return Err(format!("File not found: {file_path}"));
    }
    if app_path.ends_with(".desktop") {
        // Desktop entries declare how they take files; gio does the expansion.
        return Command::new("gio")
            .args(["launch", &app_path, &file_path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    Command::new(&app_path)
        .arg(&file_path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Starts another copy of an app without stealing focus from the dock.
#[tauri::command]
pub async fn launch_new_instance(app_path: String, _app_name: Option<String>, args: Option<String>) {
    tauri::async_runtime::spawn_blocking(move || {
        if app_path == "start" || app_path.trim().is_empty() {
            return;
        }
        let extra: Vec<String> = args
            .as_deref()
            .map(|value| value.split_whitespace().map(|s| s.to_string()).collect())
            .unwrap_or_default();
        let mut command = if app_path.ends_with(".desktop") {
            let mut c = Command::new("gio");
            c.args(["launch", &app_path]);
            c
        } else {
            let mut c = Command::new(&app_path);
            c.args(&extra);
            c
        };
        let _ = command.spawn();
    });
}

// ---------------------------------------------------------------------------
// geometry re-application
// ---------------------------------------------------------------------------

/// Applying a new scale or mode only needs the window placed again; there is no
/// appbar registration to redo.
pub fn re_register_appbars(app: &AppHandle, _settings: &std::collections::HashMap<String, serde_json::Value>) {
    for (label, win) in app.webview_windows() {
        if crate::state::is_notch_label(&label) {
            crate::services::place_notch_window(app, &win);
        } else if crate::state::is_dock_label(&label) {
            crate::services::place_dock_window(app, &win);
        }
    }
}

pub async fn change_dock_mode_for_window(
    app: &AppHandle,
    dock_win: tauri::WebviewWindow,
    mode: &str,
) {
    if mode == "hidden" {
        let _ = dock_win.hide();
        crate::state::set_flag(crate::state::dock_appbar_registered(), dock_win.label(), false);
        return;
    }
    crate::services::place_dock_window(app, &dock_win);
}

// ---------------------------------------------------------------------------
// mirroring targets that do not exist here
// ---------------------------------------------------------------------------

/// The notification area is a Windows concept; the dock has no tray button on
/// Linux, so nothing is opened.
#[tauri::command]
pub fn open_tray_window(_app: AppHandle) {}

/// Same question as the Windows pointer-hook version — is the cursor still over
/// the notch hit box — answered with the compositor's cursor position (which
/// X11 and Wayland both report to the app) instead of a Win32 `GetCursorPos`.
#[tauri::command]
pub fn pointer_over_notch(window: Window) -> bool {
    // GDK is not thread-safe: asking it about the pointer from this command's
    // thread while GTK is running aborts Xlib. Hand the work to the GTK thread.
    let (tx, rx) = std::sync::mpsc::channel();
    let label = window.label().to_string();
    let runner = window.clone();
    let inner = window.clone();
    let dispatched = runner
        .run_on_main_thread(move || {
            let _ = tx.send(pointer_over_notch_here(&inner, &label));
        })
        .is_ok();
    if !dispatched {
        return false;
    }
    rx.recv_timeout(std::time::Duration::from_millis(400))
        .unwrap_or(false)
}

fn pointer_over_notch_here(window: &Window, label: &str) -> bool {
    let Ok(cursor) = window.cursor_position() else { return false };
    let Some((win_pos, _)) = main_window_rects().lock().ok().and_then(|m| m.get(label).copied()) else {
        return false;
    };
    let Some(r) = notch_rects().lock().ok().and_then(|m| m.get(label).copied()) else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let left = win_pos.x + (r.x as f64 * scale) as i32;
    let right = left + (r.width as f64 * scale) as i32;
    let top = win_pos.y;
    let bottom = win_pos.y + (r.height as f64 * scale) as i32;
    cursor.x >= left as f64
        && cursor.x <= right as f64
        && cursor.y >= top as f64
        && cursor.y <= bottom as f64
}
