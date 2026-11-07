/**
 * One-time client-side migration of the settings localStorage keys.
 *
 * Kiro used to be called Nectar and every key was stored as `nectar-*`. The
 * rebrand renamed the keys to `kiro-*`, so an existing install would otherwise
 * start with all settings reset to their defaults. Copy every legacy value to
 * its new name (never overwriting a value already written under the new name)
 * and drop the old one.
 *
 * This module runs on import, before any screen reads its settings, so it is
 * safe to import from every entry point.
 */

const LEGACY_PREFIX = "nectar-";
const PREFIX = "kiro-";

export function migrateLegacyStorage(): void {
  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
    }

    for (const legacyKey of legacyKeys) {
      const key = PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
      const value = localStorage.getItem(legacyKey);
      if (value !== null && localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
      }
      localStorage.removeItem(legacyKey);
    }
  } catch {
    // Storage disabled (private mode, quota): nothing to migrate.
  }
}

migrateLegacyStorage();

/**
 * Mirror every Kiro value from settings.json into localStorage.
 *
 * A fresh install gets the shipped defaults written to settings.json by the
 * backend. Some windows read a setting directly from localStorage before
 * their own `load_settings` call resolves; hydrating the cache from the same
 * snapshot makes every surface agree instead of briefly showing a hardcoded
 * fallback.
 */
export function hydrateStorageFromSettings(settings: Record<string, unknown>): void {
  try {
    for (const key of Object.keys(settings)) {
      if (!key.startsWith(PREFIX)) continue;
      const value = settings[key];
      if (value === null || value === undefined) continue;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      localStorage.setItem(key, text);
    }
  } catch {
    // Storage disabled: the in-memory settings still apply.
  }
}
