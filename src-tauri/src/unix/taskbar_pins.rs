//! Linux stand-in for importing the Windows taskbar pins.
//!
//! The dock can seed itself from the taskbar on Windows. Linux has no shared
//! pin list across desktop environments, so a fresh profile starts empty (the
//! defaults module adds the usual applications).

#![allow(dead_code)]

use crate::types::AppInfo;

pub fn read_pins() -> Option<Vec<AppInfo>> {
    None
}

pub fn icon_for_target(_target: &str) -> Option<String> {
    None
}
