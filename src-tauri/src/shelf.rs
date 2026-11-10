//! OS drop target for the notch (files and text), adapted from Bloom by Sehajveer Singh (GPLv3).
//! WebView2 recreates its render child after the window is built, so the target is registered again after first paint.

use std::cell::UnsafeCell;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, Ref, BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{
    CoInitializeEx, IDataObject, COINIT_APARTMENTTHREADED, DVASPECT_CONTENT, FORMATETC,
    TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP,
    CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragFinish, DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;
const MAX_TEXT_UNITS: usize = 1 << 17;
struct TargetStore(#[allow(dead_code)] Vec<IDropTarget>);
unsafe impl Send for TargetStore {}

static SHELF_DROP_TARGETS: Mutex<Option<TargetStore>> = Mutex::new(None);
enum DragPayload {
    Files(Vec<String>, HDROP),
    Text(String),
    /// A picture dragged out of a browser (Pinterest, Google Images, ...).
    /// Browsers never hand these over as files: the only useful data is an
    /// <img src> inside `HTML Format` or a bare image URL in the text formats.
    Image { url: String, name: String },
}

/// Builds a data URI from a remote image so the shelf can render it. The webview
/// CSP only allows `data:`/`blob:` images, and a remote URL would also break as
/// soon as the page changes.
async fn download_image_data_uri(url: &str) -> Option<String> {
    const MAX_BYTES: usize = 12 * 1024 * 1024;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let response = client
        .get(url)
        .header("accept", "image/avif,image/webp,image/png,image/jpeg,image/*")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    if response.content_length().unwrap_or(0) as usize > MAX_BYTES {
        return None;
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .trim()
        .to_string();
    if !mime.starts_with("image/") {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, b64))
}

/// A bare URL that points at an image file. Pinterest, Google Images and most
/// galleries drag a CDN link ending in `.jpg`/`.png` (sometimes with a query).
fn looks_like_image_url(text: &str) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }
    let without_query = lower.split('?').next().unwrap_or(&lower);
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"]
        .iter()
        .any(|ext| without_query.ends_with(ext))
}

/// Pulls the first `<img src="...">` (and its alt text) out of an HTML payload.
fn first_image_from_html(html: &str) -> Option<(String, String)> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(index) = lower[from..].find("<img") {
        let start = from + index;
        let tag_end = lower[start..].find('>').map(|offset| start + offset)?;
        let tag = &html[start..tag_end];
        let attr = |name: &str| -> Option<String> {
            let lower_tag = tag.to_ascii_lowercase();
            let key = format!("{}=", name);
            let at = lower_tag.find(&key)? + key.len();
            let rest = &tag[at..];
            let quote = rest.chars().next()?;
            if quote == '"' || quote == '\'' {
                let value = &rest[1..];
                let end = value.find(quote)?;
                Some(value[..end].to_string())
            } else {
                Some(rest.split_whitespace().next()?.to_string())
            }
        };
        if let Some(src) = attr("src") {
            let url = src.trim().to_string();
            if url.starts_with("http://") || url.starts_with("https://") {
                let name = attr("alt").unwrap_or_default();
                return Some((url, name.trim().to_string()));
            }
        }
        from = tag_end;
    }
    None
}


#[implement(IDropTarget)]
struct ShelfDropTarget {
    app: AppHandle,
    hwnd: HWND,
    label: String,
    enter_valid: UnsafeCell<bool>,
    cursor_effect: UnsafeCell<DROPEFFECT>,
}

