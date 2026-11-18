//! Linux stand-in for FPS Boost.
//!
//! Everything FPS Boost does on Windows is registry and GPU-driver work:
//! per-game GPU preference keys, power throttling, toast suppression, refresh
//! rate discovery through DXGI and RAM stick layout through SMBIOS. None of it
//! has a Linux equivalent, so the commands stay registered (the UI can keep
//! rendering) and report an empty, inactive state plus a clear error when the
//! user tries to apply a profile.

#![allow(dead_code)]

use serde::Serialize;
use tauri::AppHandle;

pub const SETTING: &str = "kiro-fps-boost";

#[derive(Serialize, Clone, Default)]
pub struct BoostState {
    pub active: bool,
    pub exe: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct ProfileInfo {
    pub exe: String,
    pub name: String,
    pub applied: bool,
    pub seen: u32,
}

#[derive(Serialize, Clone)]
pub struct Finding {
    /// "good" | "warn" | "bad" | "info"
    pub level: String,
    pub title: String,
    pub detail: String,
    pub gain: String,
}

#[derive(Serialize, Clone, Default)]
pub struct GpuAudit {
    pub name: String,
    pub driver: String,
    pub power_limit: Option<f64>,
    pub power_max: Option<f64>,
    pub display_active: Option<bool>,
    pub utilization: Option<f64>,
}

#[derive(Serialize, Clone, Default)]
pub struct AuditReport {
    pub gpus: Vec<GpuAudit>,
    pub refresh_hz: u32,
    pub ram_total_mb: u64,
    pub ram_modules: Vec<String>,
    pub ram_asymmetric: bool,
    pub hags: bool,
    pub game_drive: Option<String>,
    pub findings: Vec<Finding>,
}

pub fn perf_boostable(_hwnd: isize) -> bool {
    false
}

pub fn init(_app: &AppHandle) {}

pub fn shutdown(_app: &AppHandle) {}

pub fn update(_app: &AppHandle, _fullscreen: bool, _hwnd: isize) {}

pub fn state() -> BoostState {
    BoostState::default()
}

#[tauri::command]
pub fn fps_boost_state() -> BoostState {
    BoostState::default()
}

#[tauri::command]
pub fn fps_boost_profiles(_app: AppHandle) -> Vec<ProfileInfo> {
    Vec::new()
}

#[tauri::command]
pub fn fps_boost_apply_profile(_app: AppHandle, _exe: String) -> Result<(), String> {
    Err("FPS Boost is a Windows feature".into())
}

#[tauri::command]
pub fn fps_boost_remove_profile(_app: AppHandle, _exe: String) -> Result<(), String> {
    Err("FPS Boost is a Windows feature".into())
}

#[tauri::command]
pub fn fps_boost_restore_all(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn fps_boost_system_tweaks_active() -> bool {
    false
}

#[tauri::command]
pub fn fps_boost_set_system_tweaks(_app: AppHandle, _enabled: bool) -> Result<bool, String> {
    Err("FPS Boost is a Windows feature".into())
}

#[tauri::command]
pub async fn fps_boost_audit(_exe: Option<String>) -> Result<AuditReport, String> {
    Err("FPS Boost audit is a Windows feature".into())
}
