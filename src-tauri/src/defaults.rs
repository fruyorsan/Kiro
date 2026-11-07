//! Defaults written on first launch.
//!
//! A fresh install should already look and behave like the maintainer's own
//! Kiro: notch in the bottom-right corner, dock in smart mode, 24-hour clock,
//! frosted theme, the quick-settings panel on the notch. Only keys that are
//! missing are written, so a user who later changes a setting keeps the value
//! they chose. Machine-specific state (monitor ids, weather cache, saved power
//! overlay, ...) is deliberately not part of this list.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::Manager;

fn defaults() -> Vec<(&'static str, Value)> {
    vec![
        // Notch: bottom-right corner, 24-hour clock, quick settings on open.
        ("kiro-notch-position", json!("bottom-right")),
        ("kiro-time-format-24h", json!("true")),
        ("kiro-notch-edge-delay", json!("200")),
        ("kiro-notch-scroll-volume", json!("false")),
        ("kiro-panel-control-center-enabled", json!("true")),
        ("kiro-panel-shelf-enabled", json!("true")),
        ("kiro-panel-order", json!(r#"["command-center","status","music","calendar","shelf"]"#)),
        ("kiro-status-widgets", json!(r#"{"left":["weather","cpu"],"right":["battery","ram"]}"#)),
        ("kiro-shelf-persist", json!("false")),
        // Dock: locked, smart mode, stays on the desktop.
        ("kiro-dock-mode", json!("smart")),
        ("kiro-dock-desktop-persist", json!("true")),
        ("kiro-dock-adaptive", json!("false")),
        ("kiro-dock-icon-only", json!("false")),
        ("kiro-dock-calendar-enabled", json!("false")),
        ("kiro-dock-taskview-enabled", json!("false")),
        ("kiro-dock-show-desktop-corner", json!("true")),
        // Performance: memory saving and the automatic game/fullscreen mode.
        ("kiro-ram-saver", json!("true")),
        ("kiro-ram-ultra", json!("false")),
        ("kiro-auto-perf", json!("true")),
        ("kiro-game-boost", json!("true")),
        // Updates install themselves on the next launch.
        ("kiro-auto-update", json!("true")),
        ("kiro-update-channel", json!("stable")),
        // Appearance: frosted dark, blue accent, same numbers as the maintainer.
        ("kiro-theme-mode", json!("dark")),
        ("kiro-theme-color", json!("#007aff")),
        ("kiro-theme-style", json!("frosted")),
        ("kiro-theme-opacity", json!("0.6")),
        ("kiro-theme-saturation", json!("0.5")),
        ("kiro-theme-brightness", json!("0.15")),
        ("kiro-glass-wallpaper", json!("false")),
        // Media panel layout.
        ("kiro-media-layout", json!("classic")),
    ]
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|p| p.join("settings.json"))
}

/// Add any missing default keys. Returns the keys that were added.
pub fn apply(app: &tauri::AppHandle) -> Vec<&'static str> {
    let Some(path) = settings_path(app) else {
        return Vec::new();
    };

    let mut settings: HashMap<String, Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

    let mut added = Vec::new();
    for (key, value) in defaults() {
        if !settings.contains_key(key) {
            settings.insert(key.to_string(), value);
            added.push(key);
        }
    }

    if !added.is_empty() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(content) = serde_json::to_string(&settings) {
            let _ = std::fs::write(&path, content);
        }
    }

    added
}
