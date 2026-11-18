//! Linux stand-in for the Windows game-boost heuristics.
//!
//! Windows decides whether a fullscreen window is a game by inspecting its
//! executable and monitor. On Linux there is nothing to steer (no per-monitor
//! GPU affinity switch), so this is a no-op.

#![allow(dead_code)]

use tauri::AppHandle;

pub const SETTING: &str = "kiro-game-boost";

pub fn update(_app: &AppHandle, _fullscreen: bool, _game_monitor: Option<(i32, i32)>) {}
