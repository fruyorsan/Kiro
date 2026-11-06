//! One-time migration of user data from the official Nectar build.
//!
//! Kiro is a fork of Nectar and uses its own config folder
//! (`%APPDATA%\com.fruyorsan.kiro`). On first launch we copy the user's
//! existing Nectar data over so settings, pinned apps, custom icons and the
//! agent API config survive the rename. Nothing is ever written back to the
//! Nectar folder, so the original app keeps working unchanged.

use std::path::{Path, PathBuf};

const OLD_APP_ID: &str = "com.kua8.nectar";
const NEW_APP_ID: &str = "com.fruyorsan.kiro";
const MARKER: &str = ".migrated-from-nectar";

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

/// Copy Nectar's config folder into Kiro's folder once. Safe to call on every
/// start: a marker file makes it a no-op after the first successful run, and
/// existing Kiro files are never overwritten.
pub fn run() {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return;
    };
    let appdata = PathBuf::from(appdata);
    let old_dir = appdata.join(OLD_APP_ID);
    let new_dir = appdata.join(NEW_APP_ID);

    if !old_dir.is_dir() || new_dir.join(MARKER).exists() {
        return;
    }

    let _ = std::fs::create_dir_all(&new_dir);
    copy_missing(&old_dir, &new_dir);
    let _ = std::fs::write(new_dir.join(MARKER), "kiro: data migrated from Nectar\n");
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
}
