//! Linux stand-in for the Windows tray/notification-area integration.
//!
//! On Windows Kiro mirrors the notification area so the dock can show every
//! tray icon. Linux has no such contract: extra indicator icons are published
//! over StatusNotifier, which is a different feature. The dock therefore hides
//! its tray button on Linux and these entry points do nothing.

#![allow(dead_code)]

pub fn warm_up() {}

pub fn open_native_tray(_anchor: Option<(i32, i32)>) {}

pub fn schedule_taskbar_layout_refresh() {}