impl ShelfDropTarget {
    unsafe fn extract(data: &IDataObject) -> Option<DragPayload> {
        if let Some((paths, hdrop)) = unsafe { Self::extract_files(data) } {
            return Some(DragPayload::Files(paths, hdrop));
        }
        // Browsers expose an image drag in three shapes. HTML is the richest
        // (it has alt text), the URI list is the cleanest, and the plain text
        // is whatever the page put there - often just the CDN link.
        if let Some(html) = unsafe { Self::extract_named(data, "HTML Format") } {
            if let Some((url, name)) = first_image_from_html(&html) {
                return Some(DragPayload::Image { url, name });
            }
        }
        if let Some(list) = unsafe { Self::extract_named(data, "text/uri-list") } {
            if let Some(url) = list
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with('#'))
            {
                if looks_like_image_url(url) {
                    return Some(DragPayload::Image {
                        url: url.to_string(),
                        name: String::new(),
                    });
                }
            }
        }
        let text = unsafe { Self::extract_text(data) }?;
        if looks_like_image_url(&text) {
            return Some(DragPayload::Image { url: text, name: String::new() });
        }
        Some(DragPayload::Text(text))
    }

    /// Reads a clipboard format registered by name (HTML Format, text/uri-list).
    unsafe fn extract_named(data: &IDataObject, name: &str) -> Option<String> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let id = unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) };
        if id == 0 {
            return None;
        }
        let format = FORMATETC {
            cfFormat: id as u16,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let mut medium = data.GetData(&format).ok()?;
        let text = unsafe { Self::medium_to_string(&mut medium) };
        unsafe { ReleaseStgMedium(&mut medium) };
        text
    }

    unsafe fn medium_to_string(medium: &mut windows::Win32::System::Com::STGMEDIUM) -> Option<String> {
        let ptr = unsafe { GlobalLock(medium.u.hGlobal) } as *const u8;
        if ptr.is_null() {
            return None;
        }
        let size = (unsafe { GlobalSize(medium.u.hGlobal) } as usize).min(MAX_TEXT_UNITS * 2);
        let bytes = unsafe { std::slice::from_raw_parts(ptr, size) };
        let text = if bytes.len() >= 2 && bytes[1] == 0 {
            // UTF-16 payload.
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .take_while(|unit| *unit != 0)
                .collect();
            String::from_utf16_lossy(&units)
        } else {
            // UTF-8/ASCII payload with an optional BOM.
            let body = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { bytes };
            String::from_utf8_lossy(body)
                .split('\0')
                .next()
                .unwrap_or("")
                .to_string()
        };
        let _ = unsafe { GlobalUnlock(medium.u.hGlobal) };
        if text.trim().is_empty() { None } else { Some(text) }
    }

    unsafe fn extract_files(data: &IDataObject) -> Option<(Vec<String>, HDROP)> {
        let format = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let medium = data.GetData(&format).ok()?;
        let hdrop = HDROP(medium.u.hGlobal.0 as _);
        let count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);
        if count == 0 {
            unsafe { DragFinish(hdrop) };
            return None;
        }
        let mut paths = Vec::with_capacity(count as usize);
        for i in 0..count {
            let len = DragQueryFileW(hdrop, i, None) as usize;
            let mut buf = vec![0u16; len + 1];
            DragQueryFileW(hdrop, i, Some(&mut buf));
            paths.push(String::from_utf16_lossy(&buf[..len]));
        }
        Some((paths, hdrop))
    }
    unsafe fn extract_text(data: &IDataObject) -> Option<String> {
        let format = FORMATETC {
            cfFormat: CF_UNICODETEXT.0,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let mut medium = data.GetData(&format).ok()?;
        let ptr = GlobalLock(medium.u.hGlobal) as *const u16;
        if ptr.is_null() {
            ReleaseStgMedium(&mut medium);
            return None;
        }
        let alloc_units = (GlobalSize(medium.u.hGlobal) / 2) as usize;
        let max_units = alloc_units.min(MAX_TEXT_UNITS);
        let mut len = 0usize;
        while len < max_units && *ptr.add(len) != 0 {
            len += 1;
        }
        let text = if len >= MAX_TEXT_UNITS || len >= max_units {
            None
        } else {
            Some(String::from_utf16_lossy(std::slice::from_raw_parts(
                ptr, len,
            )))
        };
        let _ = GlobalUnlock(medium.u.hGlobal);
        ReleaseStgMedium(&mut medium);

        match text {
            Some(t) if !t.trim().is_empty() => Some(t),
            _ => None,
        }
    }

    unsafe fn client_point(&self, pt: &POINTL) -> POINT {
        let mut point = POINT { x: pt.x, y: pt.y };
        let _ = ScreenToClient(self.hwnd, &mut point);
        point
    }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for ShelfDropTarget_Impl {
    fn DragEnter(
        &self,
        pdata: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let payload = pdata
            .as_ref()
            .and_then(|data| unsafe { ShelfDropTarget::extract(data) });
        let Some(payload) = payload else {
            unsafe {
                *self.enter_valid.get() = false;
                *self.cursor_effect.get() = DROPEFFECT_NONE;
                *effect = DROPEFFECT_NONE;
            }
            return Ok(());
        };

        unsafe {
            *self.enter_valid.get() = true;
            *self.cursor_effect.get() = DROPEFFECT_COPY;
            *effect = DROPEFFECT_COPY;
        }

        let point = unsafe { self.client_point(pt) };
        match payload {
            DragPayload::Files(paths, hdrop) => {
                let _ = self.app.emit(
                    "shelf-drag-enter",
                    serde_json::json!({ "label": self.label, "paths": paths, "position": { "x": point.x, "y": point.y } }),
                );
                unsafe { DragFinish(hdrop) };
            }
            DragPayload::Text(text) => {
                let _ = self.app.emit(
                    "shelf-drag-enter",
                    serde_json::json!({ "label": self.label, "text": text, "position": { "x": point.x, "y": point.y } }),
                );
            }
            DragPayload::Image { url, name } => {
                let _ = self.app.emit(
                    "shelf-drag-enter",
                    serde_json::json!({
                        "label": self.label,
                        "text": url,
                        "name": name,
                        "position": { "x": point.x, "y": point.y }
                    }),
                );
            }
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        unsafe { *effect = *self.cursor_effect.get() };
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if unsafe { *self.enter_valid.get() } {
            unsafe { *self.enter_valid.get() = false };
            let _ = self.app.emit("shelf-drag-leave", serde_json::json!({ "label": self.label }));
        }
        Ok(())
    }

    fn Drop(
        &self,
        pdata: Ref<'_, IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        _effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if unsafe { *self.enter_valid.get() } {
            unsafe { *self.enter_valid.get() = false };
            let payload = pdata
                .as_ref()
                .and_then(|data| unsafe { ShelfDropTarget::extract(data) });
            match payload {
                Some(DragPayload::Files(paths, hdrop)) => {
                    let _ = self
                        .app
                        .emit("shelf-drag-drop", serde_json::json!({ "label": self.label, "paths": paths }));
                    unsafe { DragFinish(hdrop) };
                }
                Some(DragPayload::Text(text)) => {
                    let _ = self
                        .app
                        .emit("shelf-drag-drop", serde_json::json!({ "label": self.label, "text": text }));
                }
                Some(DragPayload::Image { url, name }) => {
                    // The webview cannot load remote images (CSP allows data:
                    // only), so fetch the picture here and hand over a data
                    // URI. The link is kept as text so it can still be copied
                    // when the download fails.
                    let app = self.app.clone();
                    let label = self.label.clone();
                    tauri::async_runtime::spawn(async move {
                        let image = download_image_data_uri(&url).await;
                        let _ = app.emit(
                            "shelf-drag-drop",
                            serde_json::json!({
                                "label": label,
                                "text": url,
                                "name": name,
                                "image": image,
                            }),
                        );
                    });
                }
                None => {}
            }
        }
        Ok(())
    }
}
pub fn setup(app: &AppHandle) {
    struct Ctx {
        app: AppHandle,
        label: String,
        targets: Vec<IDropTarget>,
    }

    unsafe extern "system" fn child_proc(child: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        unsafe { inject(child, &ctx.app, &ctx.label, &mut ctx.targets) };
        BOOL(1)
    }

    let mut all_targets: Vec<IDropTarget> = Vec::new();
    for (label, win) in app.webview_windows() {
        if !crate::state::is_notch_label(&label) {
            continue;
        }
        let Ok(hwnd) = win.hwnd() else { continue };
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let mut ctx = Ctx { app: app.clone(), label, targets: Vec::new() };
            inject(hwnd, app, &ctx.label, &mut ctx.targets);
            let _ = EnumChildWindows(Some(hwnd), Some(child_proc), LPARAM(&mut ctx as *mut Ctx as isize));
            all_targets.append(&mut ctx.targets);
        }
    }
    if let Ok(mut guard) = SHELF_DROP_TARGETS.lock() {
        *guard = Some(TargetStore(all_targets));
    }
}

unsafe fn inject(hwnd: HWND, app: &AppHandle, label: &str, out: &mut Vec<IDropTarget>) {
    let target: IDropTarget = ShelfDropTarget {
        app: app.clone(),
        hwnd,
        label: label.to_string(),
        enter_valid: UnsafeCell::new(false),
        cursor_effect: UnsafeCell::new(DROPEFFECT_NONE),
    }
    .into();
    let _ = unsafe { RevokeDragDrop(hwnd) };
    if unsafe { RegisterDragDrop(hwnd, &target) }.is_ok() {
        out.push(target);
    }
}
