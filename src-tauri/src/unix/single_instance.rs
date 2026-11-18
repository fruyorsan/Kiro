//! Single-instance handling for Linux.
//!
//! Windows uses a named mutex plus a named event: the second launch opens the
//! event and the first instance's waiter thread shows the settings window. A
//! named mutex has no Linux equivalent, so this uses a lock file holding the
//! owner PID, with the same behaviour:
//!
//! * if the file names a live process, a second Kiro exits immediately and
//!   leaves a request file behind;
//! * the running instance polls that request file and opens settings.
//!
//! A stale lock (owner died) is detected through `/proc` and taken over, so a
//! crash never leaves Kiro unlaunchable.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

/// Where the lock and the "open settings" request live. `XDG_RUNTIME_DIR` is a
/// per-user, per-boot directory, which is exactly the lifetime we want.
pub fn runtime_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("kiro");
    }
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join(".cache").join("kiro")
}

fn lock_path() -> PathBuf {
    runtime_dir().join("instance.lock")
}

/// Releases the lock explicitly. Only needed before an in-process restart: the
/// new binary starts while this process is still alive, so it must not find a
/// lock naming a live PID.
pub fn release() {
    let _ = std::fs::remove_file(lock_path());
}

fn request_path() -> PathBuf {
    runtime_dir().join("open-settings.request")
}

pub enum Acquired {
    Primary,
    AlreadyRunning,
}

fn process_alive(pid: u32) -> bool {
    // PID 1 is always there and a 0/absent PID means the file was truncated
    // mid-write, so treat both as "not a running Kiro".
    pid > 1 && std::path::Path::new(&format!("/proc/{pid}")).exists()
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        if self.owned {
            let _ = std::fs::remove_file(lock_path());
        }
    }
}

/// Kept alive for the whole process; dropping it (or exiting cleanly) releases
/// the lock so the next launch becomes the primary instance.
pub struct InstanceLock {
    owned: bool,
}

pub fn acquire() -> (Acquired, Option<InstanceLock>) {
    let dir = runtime_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = lock_path();

    for _ in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                let _ = write!(file, "{}", std::process::id());
                return (
                    Acquired::Primary,
                    Some(InstanceLock { owned: true }),
                );
            }
            Err(_) => {
                let owner = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| text.trim().parse::<u32>().ok());
                match owner {
                    Some(pid) if process_alive(pid) && pid != std::process::id() => {
                        // Another Kiro is running: ask it to show settings.
                        let _ = std::fs::create_dir_all(&dir);
                        let _ = std::fs::write(request_path(), b"1");
                        return (Acquired::AlreadyRunning, None);
                    }
                    _ => {
                        // Stale lock from a crashed session; take it over.
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }

    // Could not create the file (read-only runtime dir): continue as primary
    // rather than refusing to start.
    (Acquired::Primary, None)
}

/// Polls the request file and opens the settings window, mirroring the Windows
/// waiter thread on the second-instance event.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        static PENDING: AtomicBool = AtomicBool::new(false);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !request_path().exists() {
                PENDING.store(false, Ordering::Relaxed);
                continue;
            }
            let _ = std::fs::remove_file(request_path());
            if PENDING.swap(true, Ordering::Relaxed) {
                continue;
            }
            crate::commands::open_settings_window(app.clone());
            PENDING.store(false, Ordering::Relaxed);
        }
    });
}
