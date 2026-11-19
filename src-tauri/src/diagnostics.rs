use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(kiro_windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

#[cfg(kiro_windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_LOG_BYTES: u64 = 1_000_000;
const LOG_FILE: &str = "kiro.log";
const REPORT_FILE: &str = "diagnostics.txt";
#[cfg(kiro_windows)]
const HITBOX_INTERVAL_MS: i64 = 250;
/// Longest slice of the log embedded in the report, in bytes.
const REPORT_LOG_BYTES: usize = 24_000;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());
static HITBOX_LOGGING: AtomicBool = AtomicBool::new(false);
#[cfg(kiro_windows)]
static LAST_HITBOX_MS: [AtomicI64; 2] = [AtomicI64::new(0), AtomicI64::new(0)];

pub static HOOK_EVENTS: AtomicI64 = AtomicI64::new(0);
pub static HOOK_LAST_EVENT_MS: AtomicI64 = AtomicI64::new(0);

/// Base directory for logs and the report, matching the app's own config root.
fn log_root() -> Option<PathBuf> {
    #[cfg(kiro_windows)]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|appdata| PathBuf::from(appdata).join("com.fruyorsan.kiro"))
    }
    #[cfg(not(kiro_windows))]
    {
        // XDG_STATE_HOME is where logs and crash reports belong (as opposed to
        // configuration), so a profile sync never ships them around.
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|home| PathBuf::from(home).join(".local").join("state"))
            })?;
        Some(base.join("kiro"))
    }
}

fn platform_label() -> String {
    #[cfg(kiro_windows)]
    {
        format!("windows build {}", crate::utils::windows_build())
    }
    #[cfg(not(kiro_windows))]
    {
        let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|release| release.trim().to_string())
            .unwrap_or_default();
        if kernel.is_empty() {
            crate::utils::os_name()
        } else {
            format!("{} (kernel {kernel})", crate::utils::os_name())
        }
    }
}

pub fn init() {
    let Some(root) = log_root() else { return };
    let dir = root.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = LOG_DIR.set(dir);
    install_panic_hook();
    log(&format!(
        "---- Kiro {} starting (pid {}, {}) ----",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        platform_label()
    ));
}

pub fn log_dir() -> Option<PathBuf> {
    LOG_DIR.get().cloned()
}

pub fn log(msg: &str) {
    let Some(dir) = LOG_DIR.get() else { return };
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join(LOG_FILE);
    if fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("kiro.old.log"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{stamp}] {msg}");
    }
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        let backtrace = std::backtrace::Backtrace::force_capture();
        log(&format!("PANIC on thread '{name}': {info}\n{backtrace}"));
        default_hook(info);
    }));
}

pub fn set_hitbox_logging(enabled: bool) {
    HITBOX_LOGGING.store(enabled, Ordering::Relaxed);
    log(&format!("hit-test logging {}", if enabled { "enabled" } else { "disabled" }));
}

pub fn hitbox_logging() -> bool {
    HITBOX_LOGGING.load(Ordering::Relaxed)
}

/// Hit-test logging only exists for the Windows pointer hook, which owns the
/// dock/notch hit boxes there. Linux delivers hover per window instead, so the
/// reporter has nothing to sample.
#[cfg(kiro_windows)]
pub fn hitbox_log(slot: usize, now_ms: i64, line: impl FnOnce() -> String) {
    if !hitbox_logging() {
        return;
    }
    if now_ms - LAST_HITBOX_MS[slot].load(Ordering::Relaxed) < HITBOX_INTERVAL_MS {
        return;
    }
    LAST_HITBOX_MS[slot].store(now_ms, Ordering::Relaxed);
    log(&line());
}

#[cfg(not(kiro_windows))]
#[allow(dead_code)] // Windows-only callers; kept so the shared call sites stay identical
pub fn hitbox_log(_slot: usize, _now_ms: i64, _line: impl FnOnce() -> String) {}

fn run_hidden(program: &str, args: &[&str]) -> Option<String> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    #[cfg(kiro_windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
}

/// Distribution name plus kernel release, where Windows prints its edition and
/// build number.
#[cfg(not(kiro_windows))]
fn os_version() -> String {
    platform_label()
}

