//! Linux wallpaper backdrop.
//!
//! The Windows version samples the actual desktop wallpaper behind the notch
//! and blurs it so the notch glass matches the desktop. Reading the wallpaper
//! on Linux means knowing which desktop environment drew it (GNOME, KDE, Sway,
//! …) and Wayland does not expose the composited result at all, so the notch
//! falls back to its own translucent surface.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use tauri::Window;

#[derive(Serialize)]
pub struct WallpaperBackdrop {
    image: String,
    image_width: u32,
    image_height: u32,
    fit: String,
    monitor_width: f64,
    monitor_height: f64,
    monitor_scale: f64,
    window_x: f64,
    window_y: f64,
}

#[derive(Deserialize)]
pub struct SurfaceRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[tauri::command]
pub async fn get_wallpaper_backdrop(
    _window: Window,
    _blur: u32,
) -> Result<Option<WallpaperBackdrop>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn is_backdrop_covered(_window: Window, _rect: SurfaceRect) -> bool {
    false
}
