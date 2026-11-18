//! Linux stand-in for the shelf drag-and-drop surface.
//!
//! The Windows shelf takes files through OLE `IDropTarget` on the notch window
//! and asks the shell for thumbnails. Tauri's webview delivers HTML5 drops on
//! Linux instead, so the native setup hook is not needed; the frontend keeps
//! using the same commands and simply gets no shell thumbnail.

#![allow(dead_code)]

use tauri::AppHandle;

pub fn setup(_app: &AppHandle) {}
