use serde::{Deserialize, Serialize};

#[cfg(kiro_windows)]
#[derive(Deserialize, Debug)]
#[serde(rename = "WmiMonitorBrightness")]
#[serde(rename_all = "PascalCase")]
pub struct WmiMonitorBrightness {
    pub current_brightness: u8,
}

#[cfg(kiro_windows)]
#[derive(Clone, Serialize)]
pub struct AudioVisualizationData {
    pub frequencies: Vec<f32>,
}

#[derive(Serialize, Clone)]
pub struct MediaInfo {
    pub title: String,
    pub artist: String,
    pub is_playing: bool,
    pub has_media: bool,
    pub artwork: Option<Vec<String>>,
    #[serde(default)]
    pub position_ms: i64,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub seek_enabled: bool,
    #[serde(default)]
    pub position_updated_at: u64,
    #[serde(default)]
    pub source_id: String,
}

/// Every action the shared worker/sender API accepts. Not all of them are
/// produced on every platform (Windows owns volume/brightness keys through its
/// keyboard hook; Linux leaves those to the desktop), which is why the unused
/// variants are allowed off Windows.
#[cfg_attr(not(kiro_windows), allow(dead_code))]
pub enum SystemCommand {
    VolumeMute,
    VolumeUp,
    VolumeDown,
    SetVolume(f32),
    MediaPlayPause,
    MediaNext,
    MediaPrevious,
    MediaSeek(i64),
    ToggleVisibility(bool),
    BrightnessUp,
    BrightnessDown,
}

#[derive(Clone, Copy, Deserialize, Debug)]
pub struct IntRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MonitorMode {
    Primary,
    All,
    Specific,
}

impl MonitorMode {
    pub fn from_setting(value: Option<&str>) -> Self {
        match value {
            Some("all") => MonitorMode::All,
            Some("specific") => MonitorMode::Specific,
            _ => MonitorMode::Primary,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WindowKind {
    Dock,
    Notch,
}

#[derive(Clone, Serialize, Debug)]
pub struct MonitorInfo {
    pub id: String,
    pub label: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    pub icon: Option<String>,
    pub is_running: bool,
    pub hwnd: Option<isize>,
    pub executable: Option<String>,
    pub all_hwnds: Option<Vec<(isize, String)>>, // (hwnd, title)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct BrightnessChangeEvent {
    pub brightness: u32,
}

#[derive(Clone, Serialize)]
pub struct WifiStatus {
    pub enabled: bool,
    pub connected: bool,
}

#[derive(Clone, Serialize)]
pub struct VolumeChangeEvent {
    pub volume: f32,
    pub is_muted: bool,
}

#[derive(Clone, Serialize)]
pub struct AudioSessionInfo {
    pub pid: u32,
    pub name: String,
    pub process_path: Option<String>,
    pub volume: f32,
    pub is_muted: bool,
}