#[cfg(kiro_windows)]
fn reg_value(key: &str, name: &str) -> Option<String> {
    let out = run_hidden("reg", &["query", key, "/v", name])?;
    out.lines()
        .find(|l| l.trim_start().starts_with(name))
        .and_then(|l| l.split_whitespace().last())
        .map(str::to_string)
}

#[cfg(kiro_windows)]
fn os_version() -> String {
    const KEY: &str = r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    // ProductName still reports "Windows 10" on Windows 11, so trust the build
    // number (via ntdll) for the family and use the registry for the details.
    let family = if crate::utils::is_windows_11() { "Windows 11" } else { "Windows 10" };
    let edition = reg_value(KEY, "EditionID").unwrap_or_default();
    let display = reg_value(KEY, "DisplayVersion").unwrap_or_default();
    let build = crate::utils::windows_build();
    let ubr = reg_value(KEY, "UBR")
        .and_then(|v| u32::from_str_radix(v.trim_start_matches("0x"), 16).ok())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    format!("{family} {edition} {display} (build {build}{ubr})")
}

fn gpu_names() -> String {
    #[cfg(kiro_windows)]
    {
        return run_hidden("powershell", &["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name -join ', '"])
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
    }

    // `lspci` is part of pciutils, which every desktop install pulls in; when it
    // is missing, fall back to the driver names the kernel exposes in sysfs.
    #[cfg(not(kiro_windows))]
    {
        if let Some(out) = run_hidden("lspci", &[]) {
            let mut names: Vec<String> = out
                .lines()
                .filter(|line| {
                    line.contains("VGA compatible controller")
                        || line.contains("3D controller")
                        || line.contains("Display controller")
                })
                .filter_map(|line| line.split_once(": ").map(|(_, rest)| rest.trim().to_string()))
                .collect();
            names.sort();
            names.dedup();
            if !names.is_empty() {
                return names.join(", ");
            }
        }
        let mut drivers: Vec<String> = Vec::new();
        if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
            for entry in entries.flatten() {
                let uevent = entry.path().join("device").join("uevent");
                let Ok(text) = std::fs::read_to_string(uevent) else { continue };
                if let Some(driver) = text.lines().find_map(|l| l.strip_prefix("DRIVER=")) {
                    if !driver.trim().is_empty() {
                        drivers.push(format!("{} (kernel driver)", driver.trim()));
                    }
                }
            }
        }
        drivers.sort();
        drivers.dedup();
        drivers.join(", ")
    }
}

/// Background apps that take over global input, which is the one thing on Linux
/// that can interfere with Kiro's own shortcuts.
fn running_conflicts() -> String {
    #[cfg(kiro_windows)]
    const WATCH: [&str; 9] = [
        "razer", "rzsynapse", "synapse", "logi", "lghub", "autohotkey", "powertoys", "displayfusion", "actualtools",
    ];
    #[cfg(not(kiro_windows))]
    const WATCH: [&str; 5] = ["input-remapper", "autokey", "solaar", "keyd", "kanata"];

    #[cfg(kiro_windows)]
    let Some(out) = run_hidden("tasklist", &["/FO", "CSV", "/NH"]) else {
        return String::new();
    };
    #[cfg(not(kiro_windows))]
    let Some(out) = run_hidden("ps", &["-eo", "comm="]) else {
        return String::new();
    };

    let mut found: Vec<String> = out
        .lines()
        .filter_map(|l| l.split(',').next())
        .map(|n| n.trim_matches('"').trim().to_string())
        .filter(|n| {
            let low = n.to_lowercase();
            WATCH.iter().any(|w| low.contains(w))
        })
        .collect();
    found.sort();
    found.dedup();
    found.join(", ")
}

fn sensitive_key(key: &str) -> bool {
    let k = key.to_lowercase();
    ["caldav", "ics", "token", "password", "email", "account", "url", "location", "weather-cached"]
        .iter()
        .any(|s| k.contains(s))
}

fn settings_snapshot() -> String {
    let Some(cache) = crate::state::SETTINGS_CACHE.get() else { return "(settings not loaded)".into() };
    let Ok(guard) = cache.lock() else { return "(settings locked)".into() };
    let mut keys: Vec<&String> = guard.keys().filter(|k| !sensitive_key(k)).collect();
    keys.sort();
    keys.iter().map(|k| format!("  {k} = {}", guard[*k])).collect::<Vec<_>>().join("\n")
}

