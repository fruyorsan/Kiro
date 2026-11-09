//! Kiro FPS Boost.
//!
//! Everything here is Kiro's own capability, not a settings switch the user has
//! to understand. While a fullscreen game is in front Kiro:
//!
//! 1. raises the game process above everything else that wants the CPU
//!    (`SetPriorityClass`), turns off Windows' EcoQoS throttling for it and
//!    lifts its memory priority, so the scheduler stops parking the game's
//!    threads on the efficiency cores and stops trimming its pages mid-frame;
//! 2. mutes toast notifications for the session. A toast is a new topmost
//!    window, which makes DWM composite one frame over the game and is the most
//!    common cause of a 1% low dip in an otherwise smooth scene;
//! 3. on the second time it sees the same executable play fullscreen, writes a
//!    per-app graphics profile: "High performance" in Windows Graphics
//!    Settings (the only thing that routes a hybrid laptop's game to the
//!    discrete GPU instead of the iGPU) and disables fullscreen optimizations
//!    for that exe so it gets a real exclusive flip chain.
//!
//! Every step has a matching restore. Process priority / EcoQoS / memory
//! priority die with the process, so they cannot outlive a crash. Registry
//! writes are backed up in `fps-profiles.json` and can be undone with one
//! command from Settings.
//!
//! `audit()` is the honest half: it reads the machine (display GPU, GPU power
//! limit, RAM channel layout, refresh rate, HAGS, storage) and returns
//! findings with measured impact ranges instead of promising a number.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_DWORD,
    REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows::Win32::System::Threading::{
    GetPriorityClass, GetProcessInformation, OpenProcess, QueryFullProcessImageNameW,
    SetPriorityClass, SetProcessInformation, ABOVE_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS,
    MEMORY_PRIORITY, MEMORY_PRIORITY_INFORMATION, PROCESS_CREATION_FLAGS, PROCESS_NAME_WIN32,
    PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

/// Master switch. Default on: the whole feature exists to be invisible.
pub const SETTING: &str = "kiro-fps-boost";

const GPU_KEY: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";
const LAYERS_KEY: &str = r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";
const NOTIF_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings";
const TOASTS_VALUE: &str = "NOC_GLOBAL_SETTING_TOASTS_ENABLED";

const GAME_DVR_KEY: &str = r"System\GameConfigStore";
const APP_CAPTURE_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\GameDVR";
const GAME_BAR_KEY: &str = r"Software\Microsoft\GameBar";
const DX_GRAPHICS_KEY: &str = r"Software\Microsoft\DirectX\GraphicsSettings";

/// A window has to stay fullscreen this long before the boost engages.
const HOLD: Duration = Duration::from_millis(1200);
/// Give focus blips (alt-tab, our own OSD) time to pass before releasing.
const RELEASE_HOLD: Duration = Duration::from_millis(2500);

static ACTIVE: AtomicBool = AtomicBool::new(false);
static SINCE: Mutex<Option<Instant>> = Mutex::new(None);
static MISSING_SINCE: Mutex<Option<Instant>> = Mutex::new(None);
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// Process we could not open (anti-cheat / elevated): do not retry every tick.
static RETRY_AFTER: Mutex<Option<(u32, Instant)>> = Mutex::new(None);
/// Last process whose profile we already counted, so alt-tab does not inflate
/// the sighting counter.
static LAST_PROFILE_PID: Mutex<Option<u32>> = Mutex::new(None);

#[derive(Clone, Copy)]
struct SavedProcess {
    priority: u32,
    throttling: PROCESS_POWER_THROTTLING_STATE,
    memory: u32,
}

struct Session {
    pid: u32,
    exe: String,
    saved: SavedProcess,
    /// Previous global toast setting, if we changed it.
    previous_toasts: Option<u32>,
    toasts_changed: bool,
}

// --- settings ---------------------------------------------------------------

fn enabled(app: &AppHandle) -> bool {
    crate::utils::get_setting_str(app, SETTING)
        .map(|v| v != "false")
        .unwrap_or(true)
}

// --- registry helpers -------------------------------------------------------

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn reg_get_string(root: HKEY, subkey: &str, name: &str) -> Option<String> {
    let sub = wide(subkey);
    let name_w = wide(name);
    let mut size: u32 = 0;
    unsafe {
        RegGetValueW(
            root,
            PCWSTR(sub.as_ptr()),
            PCWSTR(name_w.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    if size == 0 || size > 64 * 1024 {
        return None;
    }
    let mut buf = vec![0u16; (size as usize / 2) + 1];
    let mut size = (buf.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            root,
            PCWSTR(sub.as_ptr()),
            PCWSTR(name_w.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

fn reg_get_u32(root: HKEY, subkey: &str, name: &str) -> Option<u32> {
    let sub = wide(subkey);
    let name_w = wide(name);
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    unsafe {
        RegGetValueW(
            root,
            PCWSTR(sub.as_ptr()),
            PCWSTR(name_w.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    Some(data)
}

fn reg_write(root: HKEY, subkey: &str, name: &str, kind: REG_VALUE_TYPE, bytes: &[u8]) -> Result<(), String> {
    let sub = wide(subkey);
    let name_w = wide(name);
    let mut hkey = HKEY::default();
    unsafe {
        RegCreateKeyExW(
            root,
            PCWSTR(sub.as_ptr()),
            Some(0),
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            None,
        )
        .ok()
        .map_err(|e| e.to_string())?;
        let result = RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), Some(0), kind, Some(bytes))
            .ok()
            .map_err(|e| e.to_string());
        let _ = RegCloseKey(hkey);
        result
    }
}

fn reg_set_string(root: HKEY, subkey: &str, name: &str, value: &str) -> Result<(), String> {
    let data = wide(value);
    reg_write(root, subkey, name, REG_SZ, unsafe {
        std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2)
    })
}

fn reg_set_u32(root: HKEY, subkey: &str, name: &str, value: u32) -> Result<(), String> {
    reg_write(root, subkey, name, REG_DWORD, &value.to_le_bytes())
}

fn reg_delete(root: HKEY, subkey: &str, name: &str) -> Result<(), String> {
    let sub = wide(subkey);
    let name_w = wide(name);
    let mut hkey = HKEY::default();
    unsafe {
        // Opening with write access is enough; RegDeleteValueW does not need
        // create semantics, so a missing key is simply "nothing to delete".
        use windows::Win32::System::Registry::RegOpenKeyExW;
        if RegOpenKeyExW(
            root,
            PCWSTR(sub.as_ptr()),
            Some(0),
            KEY_WRITE | KEY_READ,
            &mut hkey,
        )
        .is_err()
        {
            return Ok(());
        }
        let result = RegDeleteValueW(hkey, PCWSTR(name_w.as_ptr())).ok();
        let _ = RegCloseKey(hkey);
        result.map_err(|e| e.to_string())
    }
}

// --- process helpers --------------------------------------------------------

fn exe_path_for_pid(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(process);
        if result.is_ok() && len > 0 {
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        } else {
            None
        }
    }
}

fn foreground_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid
}

fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

/// Is this an executable that Windows itself would treat as a game/foreground
/// app worth boosting? Kiro, the shell and shim hosts must never be touched.
fn boostable(exe: &str) -> bool {
    let name = file_name(exe).to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    // Never touch anything that ships with Windows. LockApp, the shell hosts
    // and SystemApps go "fullscreen" all the time, and an older build even
    // wrote a graphics profile for LockApp.exe just because the lock screen
    // was in front. Those must never be boosted or get registry changes.
    if let Ok(windir) = std::env::var("WINDIR") {
        let windir = windir.to_ascii_lowercase();
        if !windir.is_empty() && exe.to_ascii_lowercase().starts_with(&windir) {
            return false;
        }
    }
    !matches!(
        name.as_str(),
        "kiro.exe"
            | "explorer.exe"
            | "dwm.exe"
            | "searchhost.exe"
            | "searchapp.exe"
            | "startmenuexperiencehost.exe"
            | "shellexperiencehost.exe"
            | "applicationframehost.exe"
            | "runtimebroker.exe"
            | "lockapp.exe"
            | "sihost.exe"
            | "textinputhost.exe"
            | "taskmgr.exe"
            | "notepad.exe"
            | "snippingtool.exe"
            // Browsers and players go "fullscreen" all the time. Boosting them
            // costs battery and writing them a graphics profile would be wrong.
            | "chrome.exe"
            | "msedge.exe"
            | "msedgewebview2.exe"
            | "firefox.exe"
            | "brave.exe"
            | "opera.exe"
            | "vivaldi.exe"
            | "vlc.exe"
            | "mpv.exe"
            | "potplayermini.exe"
            | "potplayermini64.exe"
            | "wmplayer.exe"
            | "obs32.exe"
            | "obs64.exe"
            | "code.exe"
            | "cursor.exe"
            | "windsurf.exe"
            | "opencode.exe"
            | "devenv.exe"
            | "discord.exe"
            | "slack.exe"
            | "teams.exe"
            | "ms-teams.exe"
            | "zoom.exe"
            | "powerpnt.exe"
            | "acrobat.exe"
            | "photos.exe"
            | "gamebar.exe"
            | "steamwebhelper.exe"
            | "omencommandcenterbackground.exe"
            | "omencommandcenter.exe"
            | "omen gaming hub.exe"
            | "logonui.exe"
            | "useroobebroker.exe"
            | "systemsettings.exe"
            | "windowssecurity.exe"
    )
}

/// Per-app registry profiles are only ever written for executables that live in
/// a normal install location. Anything under the Windows folder is an OS
/// component and must never get a graphics profile.
fn profile_allowed(exe: &str) -> bool {
    let lower = exe.to_ascii_lowercase();
    if lower.contains("\\windows\\") || lower.contains("\\windowsapps\\") {
        return false;
    }
    boostable(exe)
}

/// Foreground check shared by the automatic performance mode and the native
/// game boost. They used to trigger on *any* fullscreen window that was not a
/// video player, so shell surfaces (the notification view, for example) hid the
/// dock/notch and dropped Kiro's priority while the user was just reading a
/// toast. Only boost an executable we would also boost.
///
/// If the owning process cannot be resolved (protected game process), keep the
/// old behaviour: a real game must not lose its FPS because Windows refused to
/// hand us the path.
pub fn perf_boostable(hwnd: HWND) -> bool {
    match exe_path_for_pid(foreground_pid(hwnd)) {
        Some(exe) => boostable(&exe),
        None => true,
    }
}

fn set_process_boost(pid: u32) -> Option<SavedProcess> {
    unsafe {
        let process = OpenProcess(
            PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        )
        .ok()?;

        let priority = GetPriorityClass(process);

        let mut throttling = PROCESS_POWER_THROTTLING_STATE::default();
        let throttle_ok = GetProcessInformation(
            process,
            windows::Win32::System::Threading::ProcessPowerThrottling,
            &mut throttling as *mut _ as *mut _,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        )
        .is_ok();

        let mut memory = MEMORY_PRIORITY_INFORMATION::default();
        let memory_ok = GetProcessInformation(
            process,
            windows::Win32::System::Threading::ProcessMemoryPriority,
            &mut memory as *mut _ as *mut _,
            std::mem::size_of::<MEMORY_PRIORITY_INFORMATION>() as u32,
        )
        .is_ok();

        // HIGH is only safe when the machine actually has cores to spare.
        // On a small laptop it can starve audio and the compositor, which
        // shows up as stutter instead of the win we are after, so 8 cores is
        // the line. Everything else only goes one step above normal.
        let cores = std::thread::available_parallelism()
            .map(|c| c.get())
            .unwrap_or(4);
        let target = if cores >= 8 {
            HIGH_PRIORITY_CLASS
        } else {
            ABOVE_NORMAL_PRIORITY_CLASS
        };
        let _ = SetPriorityClass(process, target);

        if throttle_ok {
            let cleared = PROCESS_POWER_THROTTLING_STATE {
                Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
                StateMask: 0,
            };
            let _ = SetProcessInformation(
                process,
                windows::Win32::System::Threading::ProcessPowerThrottling,
                &cleared as *const _ as *const _,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            );
        }

        if memory_ok {
            // 7 = MEMORY_PRIORITY_HIGH. The crate only exposes up to NORMAL.
            let high = MEMORY_PRIORITY_INFORMATION {
                MemoryPriority: MEMORY_PRIORITY(7),
            };
            let _ = SetProcessInformation(
                process,
                windows::Win32::System::Threading::ProcessMemoryPriority,
                &high as *const _ as *const _,
                std::mem::size_of::<MEMORY_PRIORITY_INFORMATION>() as u32,
            );
        }

        let _ = CloseHandle(process);

        Some(SavedProcess {
            priority: priority as u32,
            throttling: if throttle_ok {
                throttling
            } else {
                PROCESS_POWER_THROTTLING_STATE::default()
            },
            memory: if memory_ok {
                memory.MemoryPriority.0
            } else {
                MEMORY_PRIORITY_NORMAL_VALUE
            },
        })
    }
}

const MEMORY_PRIORITY_NORMAL_VALUE: u32 = 5;

fn restore_process_boost(pid: u32, saved: SavedProcess) {
    if pid == 0 {
        return;
    }
    unsafe {
        let Ok(process) = OpenProcess(
            PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        ) else {
            // Process is gone; priority classes and throttling state are
            // per-process, so there is nothing left to undo.
            return;
        };
        let _ = SetPriorityClass(process, PROCESS_CREATION_FLAGS(saved.priority));
        if saved.throttling.Version != 0 {
            let _ = SetProcessInformation(
                process,
                windows::Win32::System::Threading::ProcessPowerThrottling,
                &saved.throttling as *const _ as *const _,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            );
        }
        let memory = MEMORY_PRIORITY_INFORMATION {
            MemoryPriority: MEMORY_PRIORITY(saved.memory),
        };
        let _ = SetProcessInformation(
            process,
            windows::Win32::System::Threading::ProcessMemoryPriority,
            &memory as *const _ as *const _,
            std::mem::size_of::<MEMORY_PRIORITY_INFORMATION>() as u32,
        );
        let _ = CloseHandle(process);
    }
}

// --- per-application profiles ----------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Profile {
    pub exe: String,
    #[serde(default)]
    pub gpu_previous: Option<String>,
    #[serde(default)]
    pub layers_previous: Option<String>,
    #[serde(default)]
    pub applied: bool,
    #[serde(default)]
    pub seen: u32,
    /// True for profiles written without asking, by a build that did that.
    /// Those are reverted at startup; everything the user applies is false.
    #[serde(default = "default_auto")]
    pub auto: bool,
}

fn default_auto() -> bool {
    true
}

#[derive(Serialize, Deserialize, Default)]
struct ProfileFile {
    #[serde(default)]
    profiles: Vec<Profile>,
}

fn profile_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|p| p.join("fps-profiles.json"))
}

fn load_profiles(app: &AppHandle) -> ProfileFile {
    profile_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

fn save_profiles(app: &AppHandle, file: &ProfileFile) {
    let Some(path) = profile_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(file) {
        let _ = std::fs::write(path, json);
    }
}

fn apply_registry_profile(exe: &str) -> Result<(), String> {
    let current_gpu = reg_get_string(HKEY_CURRENT_USER, GPU_KEY, exe).unwrap_or_default();
    if !current_gpu.to_ascii_lowercase().contains("gpupreference=2") {
        reg_set_string(HKEY_CURRENT_USER, GPU_KEY, exe, "GpuPreference=2;")?;
    }

    let current_layers = reg_get_string(HKEY_CURRENT_USER, LAYERS_KEY, exe).unwrap_or_default();
    if !current_layers
        .to_ascii_uppercase()
        .contains("DISABLEDXMAXIMIZEDWINDOWEDMODE")
    {
        let next = if current_layers.trim().is_empty() {
            "~ DISABLEDXMAXIMIZEDWINDOWEDMODE".to_string()
        } else if current_layers.trim_start().starts_with('~') {
            format!("{current_layers} DISABLEDXMAXIMIZEDWINDOWEDMODE")
        } else {
            format!("~ DISABLEDXMAXIMIZEDWINDOWEDMODE {current_layers}")
        };
        reg_set_string(HKEY_CURRENT_USER, LAYERS_KEY, exe, &next)?;
    }
    Ok(())
}

fn revert_registry_profile(profile: &Profile) {
    match profile.gpu_previous.as_deref() {
        Some(previous) => {
            let _ = reg_set_string(HKEY_CURRENT_USER, GPU_KEY, &profile.exe, previous);
        }
        None => {
            let _ = reg_delete(HKEY_CURRENT_USER, GPU_KEY, &profile.exe);
        }
    }
    match profile.layers_previous.as_deref() {
        Some(previous) => {
            let _ = reg_set_string(HKEY_CURRENT_USER, LAYERS_KEY, &profile.exe, previous);
        }
        None => {
            let _ = reg_delete(HKEY_CURRENT_USER, LAYERS_KEY, &profile.exe);
        }
    }
}

/// Older builds applied graphics profiles without asking. `auto` is false on
/// every profile the user applies deliberately from Settings, so this only ever
/// undoes the writes nobody approved (it even hit `LockApp.exe`).
fn revert_auto_profiles(app: &AppHandle) {
    let mut file = load_profiles(app);
    let mut reverted = 0;
    for profile in file.profiles.iter_mut() {
        if profile.applied && profile.auto {
            revert_registry_profile(profile);
            profile.applied = false;
            reverted += 1;
        }
    }
    if reverted > 0 {
        save_profiles(app, &file);
        crate::diagnostics::log(&format!(
            "fps boost: restored {reverted} registry profile(s) written without approval"
        ));
    }
}

/// Record that this exe ran fullscreen. Never writes to the registry: a
/// graphics profile changes how Windows launches that exe forever, so it is
/// only ever written when the user clicks the suggestion in Settings
/// (spec rule: `Apply()` never exists without an explicit approval).
fn note_sighting(app: &AppHandle, exe: &str) {
    if !profile_allowed(exe) {
        return;
    }
    let mut file = load_profiles(app);
    if let Some(profile) = file.profiles.iter_mut().find(|p| p.exe.eq_ignore_ascii_case(exe)) {
        let next = profile.seen.saturating_add(1);
        if next != profile.seen {
            profile.seen = next;
            save_profiles(app, &file);
        }
        return;
    }
    let profile = Profile {
        exe: exe.to_string(),
        gpu_previous: reg_get_string(HKEY_CURRENT_USER, GPU_KEY, exe),
        layers_previous: reg_get_string(HKEY_CURRENT_USER, LAYERS_KEY, exe),
        applied: false,
        seen: 1,
        auto: false,
    };
    file.profiles.push(profile);
    save_profiles(app, &file);
}

/// Write the per-app graphics profile for one executable. Called only from the
/// Settings button, never automatically.
fn apply_profile_for(app: &AppHandle, exe: &str) -> Result<(), String> {
    if !profile_allowed(exe) {
        return Err("Bu uygulama için profil yazılmaz.".to_string());
    }
    let mut file = load_profiles(app);
    let position = match file.profiles.iter().position(|p| p.exe.eq_ignore_ascii_case(exe)) {
        Some(position) => position,
        None => {
            file.profiles.push(Profile {
                exe: exe.to_string(),
                gpu_previous: reg_get_string(HKEY_CURRENT_USER, GPU_KEY, exe),
                layers_previous: reg_get_string(HKEY_CURRENT_USER, LAYERS_KEY, exe),
                applied: false,
                seen: 0,
                auto: false,
            });
            file.profiles.len() - 1
        }
    };
    // Back up the current values before touching anything, then write.
    let profile = &mut file.profiles[position];
    profile.gpu_previous = reg_get_string(HKEY_CURRENT_USER, GPU_KEY, exe);
    profile.layers_previous = reg_get_string(HKEY_CURRENT_USER, LAYERS_KEY, exe);
    let gpu_before = profile.gpu_previous.clone();
    let layers_before = profile.layers_previous.clone();
    save_profiles(app, &file);

    if let Err(error) = apply_registry_profile(exe) {
        // Put back whatever the first write managed to change.
        let restore = Profile {
            exe: exe.to_string(),
            gpu_previous: gpu_before,
            layers_previous: layers_before,
            applied: false,
            seen: 0,
            auto: false,
        };
        revert_registry_profile(&restore);
        return Err(error);
    }

    if let Some(profile) = file.profiles.iter_mut().find(|p| p.exe.eq_ignore_ascii_case(exe)) {
        profile.applied = true;
        profile.auto = false;
    }
    save_profiles(app, &file);
    crate::diagnostics::log(&format!("fps boost: user applied graphics profile for {exe}"));
    Ok(())
}

// --- session engage / release ----------------------------------------------

/// Drop records that were collected before the exclusion rules existed (the
/// lock screen, dev tools) and revert anything they applied.
fn prune_profiles(app: &AppHandle) {
    let mut file = load_profiles(app);
    let before = file.profiles.len();
    let mut removed = Vec::new();
    file.profiles.retain(|profile| {
        if profile_allowed(&profile.exe) {
            true
        } else {
            removed.push(profile.clone());
            false
        }
    });
    if removed.is_empty() {
        return;
    }
    for profile in &removed {
        if profile.applied {
            revert_registry_profile(profile);
        }
    }
    save_profiles(app, &file);
    crate::diagnostics::log(&format!(
        "fps boost: pruned {} non-game profile(s) (was {before})",
        removed.len()
    ));
}

fn mute_toasts(app: &AppHandle) -> (Option<u32>, bool) {
    let previous = reg_get_u32(HKEY_CURRENT_USER, NOTIF_KEY, TOASTS_VALUE);
    if previous == Some(0) {
        return (previous, false);
    }
    if reg_set_u32(HKEY_CURRENT_USER, NOTIF_KEY, TOASTS_VALUE, 0).is_err() {
        return (previous, false);
    }
    // Persist the old value before we change anything: if Kiro is killed while
    // a game runs, the next launch must put the user's notifications back.
    if let Some(path) = toast_backup_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let backup = ToastBackup {
            previous,
            changed: true,
        };
        if let Ok(json) = serde_json::to_string(&backup) {
            let _ = std::fs::write(path, json);
        }
    }
    (previous, true)
}

fn restore_toasts(app: &AppHandle, previous: Option<u32>) {
    // If the value is no longer muted, something else owns it now (the user hit
    // the Do Not Disturb button, Windows Settings, ...). Put nothing back so we
    // never silently undo a choice the user made while the game was running.
    if reg_get_u32(HKEY_CURRENT_USER, NOTIF_KEY, TOASTS_VALUE) != Some(0) {
        if let Some(path) = toast_backup_path(app) {
            let _ = std::fs::remove_file(path);
        }
        return;
    }
    match previous {
        Some(value) => {
            let _ = reg_set_u32(HKEY_CURRENT_USER, NOTIF_KEY, TOASTS_VALUE, value);
        }
        None => {
            let _ = reg_delete(HKEY_CURRENT_USER, NOTIF_KEY, TOASTS_VALUE);
        }
    }
    if let Some(path) = toast_backup_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

#[derive(Serialize, Deserialize)]
struct ToastBackup {
    previous: Option<u32>,
    changed: bool,
}

fn toast_backup_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|p| p.join("fps-toast-backup.json"))
}

/// Undo anything a previous Kiro process left behind. Runs at startup, before
/// the foreground watcher exists.
pub fn init(app: &AppHandle) {
    // Nothing is ever written to the registry without the user asking, so any
    // profile marked `auto` came from a build that did it silently. Undo those.
    revert_auto_profiles(app);
    prune_profiles(app);
    let Some(path) = toast_backup_path(app) else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    if let Ok(backup) = serde_json::from_str::<ToastBackup>(&text) {
        if backup.changed {
            restore_toasts(app, backup.previous);
            crate::diagnostics::log("fps boost: restored notifications from a previous session");
        }
    }
    let _ = std::fs::remove_file(path);
}

/// Called from the quit path so nothing stays muted when Kiro exits mid-game.
pub fn shutdown(app: &AppHandle) {
    release(app);
    init(app);
}

fn engage(app: &AppHandle, pid: u32) {
    let Some(exe) = exe_path_for_pid(pid) else {
        return;
    };
    if !boostable(&exe) {
        return;
    }
    let Some(saved) = set_process_boost(pid) else {
        // Protected (anti-cheat) or elevated process: leave it alone. That is
        // a normal outcome, never an error the user needs to see.
        return;
    };
    let (previous_toasts, toasts_changed) = mute_toasts(app);

    if let Ok(mut session) = SESSION.lock() {
        *session = Some(Session {
            pid,
            exe: exe.clone(),
            saved,
            previous_toasts,
            toasts_changed,
        });
    }
    ACTIVE.store(true, Ordering::Relaxed);
    crate::diagnostics::log(&format!(
        "fps boost: on for {exe} (pid {pid}, {} cores)",
        std::thread::available_parallelism().map(|c| c.get()).unwrap_or(0)
    ));
    // Count a sighting once per process, not once per alt-tab.
    let count_this = LAST_PROFILE_PID
        .lock()
        .map(|mut last| {
            if *last == Some(pid) {
                false
            } else {
                *last = Some(pid);
                true
            }
        })
        .unwrap_or(true);
    if count_this {
        note_sighting(app, &exe);
    }
    let _ = app.emit("fps-boost", status_payload(app));
}

fn release(app: &AppHandle) {
    let session = match SESSION.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    };
    if let Some(session) = session {
        restore_process_boost(session.pid, session.saved);
        if session.toasts_changed {
            restore_toasts(app, session.previous_toasts);
        }
        crate::diagnostics::log(&format!("fps boost: off ({})", session.exe));
    }
    if ACTIVE.swap(false, Ordering::Relaxed) {
        let _ = app.emit("fps-boost", status_payload(app));
    }
}

