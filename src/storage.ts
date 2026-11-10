/**
 * Settings cache shared by every window.
 *
 * Each window keeps a copy of the settings in `localStorage` so a surface can
 * paint the right theme, opacity and accent on its very first frame, before its
 * own `load_settings` call resolves. `hydrateStorageFromSettings` fills that
 * copy from one backend snapshot so every window agrees with every other one
 * instead of briefly showing a hardcoded fallback.
 */

const PREFIX = "kiro-";

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
