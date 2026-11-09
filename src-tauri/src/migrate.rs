//! One-time migration of user data from a previous install.
//!
//! Kiro uses its own config folder (`%APPDATA%\com.fruyorsan.kiro`). On first
//! launch we copy data from the earlier app id over so settings, pinned apps,
//! custom icons and the agent API config survive the rename. Nothing is ever
//! written back to the old folder, so the previous install keeps working
//! unchanged.
//!
//! The rename also changed every settings key from `nectar-*` to `kiro-*`.
//! `rename_settings_keys` rewrites an existing `settings.json` in place so a
//! user who already ran Kiro keeps the values they chose.

use std::path::{Path, PathBuf};

const OLD_APP_ID: &str = "com.kua8.nectar";
const NEW_APP_ID: &str = "com.fruyorsan.kiro";
const MARKER: &str = ".migrated-from-nectar";

/// Old settings keys carried the previous product name. New keys use this one.
const LEGACY_KEY_PREFIX: &str = "nectar-";
const KEY_PREFIX: &str = "kiro-";

/// Files that are runtime state rather than user data, and should not be
/// carried over (logs, update bookkeeping, temporary files).
fn skip_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".log")
        || lower.ends_with(".old.log")
        || lower.ends_with(".tmp")
        || lower == "update-state.json"
        || lower == MARKER
}

fn skip_dir(name: &str) -> bool {
    name.eq_ignore_ascii_case("logs")
}

fn copy_missing(src: &Path, dst: &Path) {
    let Ok(entries) = std::fs::read_dir(src) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let to = dst.join(&name);
        let from = entry.path();

        let Ok(kind) = entry.file_type() else {
            continue;
        };

        if kind.is_dir() {
            if skip_dir(&name_str) {
                continue;
            }
            let _ = std::fs::create_dir_all(&to);
            copy_missing(&from, &to);
        } else if kind.is_file() && !skip_file(&name_str) && !to.exists() {
            let _ = std::fs::copy(&from, &to);
        }
    }
}

/// Rename `nectar-*` keys in `settings.json` to `kiro-*`, keeping the values.
/// A value already stored under the new name wins, so running this twice (or
/// after a partial write) never loses data. No-op when the file is missing or
/// already migrated.
pub fn rename_settings_keys(dir: &Path) {
    let path = dir.join("settings.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    // Tolerate a UTF-8 BOM: an editor-saved file otherwise failed to parse and
    // the legacy `nectar-*` keys stayed unmigrated, resetting every setting.
    let content = content.strip_prefix('\u{feff}').unwrap_or(&content);
    let Ok(mut settings) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(content)
    else {
        return;
    };

    let legacy: Vec<String> = settings
        .keys()
        .filter(|key| key.starts_with(LEGACY_KEY_PREFIX))
        .cloned()
        .collect();
    if legacy.is_empty() {
        return;
    }

    for old_key in legacy {
        let new_key = format!("{}{}", KEY_PREFIX, &old_key[LEGACY_KEY_PREFIX.len()..]);
        if let Some(value) = settings.remove(&old_key) {
            settings.entry(new_key).or_insert(value);
        }
    }

    if let Ok(content) = serde_json::to_string(&serde_json::Value::Object(settings)) {
        let _ = std::fs::write(&path, content);
    }
}

/// Copy the previous install's config folder into Kiro's folder once, then
/// normalise the settings keys. Safe to call on every start: a marker file
/// makes the copy a no-op after the first successful run, and existing Kiro
/// files are never overwritten.
pub fn run() {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return;
    };
    let appdata = PathBuf::from(appdata);
    let old_dir = appdata.join(OLD_APP_ID);
    let new_dir = appdata.join(NEW_APP_ID);

    if old_dir.is_dir() && !new_dir.join(MARKER).exists() {
        let _ = std::fs::create_dir_all(&new_dir);
        copy_missing(&old_dir, &new_dir);
        let _ = std::fs::write(new_dir.join(MARKER), "kiro: data migrated from previous install\n");
    }

    rename_settings_keys(&new_dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_files_are_not_migrated() {
        assert!(skip_file("nectar.log"));
        assert!(skip_file("kiro.old.log"));
        assert!(skip_file("update-state.json"));
        assert!(skip_file(".migrated-from-nectar"));
        assert!(!skip_file("settings.json"));
        assert!(!skip_file("pinned_apps.json"));
        assert!(!skip_file("agent.json"));
    }

    #[test]
    fn settings_keys_are_renamed_and_new_values_win() {
        let dir = std::env::temp_dir().join(format!("kiro-migrate-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            r#"{"nectar-dock-mode":"smart","nectar-scale":"1.1","kiro-scale":"2.0","other":1}"#,
        )
        .unwrap();

        rename_settings_keys(&dir);

        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["kiro-dock-mode"], "smart");
        // The value already stored under the new key must not be replaced.
        assert_eq!(saved["kiro-scale"], "2.0");
        assert_eq!(saved["other"], 1);
        assert!(saved.get("nectar-dock-mode").is_none());
        assert!(saved.get("nectar-scale").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
