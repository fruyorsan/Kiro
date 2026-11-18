//! Linux stand-in for the Windows uninstall registration.
//!
//! `.deb` and `.AppImage` installs are registered by the package manager and
//! the desktop entry, so there is no registry hive to heal and no install scope
//! to read back from it.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

pub const UNINSTALL_SUBKEY: &str = "";

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn start_menu_programs_dir(_all_users: bool) -> Option<PathBuf> {
    None
}

pub fn legacy_start_menu_dir(_all_users: bool) -> Option<PathBuf> {
    None
}

pub fn desktop_dir(all_users: bool) -> Option<PathBuf> {
    if all_users {
        // A system-wide desktop directory is not a real concept here; the
        // package's own .desktop entry lives in /usr/share/applications.
        return Some(PathBuf::from("/usr/share/applications"));
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Desktop"))
}

/// `None` means "not a Windows install", which is exactly what the updater's
/// NSIS-scope logic needs to decide it has nothing to do.
pub fn install_scope(_install_dir: &Path) -> Option<bool> {
    None
}

pub fn heal_uninstall_registration() {}
