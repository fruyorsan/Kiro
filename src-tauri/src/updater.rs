use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{UpdaterBuilder, UpdaterExt};

/// Minimum time between background update checks. Manual checks bypass this.
const CHECK_INTERVAL_SECS: i64 = 24 * 60 * 60;
/// Network timeout for a single manifest request.
const CHECK_TIMEOUT_SECS: u64 = 10;
/// A release must be at least this old before auto-update installs it, so a
/// broken release cannot reach everyone within minutes of being published.
const MIN_AUTO_INSTALL_AGE_SECS: i64 = 24 * 60 * 60;
const STATE_FILE: &str = "update-state.json";
const RELEASES_API: &str = "https://api.github.com/repos/fruyorsan/Kiro/releases?per_page=10";

/// Serializes manifest requests so concurrent callers share a single network hit.
static CHECK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static UPDATE_BUSY: AtomicBool = AtomicBool::new(false);
static LAST_CHECK: Mutex<Option<UpdateCheckResult>> = Mutex::new(None);

#[derive(Clone, Default, Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct PersistedUpdateState {
    last_check: i64,
    app_version: String,
    version: String,
    date: String,
    #[serde(default)]
    channel: String,
}

fn prerelease_channel(app: &AppHandle) -> bool {
    crate::utils::get_setting_str(app, "kiro-update-channel").as_deref() == Some("prerelease")
}

fn channel_name(app: &AppHandle) -> &'static str {
    if prerelease_channel(app) { "prerelease" } else { "stable" }
}

/// Manifest of the newest release, pre-releases included (GitHub's `latest` skips them).
async fn newest_release_manifest() -> Option<tauri::Url> {
    let client = reqwest::Client::builder()
        .user_agent("Kiro")
        .timeout(Duration::from_secs(CHECK_TIMEOUT_SECS))
        .build()
        .ok()?;
    let body = client.get(RELEASES_API).send().await.ok()?.text().await.ok()?;
    let releases: Vec<serde_json::Value> = serde_json::from_str(&body).ok()?;
    releases
        .iter()
        .filter(|release| release["draft"] != true)
        .find_map(|release| {
            release["assets"].as_array()?.iter().find_map(|asset| {
                (asset["name"] == "latest.json")
                    .then(|| asset["browser_download_url"].as_str())
                    .flatten()
                    .and_then(|url| url.parse().ok())
            })
        })
}

/// Updater for the chosen channel, falling back to stable if the release list cannot be read.
async fn channel_updater(app: &AppHandle) -> UpdaterBuilder {
    let builder = app.updater_builder();
    if !prerelease_channel(app) {
        return builder;
    }
    match newest_release_manifest().await {
        Some(url) => builder.endpoints(vec![url]).unwrap_or_else(|_| app.updater_builder()),
        None => builder,
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(STATE_FILE))
}

fn read_state(app: &AppHandle) -> PersistedUpdateState {
    state_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn write_state(app: &AppHandle, state: &PersistedUpdateState) {
    if let Some(path) = state_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(content) = serde_json::to_string(state) {
            let _ = std::fs::write(path, content);
        }
    }
}

fn result_from_state(state: &PersistedUpdateState) -> UpdateCheckResult {
    if state.version.is_empty() {
        return UpdateCheckResult::default();
    }
    UpdateCheckResult {
        available: true,
        version: Some(state.version.clone()),
        date: (!state.date.is_empty()).then(|| state.date.clone()),
        body: None,
    }
}

/// Returns a cached result only when the last check is recent and was made
/// against the version currently running (so updating invalidates the cache).
fn cached_result(app: &AppHandle) -> Option<UpdateCheckResult> {
    let state = read_state(app);
    if state.last_check == 0 || now_secs() - state.last_check >= CHECK_INTERVAL_SECS {
        return None;
    }
    if state.app_version != app.package_info().version.to_string() || state.channel != channel_name(app) {
        return None;
    }
    Some(result_from_state(&state))
}

pub fn release_is_old_enough(result: &UpdateCheckResult) -> bool {
    match result.date.as_deref().and_then(parse_rfc3339_utc) {
        Some(published) => now_secs() - published >= MIN_AUTO_INSTALL_AGE_SECS,
        None => false,
    }
}

