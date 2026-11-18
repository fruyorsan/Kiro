//! Linux stand-in for the Start-menu launcher helpers.
//!
//! `open_search` hands a search provider + shortcut to the Windows shell. Linux
//! desktops differ too much for that to be portable, so it returns `None` and
//! `open_app` falls back to launching the executable directly.

#![allow(dead_code)]

pub fn open_search(_provider: &str, _shortcut: Option<&str>) -> Option<&'static str> {
    None
}

pub fn send_shortcut(_spec: &str) -> bool {
    false
}
