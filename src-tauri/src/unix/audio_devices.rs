//! Linux audio output devices through PulseAudio/PipeWire (`pactl`).
//!
//! Windows enumerates IMMDevice endpoints through Core Audio. On Linux the
//! portable way is `pactl`, which exists on both PulseAudio and PipeWire
//! installs, so switching the default sink works the same on either.

#![allow(dead_code)]

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct AudioDevice {
    id: String,
    name: String,
    is_default: bool,
}

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program} is not available: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn default_sink() -> Option<String> {
    run("pactl", &["get-default-sink"]).ok().map(|s| s.trim().to_string())
}

#[tauri::command]
pub async fn get_audio_devices() -> Result<Vec<AudioDevice>, String> {
    let out = run("pactl", &["list", "short", "sinks"])?;
    let default = default_sink();
    let mut devices = Vec::new();
    for line in out.lines() {
        // index\tname\tdriver\tspec\tstate
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 2 {
            continue;
        }
        let name = fields[1].to_string();
        devices.push(AudioDevice {
            is_default: default.as_deref() == Some(name.as_str()),
            id: name.clone(),
            name,
        });
    }
    Ok(devices)
}

#[tauri::command]
pub async fn set_default_audio_device(id: String) -> Result<(), String> {
    run("pactl", &["set-default-sink", &id]).map(|_| ())
}