fn clear_timers() {
    if let Ok(mut since) = SINCE.lock() {
        *since = None;
    }
    if let Ok(mut since) = MISSING_SINCE.lock() {
        *since = None;
    }
}

/// Re-evaluate the boost. Called by the foreground watcher on every tick.
pub fn update(app: &AppHandle, fullscreen: bool, hwnd: HWND) {
    if !enabled(app) {
        release(app);
        clear_timers();
        return;
    }

    if !fullscreen || hwnd.is_invalid() {
        if !ACTIVE.load(Ordering::Relaxed) {
            clear_timers();
            return;
        }
        let give_back = match MISSING_SINCE.lock() {
            Ok(mut since) => since.get_or_insert_with(Instant::now).elapsed() >= RELEASE_HOLD,
            Err(_) => true,
        };
        if give_back {
            release(app);
            clear_timers();
        }
        return;
    }

    if let Ok(mut since) = MISSING_SINCE.lock() {
        *since = None;
    }

    let pid = foreground_pid(hwnd);
    if ACTIVE.load(Ordering::Relaxed) {
        let same = SESSION
            .lock()
            .ok()
            .and_then(|s| s.as_ref().map(|s| s.pid))
            == Some(pid);
        if same {
            return;
        }
        // A different game took over: hand the previous one its settings back.
        release(app);
    }

    let ready = match SINCE.lock() {
        Ok(mut since) => since.get_or_insert_with(Instant::now).elapsed() >= HOLD,
        Err(_) => true,
    };
    if !ready {
        return;
    }
    let blocked = RETRY_AFTER
        .lock()
        .ok()
        .and_then(|r| *r)
        .is_some_and(|(blocked_pid, at)| blocked_pid == pid && at.elapsed() < Duration::from_secs(30));
    if blocked {
        return;
    }
    engage(app, pid);
    if !ACTIVE.load(Ordering::Relaxed) {
        if let Ok(mut retry) = RETRY_AFTER.lock() {
            *retry = Some((pid, Instant::now()));
        }
    }
}

