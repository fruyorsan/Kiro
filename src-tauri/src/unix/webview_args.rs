//! WebView runtime arguments.
//!
//! Windows needs a string of Chromium switches for WebView2. On Linux the
//! webview is WebKitGTK, and the one switch that matters is the DMA-BUF
//! renderer: it is the fast path (zero-copy buffers to the compositor), but on
//! graphics stacks where it is broken the result is invisible windows or a
//! black notch.
//!
//! Disabling it unconditionally would make every Linux user pay the software
//! copy path, so it is only disabled when the machine matches a known-broken
//! combination, and never when the user set the variable themselves.

#![allow(dead_code)]

pub fn arguments() -> String {
    String::new()
}

/// True when the graphics stack is known to break WebKitGTK's DMA-BUF
/// renderer: an NVIDIA GPU (proprietary driver) on X11, or a session without a
/// compositor at all.
fn needs_software_rendering() -> bool {
    // Never override an explicit choice from the user, the desktop entry or the
    // distribution's own workaround.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return false;
    }

    // Wayland compositors handle the NVIDIA path these days; X11 with the
    // proprietary driver is the combination that still renders black windows.
    let session = std::env::var("XDG_SESSION_TYPE")
        .unwrap_or_default()
        .to_lowercase();
    if session != "x11" {
        return false;
    }

    // Vendor id 0x10de is NVIDIA in the PCI database.
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        // Only the connector entries (card0, card0-HDMI-A-1, ...) have a
        // device directory; the rest are cheap to skip.
        name.starts_with("card")
            && std::fs::read_to_string(entry.path().join("device/vendor"))
                .map(|vendor| vendor.trim().eq_ignore_ascii_case("0x10de"))
                .unwrap_or(false)
    })
}

pub fn apply() {
    if needs_software_rendering() {
        // Must be set before the first GTK/WebKit call, which is why this runs
        // at the very top of main().
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}
