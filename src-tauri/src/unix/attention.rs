//! Linux stand-in for the Windows "application needs attention" tracker.
//!
//! Windows reports `FLASHWINFO` requests, which is how the notch highlights an
//! app that is asking for the user. There is no portable equivalent (Wayland
//! has an `xdg_activation` protocol but no "wants attention" signal), so the
//! list stays empty and the notch simply never shows those highlights.

#![allow(dead_code)]

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub fn get_attention_windows() -> Vec<isize> {
    Vec::new()
}