// --- status ----------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct BoostState {
    pub active: bool,
    pub exe: Option<String>,
    pub pid: Option<u32>,
}

pub fn state() -> BoostState {
    let session = SESSION.lock().ok().and_then(|s| {
        s.as_ref().map(|s| (s.exe.clone(), s.pid))
    });
    BoostState {
        active: ACTIVE.load(Ordering::Relaxed),
        exe: session.as_ref().map(|(e, _)| e.clone()),
        pid: session.map(|(_, p)| p),
    }
}

fn status_payload(app: &AppHandle) -> BoostState {
    let _ = app;
    state()
}

#[derive(Serialize, Clone)]
pub struct ProfileInfo {
    pub exe: String,
    pub name: String,
    pub applied: bool,
    /// How many fullscreen sessions Kiro has seen. The UI turns this into a
    /// suggestion ("bu oyunu yüksek performanslı GPU'ya sabitle") instead of
    /// writing the registry behind the user's back.
    pub seen: u32,
}

#[tauri::command]
pub fn fps_boost_state() -> BoostState {
    state()
}

#[tauri::command]
pub fn fps_boost_profiles(app: AppHandle) -> Vec<ProfileInfo> {
    let mut profiles: Vec<ProfileInfo> = load_profiles(&app)
        .profiles
        .into_iter()
        .map(|p| ProfileInfo {
            name: file_name(&p.exe),
            exe: p.exe,
            applied: p.applied,
            seen: p.seen,
        })
        .collect();
    profiles.sort_by(|a, b| b.seen.cmp(&a.seen));
    profiles
}

