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
    init_x11_threads();
    if needs_software_rendering() {
        // Must be set before the first GTK/WebKit call, which is why this runs
        // at the very top of main().
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    prefer_x11_backend();
}

/// GTK is single-threaded, but Kiro asks the display about monitors and the
/// pointer from worker threads (the dock's monitor sync, the notch's hover
/// check). Those calls go through Xlib's display connection, and without
/// XInitThreads two threads dequeuing at once aborts the whole process with
/// "Unknown request in queue while dequeuing / XInitThreads has not been
/// called". It has to run before the first display connection is opened, i.e.
/// before GTK starts.
fn init_x11_threads() {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("DISPLAY").is_none() {
            return;
        }
        if let Ok(xlib) = x11_dl::xlib::Xlib::open() {
            unsafe {
                (xlib.XInitThreads)();
            }
        }
    }
}

/// Kiro is built out of windows placed at absolute screen coordinates (the
/// notch is pinned to the top edge, the dock to the bottom). Wayland gives
/// clients no way to place themselves, so on a Wayland session the notch and
/// the dock end up wherever the compositor drops them — the app looks broken
/// rather than merely misplaced, which is what several distributions reported.
///
/// Running through XWayland restores real positioning and also makes the dock's
/// window list work. It is only chosen when an X server actually answers:
/// `DISPLAY` being set is not enough, because a broken XWayland leaves the
/// variable behind and forcing the x11 backend then makes GTK fail to
/// initialise, i.e. the app exits before showing a window. A Wayland-only
/// session keeps the native backend instead of refusing to start, and
/// `KIRO_ALLOW_WAYLAND=1` opts out for testing.
fn prefer_x11_backend() {
    if std::env::var_os("GDK_BACKEND").is_some() || std::env::var_os("KIRO_ALLOW_WAYLAND").is_some() {
        return;
    }
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    let wayland = session == "wayland" || std::env::var_os("WAYLAND_DISPLAY").is_some();
    if wayland && x_server_reachable() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

/// Opens and closes an X display exactly the way GTK would, without keeping it:
/// if this fails, forcing `GDK_BACKEND=x11` would only produce a fatal
/// "Failed to initialize gtk backend" a moment later.
fn x_server_reachable() -> bool {
    if std::env::var_os("DISPLAY").is_none() {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        match x11_dl::xlib::Xlib::open() {
            Ok(xlib) => unsafe {
                let display = (xlib.XOpenDisplay)(std::ptr::null());
                if display.is_null() {
                    false
                } else {
                    (xlib.XCloseDisplay)(display);
                    true
                }
            },
            Err(_) => false,
        }
    }
    // The x11-dl dependency only exists for Linux; the cross-platform
    // `KIRO_FORCE_UNIX` type check on Windows cannot open a display either way.
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}
