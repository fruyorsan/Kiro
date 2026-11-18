//! Linux stand-in for the "keep this window active" Windows tweaks.
//!
//! Windows needs `WS_EX_NOACTIVATE` and a few foreground-window tricks so the
//! notch never steals focus. On Linux this is handled by the window hints Tauri
//! already applies (`focus: false`, `skipTaskbar`), so nothing extra is needed.

#![allow(dead_code)]

pub fn keep_active_look(_hwnd: isize) {}

pub fn prevent_minimize(_hwnd: isize) {}