/// Write the graphics profile for one game. Explicit user action only.
#[tauri::command]
pub fn fps_boost_apply_profile(app: AppHandle, exe: String) -> Result<(), String> {
    apply_profile_for(&app, &exe)
}

#[tauri::command]
pub fn fps_boost_remove_profile(app: AppHandle, exe: String) -> Result<(), String> {
    let mut file = load_profiles(&app);
    if let Some(pos) = file
        .profiles
        .iter()
        .position(|p| p.exe.eq_ignore_ascii_case(&exe))
    {
        let profile = file.profiles.remove(pos);
        if profile.applied {
            revert_registry_profile(&profile);
        }
        save_profiles(&app, &file);
        crate::diagnostics::log(&format!("fps boost: reverted profile for {exe}"));
    }
    Ok(())
}

#[tauri::command]
pub fn fps_boost_restore_all(app: AppHandle) -> Result<(), String> {
    let mut file = load_profiles(&app);
    for profile in &file.profiles {
        if profile.applied {
            revert_registry_profile(profile);
        }
    }
    file.profiles.clear();
    save_profiles(&app, &file);
    crate::diagnostics::log("fps boost: all application profiles reverted");
    Ok(())
}

// --- optional system-wide gaming tweaks ------------------------------------

/// Keys Windows itself exposes in Settings > Gaming. Off by default; the user
/// asks for them explicitly in the FPS panel. Previous values are stored next
/// to the profiles so turning the switch off restores the machine exactly.
fn system_backup_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|p| p.join("fps-system-backup.json"))
}

