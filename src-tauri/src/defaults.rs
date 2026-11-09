//! Defaults written on first launch.
//!
//! A fresh install should already look and behave like the maintainer's own
//! Kiro: notch at the top edge, dock in smart mode, 24-hour clock,
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
        // Notch: top edge, 24-hour clock, quick settings on open.
        ("kiro-notch-position", json!("top")),
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
        // Opt-in GPU-off mode: ~140-170 MB less private memory, but blur and
        // animations are rendered on the CPU and a restart is required.
        ("kiro-ram-ultra", json!("false")),
        ("kiro-auto-perf", json!("true")),
        ("kiro-game-boost", json!("true")),
        ("kiro-fps-boost", json!("true")),
        // Updates install themselves on the next launch.
        ("kiro-auto-update", json!("true")),
        ("kiro-update-channel", json!("stable")),
        // Appearance: liquid glass on a dark surface with a monochrome (white)
        // accent, so a fresh install lands on the branded look instead of a
        // blue frosted panel.
        ("kiro-theme-mode", json!("dark")),
        ("kiro-theme-color", json!("#007aff")),
        ("kiro-theme-style", json!("liquid")),
        ("kiro-theme-accent", json!("mono")),
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

    let mut settings: HashMap<String, Value> = crate::utils::read_settings_map(&path)
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
        // Same temp-file swap `save_setting` uses: the watcher and every window
        // read this file right after startup, and a plain write can expose a
        // half-written document (or truncate everything if the process dies).
        if let Ok(content) = serde_json::to_string(&settings) {
            let temp = path.with_extension("json.tmp");
            if std::fs::write(&temp, &content).is_ok() && std::fs::rename(&temp, &path).is_err() {
                let _ = std::fs::remove_file(&temp);
            }
        }
    }

    added
}
