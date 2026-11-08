
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, SetProcessInformation, ProcessMemoryPriority,
    MEMORY_PRIORITY_INFORMATION, MEMORY_PRIORITY_NORMAL, MEMORY_PRIORITY_VERY_LOW,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

// EmptyWorkingSet pushes pages out to the pagefile. Doing that every couple of
// seconds keeps the always-on dock/notch renderers and the GPU process at a
// near-zero working set, so the first hover after idle has to fault hundreds of
// megabytes back in. That shows up as an input stutter, so trim once the app is
// properly idle and then leave it alone for a while.
const SETTLE_MS: i64 = 10_000;

// 45 s (was 2 min): the renderers grow back quickly from timers and small
// polls, so the old interval let the task-manager number sit ~100 MB above the
// trimmed floor. Trimming still only happens after SETTLE_MS of real idle and
// the whole tree is restored before the next hover, so this stays invisible.
const RETRIM_MS: i64 = 45_000;

const MEDIA_RETRIM_MS: i64 = 120_000;

const STARTUP_GRACE_MS: i64 = 8_000;

// The cursor being this close to a hot edge means a reveal is seconds away, so
// paging its renderer out now would only make that reveal stutter.
const EDGE_GUARD_PX: i32 = 48;

static BUSY: AtomicBool = AtomicBool::new(false);

static LAST_INTERACTION_MS: AtomicI64 = AtomicI64::new(0);

static TRIM_SOON: AtomicBool = AtomicBool::new(false);

static STARTED_AT_MS: AtomicI64 = AtomicI64::new(0);

/// True while the whole process tree is at MEMORY_PRIORITY_VERY_LOW. The flag
/// keeps the restore sweep out of the hot path: `mark_interaction` runs on every
/// hover/poll tick, but only the first call after an idle trim touches handles.
static LOW_PRIORITY: AtomicBool = AtomicBool::new(false);

pub fn init() {
    STARTED_AT_MS.store(crate::utils::get_now_ms(), Ordering::Relaxed);
    LAST_INTERACTION_MS.store(crate::utils::get_now_ms(), Ordering::Relaxed);
}

pub fn mark_interaction() {
    LAST_INTERACTION_MS.store(crate::utils::get_now_ms(), Ordering::Relaxed);
    TRIM_SOON.store(false, Ordering::Relaxed);
    // Back from idle: raise the tree before the user can notice. Without this
    // the first hover after a trim would be served from pages that Windows
    // already dropped, which is the stutter the old code avoided by trimming
    // rarely.
    if LOW_PRIORITY.swap(false, Ordering::Relaxed) {
        set_tree_priority(false);
    }
}

pub fn set_busy(busy: bool) {
    BUSY.store(busy, Ordering::Relaxed);
}

pub fn trim_soon() {
    TRIM_SOON.store(true, Ordering::Relaxed);
}

fn system_idle_ms() -> i64 {
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if !GetLastInputInfo(&mut info).as_bool() {
            return i64::MAX;
        }
        let now = windows::Win32::System::SystemInformation::GetTickCount();
        let elapsed = now.wrapping_sub(info.dwTime);
        elapsed as i64
    }
}

fn foreground_is_ours() -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid == std::process::id()
    }
}

/// True when the cursor sits near a screen edge, where the dock, notch or the
/// volume/brightness cards can reveal at any moment. Trimming the renderers then
/// would turn the next hover into a page-fault stall.
fn cursor_near_hot_edge() -> bool {
    unsafe {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_err() {
            return false;
        }
        // The primary monitor always sits at (0, 0) in virtual-screen coordinates.
        let (mw, mh) = (
            windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
                windows::Win32::UI::WindowsAndMessaging::SM_CXSCREEN,
            ),
            windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
                windows::Win32::UI::WindowsAndMessaging::SM_CYSCREEN,
            ),
        );
        let (mx, my) = (0, 0);
        let inside = pt.x >= mx && pt.x <= mx + mw && pt.y >= my && pt.y <= my + mh;
        if !inside {
            return false;
        }
        pt.x <= mx + EDGE_GUARD_PX
            || pt.x >= mx + mw - EDGE_GUARD_PX
            || pt.y <= my + EDGE_GUARD_PX
            || pt.y >= my + mh - EDGE_GUARD_PX
    }
}

fn tree_pids() -> Vec<u32> {
    let mut pids = Vec::with_capacity(8);
    let me = std::process::id();

    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return vec![me],
        };
        if snapshot.is_invalid() {
            return vec![me];
        }

        let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                children
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);

        let mut queue = std::collections::VecDeque::from([me]);
        while let Some(pid) = queue.pop_front() {
            pids.push(pid);
            if let Some(kids) = children.get(&pid) {
                for &kid in kids {
                    if kid != pid && !pids.contains(&kid) && queue.len() < 64 {
                        queue.push_back(kid);
                    }
                }
            }
        }
    }

    pids
}

