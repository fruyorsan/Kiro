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
    prefer_x11_backend();
}

/// Kiro is built out of windows placed at absolute screen coordinates (the
/// notch is pinned to the top edge, the dock to the bottom). Wayland gives
/// clients no way to place themselves, so on a Wayland session the notch and
/// the dock end up wherever the compositor drops them — the app looks broken
/// rather than merely misplaced, which is what several distributions reported.
///
/// Running through XWayland restores real positioning and also makes the dock's
/// window list work. It is only chosen when an X server is actually reachable
/// (`DISPLAY` set); a Wayland-only session keeps the native backend instead of
/// refusing to start, and `KIRO_ALLOW_WAYLAND=1` opts out for testing.
fn prefer_x11_backend() {
    if std::env::var_os("GDK_BACKEND").is_some() || std::env::var_os("KIRO_ALLOW_WAYLAND").is_some() {
        return;
    }
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    let wayland = session == "wayland" || std::env::var_os("WAYLAND_DISPLAY").is_some();
    if wayland && std::env::var_os("DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}