#[derive(Serialize, Deserialize, Default)]
struct SystemBackup {
    #[serde(default)]
    values: Vec<(String, Option<u32>)>,
}

fn tweak_targets() -> [(&'static str, HKEY, &'static str, &'static str, u32); 4] {
    [
        ("game_dvr", HKEY_CURRENT_USER, GAME_DVR_KEY, "GameDVR_Enabled", 0),
        ("app_capture", HKEY_CURRENT_USER, APP_CAPTURE_KEY, "AppCaptureEnabled", 0),
        ("game_mode", HKEY_CURRENT_USER, GAME_BAR_KEY, "AutoGameModeEnabled", 1),
        ("windowed_opt", HKEY_CURRENT_USER, DX_GRAPHICS_KEY, "SwapEffectUpgradeEnable", 1),
    ]
}

fn gaming_tweaks_active() -> bool {
    let targets = tweak_targets();
    let dvr = reg_get_u32(targets[0].1, targets[0].2, targets[0].3);
    let capture = reg_get_u32(targets[1].1, targets[1].2, targets[1].3);
    dvr == Some(0) && capture == Some(0)
}

#[tauri::command]
pub fn fps_boost_system_tweaks_active() -> bool {
    gaming_tweaks_active()
}

#[tauri::command]
pub fn fps_boost_set_system_tweaks(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let path = system_backup_path(&app);
    if enabled {
        let mut backup = SystemBackup::default();
        for (name, root, key, value, target) in tweak_targets() {
            backup
                .values
                .push((name.to_string(), reg_get_u32(root, key, value)));
            reg_set_u32(root, key, value, target)?;
        }
        if let Some(path) = &path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(&backup) {
                let _ = std::fs::write(path, json);
            }
        }
        crate::diagnostics::log("fps boost: system gaming tweaks on");
    } else {
        let backup: SystemBackup = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default();
        let targets = tweak_targets();
        for (name, previous) in backup.values {
            let Some((_, root, key, value, _)) = targets.iter().find(|t| t.0 == name) else {
                continue;
            };
            match previous {
                Some(v) => {
                    let _ = reg_set_u32(*root, key, value, v);
                }
                None => {
                    let _ = reg_delete(*root, key, value);
                }
            }
        }
        if let Some(path) = &path {
            let _ = std::fs::remove_file(path);
        }
        crate::diagnostics::log("fps boost: system gaming tweaks off");
    }
    Ok(gaming_tweaks_active())
}