fn trim_pid(pid: u32) -> bool {
    unsafe {
        if pid == std::process::id() {
            return EmptyWorkingSet(GetCurrentProcess()).is_ok();
        }

        let handle: HANDLE = match OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA,
            false,
            pid,
        ) {
            Ok(h) => h,
            Err(_) => return false,
        };
        let ok = EmptyWorkingSet(handle).is_ok();
        let _ = CloseHandle(handle);
        ok
    }
}

pub fn trim_tree() -> usize {
    let mut trimmed = 0;
    for pid in tree_pids() {
        if trim_pid(pid) {
            trimmed += 1;
        }
    }
    trimmed
}

/// Memory priority is the per-process hint Windows' trimmer uses when RAM gets
/// tight. Idle Kiro does not need to compete with the foreground game or app,
/// so the whole tree drops to VERY_LOW once it settles. It is not a hard cap:
/// pages only leave when something else actually needs them, and the next
/// interaction puts every process back to NORMAL.
fn set_priority_pid(pid: u32, low: bool) -> bool {
    let priority = if low {
        MEMORY_PRIORITY_VERY_LOW
    } else {
        MEMORY_PRIORITY_NORMAL
    };
    let info = MEMORY_PRIORITY_INFORMATION {
        MemoryPriority: priority,
    };
    let size = std::mem::size_of::<MEMORY_PRIORITY_INFORMATION>() as u32;

    unsafe {
        if pid == std::process::id() {
            return SetProcessInformation(
                GetCurrentProcess(),
                ProcessMemoryPriority,
                &info as *const _ as *const core::ffi::c_void,
                size,
            )
            .is_ok();
        }

        let handle: HANDLE = match OpenProcess(
            PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        ) {
            Ok(h) => h,
            Err(_) => return false,
        };
        let ok = SetProcessInformation(
            handle,
            ProcessMemoryPriority,
            &info as *const _ as *const core::ffi::c_void,
            size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        ok
    }
}

fn set_tree_priority(low: bool) {
    for pid in tree_pids() {
        set_priority_pid(pid, low);
    }
}

fn ram_saver_enabled(app: &tauri::AppHandle) -> bool {
    // On by default: a taskbar replacement should not be the reason a game
    // stutters. Users can turn it off in Settings > General.
    crate::utils::get_setting_str(app, "kiro-ram-saver")
        .map(|v| v != "false")
        .unwrap_or(true)
}

pub fn start_reclaim_worker(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("kiro-mem".into())
        .spawn(move || {
            let mut last_trim = 0i64;

            loop {
                std::thread::sleep(Duration::from_millis(1_000));

                let now = crate::utils::get_now_ms();

                if now.saturating_sub(STARTED_AT_MS.load(Ordering::Relaxed)) < STARTUP_GRACE_MS {
                    continue;
                }

                if !ram_saver_enabled(&app) {
                    continue;
                }

                // A fullscreen game owns the screen: paging our renderers out now
                // would only fight it for disk I/O when the user comes back, so
                // check far less often instead of waking every second.
                if crate::perf::active() {
                    mark_interaction();
                    std::thread::sleep(Duration::from_millis(2_000));
                    continue;
                }

                let busy = BUSY.load(Ordering::Relaxed)
                    || crate::state::MENU_IS_OPEN.load(Ordering::Relaxed)
                    || crate::state::DOCK_IS_DRAGGING.load(Ordering::Relaxed)
                    || crate::state::OVERLAY_IN_SPLASH.load(Ordering::Relaxed);

                if busy {
                    mark_interaction();
                    continue;
                }

                let forced = TRIM_SOON.swap(false, Ordering::Relaxed);
                if !forced && foreground_is_ours() {
                    mark_interaction();
                    continue;
                }

                // Keep the renderers resident while a reveal is likely, otherwise
                // the next hover pays for the whole trim in page faults.
                if !forced && cursor_near_hot_edge() {
                    mark_interaction();
                    continue;
                }

                let since_interaction = now.saturating_sub(LAST_INTERACTION_MS.load(Ordering::Relaxed));
                let idle = since_interaction.min(system_idle_ms());

                if idle < SETTLE_MS {
                    continue;
                }

                let retrim = if crate::state::ANY_MEDIA_PLAYING.load(Ordering::Relaxed) {
                    MEDIA_RETRIM_MS
                } else {
                    RETRIM_MS
                };
                if !forced && now.saturating_sub(last_trim) < retrim {
                    continue;
                }

                last_trim = now;
                let trimmed = trim_tree();
                // Sweep every time: a settings window or a new renderer may
                // have appeared since the last trim and would otherwise keep
                // normal priority forever.
                set_tree_priority(true);
                LOW_PRIORITY.store(true, Ordering::Relaxed);
                crate::diagnostics::log(&format!(
                    "idle reclaim: trimmed {trimmed} processes"
                ));
            }
        })
        .ok();
}