fn tail(max_bytes: usize) -> String {
    let Some(dir) = LOG_DIR.get() else { return String::new() };
    let Ok(text) = fs::read_to_string(dir.join(LOG_FILE)) else { return String::new() };
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

fn window_report(app: &AppHandle) -> String {
    let mut out = String::new();
    for (label, win) in app.webview_windows() {
        if !matches!(label.as_str(), "main" | "dock" | "overlay") && !label.starts_with("main-") && !label.starts_with("dock-") {
            continue;
        }
        let pos = win.outer_position().map(|p| format!("{},{}", p.x, p.y)).unwrap_or_else(|_| "?".into());
        let size = win.outer_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_else(|_| "?".into());
        let scale = win.scale_factor().unwrap_or(0.0);
        let visible = win.is_visible().unwrap_or(false);
        out.push_str(&format!("  {label}: pos={pos} size={size} scale={scale} visible={visible}\n"));
    }
    if let Ok(m) = crate::state::dock_rects().lock() {
        for (label, r) in m.iter() {
            out.push_str(&format!("  reported dock rect [{label}]: x={} y={} w={} h={}\n", r.x, r.y, r.width, r.height));
        }
    }
    if let Ok(m) = crate::state::notch_rects().lock() {
        for (label, r) in m.iter() {
            out.push_str(&format!("  reported notch rect [{label}]: x={} y={} w={} h={}\n", r.x, r.y, r.width, r.height));
        }
    }
    out
}

fn monitor_report(app: &AppHandle) -> String {
    let monitors = crate::monitors::available_monitors(app);
    if monitors.is_empty() { return "  (unavailable)\n".into() }
    monitors
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            format!("  {} {}x{} at {},{} scale={}\n", m.name().cloned().unwrap_or_default(), s.width, s.height, p.x, p.y, m.scale_factor())
        })
        .collect()
}

pub fn build_report(app: &AppHandle) -> String {
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    let now = crate::services::now_ms();
    let last = HOOK_LAST_EVENT_MS.load(Ordering::Relaxed);
    let hook_age = if last == 0 { "never".to_string() } else { format!("{}ms ago", now - last) };
    // The engine label differs per platform: WebView2 on Windows, WebKitGTK on
    // Linux. `tauri::webview_version()` reports whichever is in use.
    let webview_label = if cfg!(kiro_windows) { "WebView2" } else { "WebKitGTK" };
    let windows_label = if cfg!(kiro_windows) { "Windows" } else { "X11/Wayland windows" };
    let pointer_label = if cfg!(kiro_windows) {
        "Mouse hook"
    } else {
        "Pointer events"
    };

    let report = format!(
        "Kiro diagnostics\n\
         ==================\n\
         Kiro: {version}\n\
         System: {windows}\n\
         {webview_label}: {webview}\n\
         GPU: {gpu}\n\
         Executable: {exe}\n\
         Elevated: {elevated}\n\
         Possibly conflicting apps running: {conflicts}\n\n\
         Monitors:\n{monitors}\n\
         {pointer_label}: {events} events, last {hook_age}\n\n\
         {windows_label}:\n{windows_info}\n\
         Settings:\n{settings}\n\n\
         Recent log:\n{log}\n",
        version = env!("CARGO_PKG_VERSION"),
        windows = os_version(),
        webview_label = webview_label,
        webview = tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        gpu = gpu_names(),
        exe = exe,
        elevated = crate::native_uninstall::is_elevated(),
        conflicts = { let c = running_conflicts(); if c.is_empty() { "none detected".into() } else { c } },
        monitors = monitor_report(app),
        events = HOOK_EVENTS.load(Ordering::Relaxed),
        hook_age = hook_age,
        windows_label = windows_label,
        windows_info = window_report(app),
        settings = settings_snapshot(),
        log = tail(REPORT_LOG_BYTES),
    );

    if let Some(dir) = LOG_DIR.get() {
        let _ = fs::write(dir.join(REPORT_FILE), &report);
    }
    report
}
