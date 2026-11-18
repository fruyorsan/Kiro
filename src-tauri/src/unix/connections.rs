//! Linux Wi-Fi / Ethernet / Bluetooth through NetworkManager and BlueZ.
//!
//! Windows talks to WLANAPI, IP Helper and the radio APIs directly. The Linux
//! equivalent that exists on every mainstream desktop is NetworkManager, which
//! ships `nmcli`, plus BlueZ's `bluetoothctl`. Using those keeps this module
//! small and honest: if the tools are missing, the caller gets a clear error
//! and the UI shows "unavailable" instead of pretending.

#![allow(dead_code)]

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct WifiNetwork {
    ssid: String,
    signal: u32,
    secured: bool,
    connected: bool,
    known: bool,
}

#[derive(Serialize)]
pub struct BluetoothDeviceInfo {
    id: String,
    name: String,
    connected: bool,
}

#[derive(Serialize)]
pub struct LanStatus {
    present: bool,
    connected: bool,
    name: String,
}

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program} is not available: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{program} failed")
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// `nmcli -t` output is colon separated with `\:` escaping SSIDs that contain
/// a colon, which is legal in a Wi-Fi name.
fn split_nmcli(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for ch in line.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == ':' {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    fields
}

fn known_connections() -> Vec<String> {
    run("nmcli", &["-t", "-f", "NAME", "connection", "show"])
        .map(|out| out.lines().map(|l| l.to_string()).collect())
        .unwrap_or_default()
}

fn active_ssid() -> Option<String> {
    let out = run("nmcli", &["-t", "-f", "ACTIVE,SSID", "device", "wifi"]).ok()?;
    out.lines().find_map(|line| {
        let fields = split_nmcli(line);
        if fields.first().map(|f| f.as_str()) == Some("yes") {
            fields.get(1).cloned()
        } else {
            None
        }
    })
}

#[tauri::command]
pub async fn wifi_scan() -> Result<Vec<WifiNetwork>, String> {
    let out = run(
        "nmcli",
        &["-t", "-f", "SSID,SIGNAL,SECURITY,IN-USE", "device", "wifi", "list", "--rescan", "yes"],
    )?;
    let known = known_connections();
    let active = active_ssid();
    let mut networks: Vec<WifiNetwork> = Vec::new();
    for line in out.lines() {
        let fields = split_nmcli(line);
        if fields.len() < 4 {
            continue;
        }
        let ssid = fields[0].trim().to_string();
        if ssid.is_empty() {
            continue;
        }
        if networks.iter().any(|n| n.ssid == ssid) {
            continue;
        }
        let signal = fields[1].trim().parse::<u32>().unwrap_or(0);
        let security = fields[2].trim();
        let in_use = fields[3].trim() == "*";
        networks.push(WifiNetwork {
            connected: in_use || active.as_deref() == Some(ssid.as_str()),
            secured: !security.is_empty() && security != "--",
            known: known.iter().any(|k| k == &ssid),
            ssid,
            signal,
        });
    }
    networks.sort_by(|a, b| b.signal.cmp(&a.signal));
    Ok(networks)
}

#[tauri::command]
pub async fn wifi_connect(ssid: String, password: Option<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["device", "wifi", "connect", &ssid];
    if let Some(password) = password.as_deref().filter(|p| !p.is_empty()) {
        args.extend_from_slice(&["password", password]);
    }
    run("nmcli", &args).map(|_| ())
}

#[tauri::command]
pub async fn wifi_disconnect() -> Result<(), String> {
    // NetworkManager has no "disconnect the current Wi-Fi" verb that works on
    // every version, so turn the radio off and on again for the active device.
    let out = run("nmcli", &["-t", "-f", "DEVICE,TYPE,STATE", "device"])?;
    for line in out.lines() {
        let fields = split_nmcli(line);
        if fields.len() >= 3 && fields[1] == "wifi" && fields[2] == "connected" {
            return run("nmcli", &["device", "disconnect", &fields[0]]).map(|_| ());
        }
    }
    Err("No connected Wi-Fi device".into())
}

#[tauri::command]
pub async fn wifi_forget(ssid: String) -> Result<(), String> {
    run("nmcli", &["connection", "delete", "id", &ssid]).map(|_| ())
}

#[tauri::command]
pub async fn get_lan_status() -> LanStatus {
    // /sys/class/net/<iface>/type == 1 is ARPHRD_ETHER; Wi-Fi is 1 too on some
    // drivers, so also require that there is no wireless directory.
    let mut fallback: Option<LanStatus> = None;
    let Ok(entries) = std::fs::read_dir("/sys/class/net") else {
        return LanStatus { present: false, connected: false, name: String::new() };
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "lo" {
            continue;
        }
        let base = entry.path();
        if base.join("wireless").exists() || base.join("phy80211").exists() {
            continue;
        }
        let state = std::fs::read_to_string(base.join("operstate"))
            .unwrap_or_default()
            .trim()
            .to_string();
        let status = LanStatus {
            present: true,
            connected: state == "up",
            name,
        };
        if status.connected {
            return status;
        }
        fallback.get_or_insert(status);
    }
    fallback.unwrap_or(LanStatus { present: false, connected: false, name: String::new() })
}

#[tauri::command]
pub fn open_ethernet_settings() {
    // Network settings are desktop specific; the main settings window is the
    // closest portable target and is opened by the frontend already.
}

#[tauri::command]
pub async fn bluetooth_devices() -> Result<Vec<BluetoothDeviceInfo>, String> {
    let out = run("bluetoothctl", &["devices"])?;
    let mut devices = Vec::new();
    for line in out.lines() {
        // "Device AA:BB:CC:DD:EE:FF Name"
        let Some(rest) = line.strip_prefix("Device ") else { continue };
        let Some((id, name)) = rest.split_once(' ') else { continue };
        let connected = run("bluetoothctl", &["info", id])
            .map(|info| info.lines().any(|l| l.trim() == "Connected: yes"))
            .unwrap_or(false);
        devices.push(BluetoothDeviceInfo {
            id: id.to_string(),
            name: name.to_string(),
            connected,
        });
    }
    Ok(devices)
}

#[tauri::command]
pub async fn bluetooth_unpair(id: String) -> Result<(), String> {
    run("bluetoothctl", &["remove", &id]).map(|_| ())
}