/// Checks for an update at most once per `CHECK_INTERVAL_SECS` unless `force`
/// is set. Development builds skip the automatic network check because their
/// version never tracks releases; manual checks still work.
pub async fn check(app: &AppHandle, force: bool) -> Result<UpdateCheckResult, String> {
    if !force {
        if let Some(cached) = cached_result(app) {
            return Ok(cached);
        }
        #[cfg(debug_assertions)]
        {
            return Ok(UpdateCheckResult::default());
        }
    }

    let _guard = CHECK_LOCK.lock().await;

    // Another caller may have completed a check while we waited for the lock.
    if !force {
        if let Some(cached) = cached_result(app) {
            return Ok(cached);
        }
    }

    let updater = channel_updater(app).await.build().map_err(|e| e.to_string())?;
    let update = tokio::time::timeout(Duration::from_secs(CHECK_TIMEOUT_SECS), updater.check())
        .await
        .map_err(|_| "update check timed out".to_string())?
        .map_err(|e| e.to_string())?;

    let result = match &update {
        Some(update) => UpdateCheckResult {
            available: true,
            version: Some(update.version.clone()),
            date: update
                .raw_json
                .get("pub_date")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            body: update.body.clone(),
        },
        None => UpdateCheckResult::default(),
    };

    write_state(
        app,
        &PersistedUpdateState {
            last_check: now_secs(),
            app_version: app.package_info().version.to_string(),
            version: result.version.clone().unwrap_or_default(),
            date: result.date.clone().unwrap_or_default(),
            channel: channel_name(app).to_string(),
        },
    );
    if let Ok(mut cached) = LAST_CHECK.lock() {
        *cached = Some(result.clone());
    }
    Ok(result)
}

/// Downloads and installs the available update. On Windows the updater plugin
/// launches the NSIS installer and terminates this process, which then
/// relaunches the app; on other platforms this returns after restarting.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    if UPDATE_BUSY.swap(true, Ordering::SeqCst) {
        return Err("an update is already in progress".to_string());
    }
    let result = install_inner(app).await;
    UPDATE_BUSY.store(false, Ordering::SeqCst);
    if let Err(e) = &result {
        crate::diagnostics::log(&format!("update install failed: {e}"));
    }
    result
}

fn installer_scope_args() -> Vec<String> {
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) else { return Vec::new() };
    let Some(all_users) = crate::uninstall_registry::install_scope(&dir) else { return Vec::new() };
    vec![
        if all_users { "/ALLUSERS" } else { "/CURRENTUSER" }.to_string(),
        format!("/D={}", dir.display()),
    ]
}

fn install_needs_unavailable_elevation() -> bool {
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) else { return false };
    crate::uninstall_registry::install_scope(&dir) == Some(true) && !crate::native_uninstall::is_elevated()
}