// --- hardware audit --------------------------------------------------------

#[derive(Serialize, Clone, Default)]
pub struct Finding {
    /// "good" | "warn" | "bad" | "info"
    pub level: String,
    pub title: String,
    pub detail: String,
    pub gain: String,
}

#[derive(Serialize, Clone, Default)]
pub struct GpuAudit {
    pub name: String,
    pub driver: String,
    pub power_limit: Option<f64>,
    pub power_max: Option<f64>,
    pub display_active: Option<bool>,
    pub utilization: Option<f64>,
}

#[derive(Serialize, Clone, Default)]
pub struct AuditReport {
    pub gpus: Vec<GpuAudit>,
    pub refresh_hz: u32,
    pub ram_total_mb: u64,
    pub ram_modules: Vec<String>,
    pub ram_asymmetric: bool,
    pub hags: bool,
    pub game_drive: Option<String>,
    pub findings: Vec<Finding>,
}

fn nvidia_smi() -> Vec<GpuAudit> {
    use std::os::windows::process::CommandExt;
    // One shot, hidden console, short timeout by the caller's thread.
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,driver_version,power.limit,enforced.power.limit,power.max_limit,display_active,utilization.gpu",
            "--format=csv,noheader,nounits",
        ])
        .creation_flags(0x0800_0000)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').map(|p| p.trim()).collect();
            if parts.len() < 7 {
                return None;
            }
            // `power.limit` is [N/A] on many laptop drivers; the enforced limit
            // is what the GPU is actually allowed to draw right now.
            let limit = parts[2]
                .parse::<f64>()
                .ok()
                .or_else(|| parts[3].parse::<f64>().ok());
            Some(GpuAudit {
                name: parts[0].to_string(),
                driver: parts[1].to_string(),
                power_limit: limit,
                power_max: parts[4].parse().ok(),
                display_active: match parts[5].to_ascii_lowercase().as_str() {
                    "enabled" => Some(true),
                    "disabled" => Some(false),
                    _ => None,
                },
                utilization: parts[6].parse().ok(),
            })
        })
        .collect()
}

