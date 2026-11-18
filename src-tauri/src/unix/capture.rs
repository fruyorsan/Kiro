//! Linux stand-in for window thumbnail capture.
//!
//! The Windows implementation grabs the DWM surface of a window through DXGI.
//! Wayland forbids reading another client's buffer, and X11 capture needs a
//! compositor-specific path, so the dock shows the app icon instead of a live
//! thumbnail. Callers already treat `None` as "no thumbnail".

#![allow(dead_code)]

pub fn capture_window_bgra(_hwnd: isize) -> Option<(Vec<u8>, u32, u32)> {
    None
}