async fn install_inner(app: &AppHandle) -> Result<(), String> {
    // Hold the check lock so a concurrent check cannot mutate state mid-install.
    let _guard = CHECK_LOCK.lock().await;

    let hook_handle = app.clone();
    let updater = channel_updater(app)
        .await
        .installer_args(installer_scope_args())
        .on_before_exit(move || {
            crate::state::SHUTTING_DOWN.store(true, Ordering::Relaxed);
            let _ = hook_handle.emit("auto-update-status", serde_json::json!({ "status": "installing" }));
            hook_handle.cleanup_before_exit();
        })
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    let _ = app.emit("auto-update-status", serde_json::json!({ "status": "downloading", "progress": 0 }));

    let progress_handle = app.clone();
    let downloaded = Arc::new(AtomicU64::new(0));
    let downloaded_cb = downloaded.clone();
    update
        .download_and_install(
            move |chunk_len, total| {
                let current = downloaded_cb.fetch_add(chunk_len as u64, Ordering::Relaxed) + chunk_len as u64;
                if let Some(total) = total {
                    if total > 0 {
                        let progress = (current.saturating_mul(100) / total) as u32;
                        let _ = progress_handle.emit(
                            "auto-update-status",
                            serde_json::json!({ "status": "downloading", "progress": progress }),
                        );
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // Windows: `download_and_install` launches the installer and exits inside
    // the plugin, so this is only reached on other platforms. There the updater
    // rewrites the running AppImage (or hands the .deb to dpkg) and returns, so
    // the restart is ours to do.
    //
    // Both arms key off `kiro_windows` rather than `windows` so the Linux arm is
    // still type-checked on a Windows host by the KIRO_FORCE_UNIX=1 check.
    #[cfg(not(kiro_windows))]
    {
        crate::state::SHUTTING_DOWN.store(true, Ordering::Relaxed);
        let _ = app.emit("auto-update-status", serde_json::json!({ "status": "done" }));
        // The restart spawns the new binary while this process is still alive,
        // so the single-instance lock has to go first or the new build sees a
        // live PID and exits immediately.
        crate::single_instance::release();
        app.cleanup_before_exit();
        app.restart()
    }

    #[cfg(kiro_windows)]
    Ok(())
}

/// Startup entry point: always checks so the UI can show an update badge, and
/// auto-installs only when the user enabled it and the release has aged.
pub async fn run_startup_check(app: AppHandle) {
    let auto_update = crate::utils::get_setting_str(&app, "kiro-auto-update").as_deref() == Some("true");

    if auto_update {
        let _ = app.emit("auto-update-status", serde_json::json!({ "status": "checking" }));
    }

    let ready_to_install = |result: &UpdateCheckResult| prerelease_channel(&app) || release_is_old_enough(result);

    let result = match check(&app, false).await {
        Ok(result) => result,
        Err(_) => {
            if auto_update {
                let _ = app.emit("auto-update-status", serde_json::json!({ "status": "done" }));
            }
            return;
        }
    };

    let _ = app.emit("update-available", &result);

    if !result.available {
        if auto_update {
            let _ = app.emit("auto-update-status", serde_json::json!({ "status": "done" }));
        }
        return;
    }

    if auto_update && ready_to_install(&result) && install_needs_unavailable_elevation() {
        crate::diagnostics::log("auto-update: skipping silent install, all-users install needs elevation this process doesn't have; leaving update available for manual install");
        let _ = app.emit("auto-update-status", serde_json::json!({ "status": "done" }));
    } else if auto_update && ready_to_install(&result) {
        // On Windows this never returns: the installer exits the process.
        if install(&app).await.is_err() {
            let _ = app.emit("auto-update-status", serde_json::json!({ "status": "done" }));
        }
    } else if auto_update {
        let _ = app.emit("auto-update-status", serde_json::json!({ "status": "done" }));
    }
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle, force: bool) -> Result<UpdateCheckResult, String> {
    let result = check(&app, force).await?;
    let _ = app.emit("update-available", &result);
    Ok(result)
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    install(&app).await
}

#[tauri::command]
pub fn get_update_state(app: AppHandle) -> UpdateCheckResult {
    if let Ok(cached) = LAST_CHECK.lock() {
        if let Some(result) = cached.as_ref() {
            return result.clone();
        }
    }
    let state = read_state(&app);
    // The state file survives the update it describes: right after installing
    // 1.9.3 it still says "1.9.3 is available" (recorded while running 1.9.2),
    // so the badge pointed at the build the user had just installed. Only trust
    // state that was recorded against the version actually running.
    if state.app_version != app.package_info().version.to_string() {
        return UpdateCheckResult::default();
    }
    result_from_state(&state)
}

fn parse_rfc3339_utc(value: &str) -> Option<i64> {
    if value.len() < 20 || !value.ends_with('Z') {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Howard Hinnant's days-from-civil algorithm.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::{days_from_civil, parse_rfc3339_utc};

    /// `cargo test` runs the test binary with the *package* directory as the
    /// working directory, so a path typed relative to the repository root
    /// (`src-tauri/target/...`) silently resolves to `src-tauri/src-tauri/...`.
    /// Try the path as given, then relative to the package and its parent.
    fn locate(path: &str) -> std::path::PathBuf {
        let direct = std::path::PathBuf::from(path);
        if direct.exists() {
            return direct;
        }
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        for base in [manifest_dir, manifest_dir.parent().unwrap_or(manifest_dir)] {
            let candidate = base.join(path);
            if candidate.exists() {
                return candidate;
            }
        }
        panic!("cannot find {path} from {}", std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default());
    }

    /// End-to-end proof that a published release can actually be installed by
    /// the updater: the signature must verify against the public key compiled
    /// into the app, for the exact installer it was made for. A signing key
    /// that no longer matches `tauri.conf.json` otherwise fails only at install
    /// time on a user's machine, which is far too late to notice.
    ///
    /// Ignored by default because it needs real build output. Run it with
    /// `KIRO_UPDATE_MANIFEST=<latest.json>` or `KIRO_UPDATE_SIGNATURE=<file.sig>`,
    /// plus `KIRO_UPDATE_ARTIFACT=<installer.exe>`:
    ///   cargo test -- --ignored real_release_signature
    #[test]
    #[ignore]
    fn real_release_signature_verifies() {
        use base64::Engine;

        let Ok(artifact_path) = std::env::var("KIRO_UPDATE_ARTIFACT") else {
            eprintln!("skipped: KIRO_UPDATE_ARTIFACT not set");
            return;
        };

        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
                .expect("read tauri.conf.json"),
        )
        .expect("parse tauri.conf.json");
        let pubkey_b64 = conf["plugins"]["updater"]["pubkey"]
            .as_str()
            .expect("plugins.updater.pubkey");

        // The field is the base64 of the whole minisign.pub file (comment line
        // plus key line), not just the key.
        let pubkey_text = base64::engine::general_purpose::STANDARD
            .decode(pubkey_b64)
            .expect("pubkey is base64");
        let public_key = minisign_verify::PublicKey::decode(
            std::str::from_utf8(&pubkey_text).expect("pubkey is utf-8"),
        )
        .expect("pubkey decodes");

        // Two sources are accepted: the published `latest.json`, whose
        // signature field is base64 of the signature text, and the `.sig` file
        // the build writes next to the installer.
        let signature_text: String;
        if let Ok(manifest_path) = std::env::var("KIRO_UPDATE_MANIFEST") {
            let manifest: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(locate(&manifest_path)).expect("read manifest"),
            )
            .expect("parse manifest");
            // The manifest key is the one the updater looks up on this platform
            // (`linux-x86_64`, `windows-x86_64`, ...); tests that only pass a raw
            // `.sig` do not need it.
            let platform = std::env::var("KIRO_UPDATE_PLATFORM").unwrap_or_else(|_| {
                let os = if cfg!(windows) {
                    "windows"
                } else if cfg!(target_os = "macos") {
                    "darwin"
                } else {
                    "linux"
                };
                let arch = if cfg!(target_arch = "x86_64") { "x86_64" } else { "aarch64" };
                format!("{os}-{arch}")
            });
            let signature_b64 = manifest["platforms"][&platform]["signature"]
                .as_str()
                .expect("signature");
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(signature_b64)
                .expect("signature is base64");
            signature_text = String::from_utf8(decoded).expect("signature is utf-8");
        } else if let Ok(sig_path) = std::env::var("KIRO_UPDATE_SIGNATURE") {
            signature_text = std::fs::read_to_string(locate(&sig_path)).expect("read signature");
        } else {
            eprintln!("skipped: neither KIRO_UPDATE_MANIFEST nor KIRO_UPDATE_SIGNATURE is set");
            return;
        }

        let signature =
            minisign_verify::Signature::decode(signature_text.trim()).or_else(|error| {
                // Tauri writes the `.sig` file as base64 of the signature text
                // (that is also what the published asset contains), so accept
                // both the text and its base64 form instead of guessing.
                let Ok(decoded) = base64::engine::general_purpose::STANDARD
                    .decode(signature_text.trim())
                else {
                    return Err(error);
                };
                let Ok(text) = String::from_utf8(decoded) else {
                    return Err(error);
                };
                minisign_verify::Signature::decode(&text)
            })
            .expect("signature decodes");

        let artifact = std::fs::read(locate(&artifact_path)).expect("read artifact");
        if let Err(error) = public_key.verify(&artifact, &signature, true) {
            panic!("the release signature does not verify with the pubkey in tauri.conf.json: {error}");
        }
        println!(
            "signature verified for {} bytes ({artifact_path})",
            artifact.len()
        );
    }

    #[test]
    fn parses_tauri_action_pub_date() {
        assert_eq!(parse_rfc3339_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_utc("2026-09-13T18:14:46Z"), Some(1_789_323_286));
        assert_eq!(parse_rfc3339_utc("2026-09-13T18:14:46.123Z"), Some(1_789_323_286));
    }

    #[test]
    fn rejects_non_utc_and_malformed_dates() {
        assert_eq!(parse_rfc3339_utc("2026-09-13T18:14:46+02:00"), None);
        assert_eq!(parse_rfc3339_utc("not-a-date"), None);
        assert_eq!(parse_rfc3339_utc("2026-13-40T99:99:99Z"), None);
    }

    #[test]
    fn computes_civil_days() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 9, 13), 20_709);
    }
}
