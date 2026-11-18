//! Linux stand-in for the native uninstall helper.
//!
//! Windows ships a small `--native-uninstall` mode that the NSIS uninstaller
//! calls to drop the registry entry and remove shortcuts. On Linux the package
//! manager owns the files, so the mode does not exist.

#![allow(dead_code)]

pub fn requested() -> bool {
    false
}

pub fn is_elevated() -> bool {
    // Nothing Kiro does on Linux needs root.
    false
}

pub fn run() {}
