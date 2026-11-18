//! Linux stand-in for the Windows "auto performance mode".
//!
//! The Windows version flips the power plan and process priority when a game
//! goes fullscreen. Both switches are Windows-only (powercfg + SetPriorityClass
//! with a GUI process), so on Linux the mode is simply always off and the UI
//! hides nothing: it reads `false` and shows the setting as unsupported.

#![allow(dead_code)]

use tauri::AppHandle;

pub const SETTING: &str = "kiro-auto-perf";

/// Whether Kiro is currently holding a performance mode.
pub fn active() -> bool {
    false
}

pub fn state() -> bool {
    false
}

pub fn set_manual_perf(_app: &AppHandle, _enabled: bool) {}

pub fn init(_app: &AppHandle) {}

pub fn update(_app: &AppHandle, _fullscreen: bool, _window_title: &str) {}
