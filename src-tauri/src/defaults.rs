//! Defaults written on first launch.
//!
//! A fresh install should behave like a taskbar replacement out of the box:
//! the dock stays on the desktop, the quick-settings panel opens with the
//! notch, and the memory/performance saving is already on. Only keys that are
//! missing are written, so a user who later changes a setting keeps the value
//! they chose.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::Manager;

fn defaults() -> Vec<(&'static str, Value)> {
    vec![
        // Dock: never hide just because the desktop is focused.
        ("nectar-dock-desktop-persist", json!(true)),
        // A fresh install gets a locked taskbar, like the Windows one. Anyone
        // who wants the auto-hiding behaviour picks it in Settings > Dock.
        ("nectar-dock-mode", json!("smart")),
        // Smart mode hides the dock when a window covers it and brings it back
        // on the desktop. The desktop persist switch below keeps it parked there.
        ("nectar-dock-adaptive", json!(false)),
        // Quick settings (Wi-Fi / Bluetooth / volume / brightness) is the
        // panel the notch opens with.
        ("nectar-panel-control-center-enabled", json!(true)),
        ("nectar-panel-order", json!(r#"["command-center","status","music","calendar","shelf"]"#)),
        // Keep memory and CPU use low without any setup.
        ("nectar-ram-saver", json!(true)),
        ("nectar-auto-perf", json!(true)),
        ("nectar-notch-position", json!("top")),
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
