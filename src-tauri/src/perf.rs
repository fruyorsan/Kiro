//! Automatic performance mode.
//!
//! When a fullscreen game owns the screen, the dock/notch are hidden anyway, so
//! there is no reason to keep spending CPU and GPU on them. In this mode Kiro:
//!
//! * stops capturing window thumbnails and icons,
//! * slows the foreground and mouse polling loops down,
//! * stops trimming its own working set (page faults would only fight the game
//!   for disk I/O),
//! * tells the frontend to drop blur and animations (`perf-mode` event).
//!
//! Fullscreen video is deliberately excluded (see `services::is_video_window`):
//! a movie does not need the boost, and flipping the mode on YouTube made the
//! notch stutter. Everything is restored automatically when the game goes away.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

/// Setting key that allows the user to turn the behaviour off.
pub const SETTING: &str = "kiro-auto-perf";

/// A window has to stay fullscreen this long before the mode engages. Splash
/// screens, alt-tab animations and screenshot tools go fullscreen for a moment
/// and must not make the UI flicker.
const HOLD: Duration = Duration::from_millis(1500);

/// Once the fullscreen app disappears, wait this long before giving the boost
/// back. Focus blips (video controls, notifications, our own windows) would
/// otherwise toggle the mode and re-trim the renderers several times a minute.
const RELEASE_HOLD: Duration = Duration::from_secs(3);

static ACTIVE: AtomicBool = AtomicBool::new(false);
static SINCE: Mutex<Option<Instant>> = Mutex::new(None);
static MISSING_SINCE: Mutex<Option<Instant>> = Mutex::new(None);

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
    if let Ok(mut missing) = MISSING_SINCE.lock() {
        *missing = None;
    }
    if ACTIVE.swap(false, Ordering::Relaxed) {
        release_boost();
        crate::diagnostics::log("auto perf mode: off");
        let _ = app.emit("perf-mode", false);
    }
}

/// Put our own process on the efficiency track while a game runs: EcoQoS lets
/// Windows schedule us on low-power cores and keeps our pages at the front of
/// the trim queue, so the game keeps the performance cores and its working
/// set. Both settings are per-process and fully reversible.
#[cfg(target_os = "windows")]
unsafe fn set_power_throttling(on: bool) {
    use windows::Win32::System::Threading::{
        GetCurrentProcess, ProcessMemoryPriority, ProcessPowerThrottling,
        SetProcessInformation, MEMORY_PRIORITY_INFORMATION, MEMORY_PRIORITY_LOW,
        MEMORY_PRIORITY_NORMAL, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE,
    };
    let process = GetCurrentProcess();

    let throttling = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        StateMask: if on {
            PROCESS_POWER_THROTTLING_EXECUTION_SPEED
        } else {
            0
        },
    };
    let _ = SetProcessInformation(
        process,
        ProcessPowerThrottling,
        &throttling as *const _ as *const std::ffi::c_void,
        std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
    );

    let memory = MEMORY_PRIORITY_INFORMATION {
        MemoryPriority: if on {
            MEMORY_PRIORITY_LOW
        } else {
            MEMORY_PRIORITY_NORMAL
        },
    };
    let _ = SetProcessInformation(
        process,
        ProcessMemoryPriority,
        &memory as *const _ as *const std::ffi::c_void,
        std::mem::size_of::<MEMORY_PRIORITY_INFORMATION>() as u32,
    );
}

/// Give the foreground game every advantage we can without touching it:
/// raise the system timer resolution to 1 ms (smoother frame pacing, what
/// FPS-booster utilities do), drop our own process to below-normal priority
/// so the game always wins the CPU, and push our renderers out of RAM.
fn engage_boost() {
    #[cfg(target_os = "windows")]
    unsafe {
        let _ = windows::Win32::Media::timeBeginPeriod(1);
        let _ = windows::Win32::System::Threading::SetPriorityClass(
            windows::Win32::System::Threading::GetCurrentProcess(),
            windows::Win32::System::Threading::BELOW_NORMAL_PRIORITY_CLASS,
        );
        set_power_throttling(true);
    }
    // Our own pages are the only ones we are allowed to reclaim; this frees
    // whatever the dock/notch renderers held while the game starts.
    crate::memory_saver::trim_tree();
}

fn release_boost() {
    #[cfg(target_os = "windows")]
    unsafe {
        let _ = windows::Win32::Media::timeEndPeriod(1);
        let _ = windows::Win32::System::Threading::SetPriorityClass(
            windows::Win32::System::Threading::GetCurrentProcess(),
            windows::Win32::System::Threading::NORMAL_PRIORITY_CLASS,
        );
        set_power_throttling(false);
    }
}

/// Re-evaluate the mode. Called from the foreground watcher on every tick, so
/// it reacts within one polling interval of a game starting or closing.
pub fn update(app: &AppHandle, fullscreen: bool, window_title: &str) {
    if !enabled(app) {
        deactivate(app);
        return;
    }

    if !fullscreen {
        if !ACTIVE.load(Ordering::Relaxed) {
            if let Ok(mut since) = SINCE.lock() {
                *since = None;
            }
            return;
        }
        // Give the fullscreen app a grace period: a one-tick focus blip must not
        // release the boost and restart it a second later.
        let release = match MISSING_SINCE.lock() {
            Ok(mut missing) => {
                let start = *missing.get_or_insert_with(Instant::now);
                start.elapsed() >= RELEASE_HOLD
            }
            Err(_) => true,
        };
        if release {
            deactivate(app);
        }
        return;
    }

    if let Ok(mut missing) = MISSING_SINCE.lock() {
        *missing = None;
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
    engage_boost();
    crate::diagnostics::log(&format!(
        "auto perf mode: on (fullscreen app in foreground: {window_title})"
    ));
    let _ = app.emit("perf-mode", true);

    // The first trim happens while the game is still loading level data, when
    // our renderers are the least likely to be touched. Give it a moment and
    // trim once more so anything the load pulled back in is released before
    // the GPU gets busy.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        if ACTIVE.load(Ordering::Relaxed) {
            crate::memory_saver::trim_tree();
        }
    });
}

/// Current state, for the frontend to sync right after a window is created.
pub fn state() -> bool {
    active()
}
