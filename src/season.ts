import { useEffect, useMemo, useState } from "react";
import { useSettingsSync } from "./hooks/useSettingsSync";

/**
 * Seasonal decoration for the notch and the dock.
 *
 * The whole effect is a fixed set of absolutely positioned spans animated by
 * CSS keyframes on `transform`/`opacity` only, so the compositor does the work
 * and React never re-renders. There is no timer, no canvas and no particle
 * simulation: about twenty nodes per window, painted once.
 */

export type SeasonEffect = "snow" | "rain" | "leaves" | "blossom";

export const SEASON_SETTING = "kiro-season-theme";

export const SEASON_EFFECTS: SeasonEffect[] = ["snow", "rain", "leaves", "blossom"];

/** The calendar pick, for `auto`. Northern hemisphere, month-based. */
export function effectForDate(date = new Date()): SeasonEffect {
  const month = date.getMonth();
  if (month === 11 || month <= 1) return "snow";
  if (month <= 4) return "blossom";
  if (month <= 7) return "rain";
  return "leaves";
}

/**
 * `null` means "paint nothing". Unknown values fall back to the calendar, and
 * the old season names still work so an existing setting keeps its look.
 */
export function resolveSeason(raw: string | null | undefined, now = new Date()): SeasonEffect | null {
  const value = (raw ?? "auto").trim().toLowerCase();
  if (value === "off" || value === "none" || value === "false") return null;
  if (value === "snow" || value === "rain" || value === "leaves" || value === "blossom") return value;
  // Legacy names from the first release of the effect.
  if (value === "winter") return "snow";
  if (value === "spring") return "blossom";
  if (value === "summer") return "rain";
  if (value === "autumn") return "leaves";
  return effectForDate(now);
}

export function setSeasonTheme(value: string) {
  localStorage.setItem(SEASON_SETTING, value);
}

export function useSeason(): SeasonEffect | null {
  const [raw, setRaw] = useState<string | null>(() => localStorage.getItem(SEASON_SETTING));

  useEffect(() => {
    const onStorage = () => setRaw(localStorage.getItem(SEASON_SETTING));
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // The `storage` event is unreliable between WebView2 windows; the settings
  // event is what actually reaches the dock and the notch after a change.
  useSettingsSync({ [SEASON_SETTING]: (value) => setRaw(String(value)) });

  return useMemo(() => resolveSeason(raw), [raw]);
}