fn current_refresh_hz() -> u32 {
    use windows::Win32::Graphics::Gdi::{
        EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS,
    };
    let mut devmode = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    let ok = unsafe { EnumDisplaySettingsW(PCWSTR::null(), ENUM_CURRENT_SETTINGS, &mut devmode) };
    if ok.as_bool() {
        devmode.dmDisplayFrequency
    } else {
        0
    }
}

fn ram_layout() -> (u64, Vec<String>, bool) {
    use serde::Deserialize;
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct MemoryModule {
        capacity: Option<u64>,
        speed: Option<u32>,
        manufacturer: Option<String>,
    }

    let total = unsafe {
        let mut kb = 0u64;
        if windows::Win32::System::SystemInformation::GetPhysicallyInstalledSystemMemory(&mut kb)
            .is_ok()
        {
            kb / 1024
        } else {
            0
        }
    };

    let Ok(com) = wmi::COMLibrary::new() else {
        return (total, Vec::new(), false);
    };
    let Ok(connection) = wmi::WMIConnection::new(com) else {
        return (total, Vec::new(), false);
    };
    let Ok(modules): Result<Vec<MemoryModule>, _> = connection.raw_query(
        "SELECT Capacity, Speed, Manufacturer FROM Win32_PhysicalMemory",
    ) else {
        return (total, Vec::new(), false);
    };

    let mut labels = Vec::new();
    let mut capacities = Vec::new();
    for module in &modules {
        let gb = module.capacity.unwrap_or(0) as f64 / 1024.0 / 1024.0 / 1024.0;
        capacities.push(module.capacity.unwrap_or(0));
        labels.push(format!(
            "{:.0} GB{} @ {} MHz",
            gb,
            module
                .manufacturer
                .as_deref()
                .filter(|m| !m.trim().is_empty())
                .map(|m| format!(" {}", m.trim()))
                .unwrap_or_default(),
            module.speed.unwrap_or(0)
        ));
    }
    let asymmetric = capacities.len() > 1 && capacities.iter().any(|c| *c != capacities[0]);
    (total, labels, asymmetric)
}

fn hags_enabled() -> bool {
    reg_get_u32(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers",
        "HwSchMode",
    ) == Some(2)
}

fn drive_type_for(exe: Option<&str>) -> Option<String> {
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    let exe = exe?;
    let bytes: Vec<u16> = exe.chars().map(|c| c as u16).collect();
    if bytes.len() < 2 || bytes[1] != b':' as u16 {
        return None;
    }
    // DRIVE_REMOVABLE = 2, DRIVE_FIXED = 3, DRIVE_REMOTE = 4 (winbase.h).
    let root = [bytes[0], bytes[1], b'\\' as u16, 0u16];
    let kind = unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) };
    Some(match kind {
        3 => "SSD/HDD".to_string(),
        2 => "çıkarılabilir disk".to_string(),
        4 => "ağ sürücüsü".to_string(),
        _ => format!("bilinmiyor ({kind})"),
    })
}

fn build_findings(report: &AuditReport) -> Vec<Finding> {
    let mut findings = Vec::new();
    let any;
    {
    let mut push = |level: &str, title: &str, detail: &str, gain: &str| {
        findings.push(Finding {
            level: level.to_string(),
            title: title.to_string(),
            detail: detail.to_string(),
            gain: gain.to_string(),
        });
    };

    for gpu in &report.gpus {
        if gpu.display_active == Some(false) {
            push(
                "bad",
                "Ekranı iGPU sürüyor",
                "Oyunu NVIDIA render ediyor ama kareleri AMD/Intel ekran birimine kopyalanıp ekrana gidiyor. MUX anahtarı varsa (OMEN Gaming Hub, Armoury Crate, Lenovo Vantage) ayrık moda al; yoksa Windows Ayarlar > Ekran > Grafik'ten oyunu Yüksek performans'a sabitle.",
                "+5-15%",
            );
        }
        if let (Some(limit), Some(max)) = (gpu.power_limit, gpu.power_max) {
            if max - limit > 1.0 {
                push(
                    "warn",
                    "GPU güç limiti kısık",
                    &format!(
                        "{} şu an {:.0} W ile sınırlı, izin verilen en yüksek değer {:.0} W. Üreticinin performans modunu aç (Dynamic Boost / Maksimum performans) ve adaptörün takılı olduğundan emin ol.",
                        gpu.name, limit, max
                    ),
                    "+10-15%",
                );
            }
        }
        if let Some(util) = gpu.utilization {
            if util > 95.0 {
                push(
                    "info",
                    "Bu sahnede darboğaz GPU'da",
                    &format!(
                        "GPU kullanımı %{:.0}. Bu durumda CPU önceliği ve RAM ayarları ölçülebilir bir kazanç vermez; kazanç FPS limiti, upscaler (DLSS/FSR) ve sıcaklık tarafında. Kiro bunu bilerek boşuna tweak uygulamaz.",
                        util
                    ),
                    "—",
                );
            }
        }
    }

    if report.ram_total_mb > 0 && report.ram_total_mb < 16384 {
        push(
            "warn",
            "RAM toplamı düşük",
            &format!(
                "{} MB fiziksel RAM var. Oyun + Windows için sınırda; 16 GB'a çıkmak CPU'ya bağlı sahnelerde en büyük tek kazanç.",
                report.ram_total_mb
            ),
            "+5-15%",
        );
    }
    if report.ram_modules.len() > 1 && report.ram_asymmetric {
        push(
            "warn",
            "RAM kanalları asimetrik",
            "Farklı boyutlarda modüller Flex Mode'a düşer: RAM'in bir kısmı tek kanal çalışır, CPU'ya bağlı oyunlarda %5-15 kayıp olur. Aynı boyutta iki modül (ör. 8+8) tam dual-channel verir.",
            "+5-15% (CPU'da)",
        );
    }

    if !report.hags {
        push(
            "info",
            "Donanım hızlandırmalı GPU zamanlaması kapalı",
            "Windows Ayarlar > Sistem > Ekran > Grafik > Varsayılan grafik ayarları > 'Donanım hızlandırmalı GPU zamanlaması'nı aç. Yeniden başlatma gerekir; GPU'ya bağlı sahnelerde gecikmeyi düşürür.",
            "0-3%",
        );
    }

    if report.refresh_hz > 0 {
        let cap = report.refresh_hz.saturating_sub(6);
        push(
            "good",
            &format!("Ekran {} Hz", report.refresh_hz),
            &format!(
                "Sürekli tam yükte çalışmak yerine FPS'i {} civarına sabitlemek GPU'yu soğutur, frekansın düşmesini engeller. Oyun içi FPS limiti + NVIDIA Reflex en iyi ikili.",
                cap
            ),
            "+3-8%",
        );
    }

    if let Some(drive) = &report.game_drive {
        if drive.contains("SSD/HDD") {
            push(
                "info",
                "Oyun diski",
                &format!("Oyun {drive} üzerinde. Doku akışı kaynaklı takılmalar için oyunu SSD'ye taşımak frametime kuyruğunu düzeltir."),
                "0-5%",
            );
        }
    }

    any = !findings.is_empty();
    }
    if !any {
        findings.push(Finding {
            level: "good".to_string(),
            title: "Belirgin bir kayıp bulunamadı".to_string(),
            detail: "Okunabilen donanım ayarlarının hepsi yerinde. Kalan kazanç oyun içi ayarlarda (upscaler, FPS limiti, gölge/ışık kalitesi).".to_string(),
            gain: "—".to_string(),
        });
    }
    findings
}

#[tauri::command]
pub async fn fps_boost_audit(exe: Option<String>) -> Result<AuditReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let gpus = nvidia_smi();
        let (ram_total_mb, ram_modules, ram_asymmetric) = ram_layout();
        let mut report = AuditReport {
            gpus,
            refresh_hz: current_refresh_hz(),
            ram_total_mb,
            ram_modules,
            ram_asymmetric,
            hags: hags_enabled(),
            game_drive: drive_type_for(exe.as_deref()),
            findings: Vec::new(),
        };
        report.findings = build_findings(&report);
        report
    })
    .await
    .map_err(|e| e.to_string())
}
