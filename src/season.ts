import { useEffect, useMemo, useState } from "react";
import { useSettingsSync } from "./hooks/useSettingsSync";

/**
 * Seasonal decoration for the notch and the dock.
 *
 * The whole effect is a fixed set of absolutely positioned spans animated by
 * CSS keyframes on `transform`/`opacity` only, so the compositor does the work
 * and React never re-renders. There is no timer, no canvas and no particle
 * simulation: about a dozen nodes per window, painted once.
 */

export type Season = "winter" | "autumn" | "spring" | "summer";

export const SEASON_SETTING = "kiro-season-theme";

export const SEASONS: Season[] = ["winter", "spring", "summer", "autumn"];

export function seasonForDate(date = new Date()): Season {
  const month = date.getMonth();
  // Northern hemisphere: the theme follows the calendar, not the weather.
  if (month === 11 || month <= 1) return "winter";
  if (month <= 4) return "spring";
  if (month <= 7) return "summer";
  return "autumn";
}

/** `null` means "paint nothing". Unknown values fall back to the calendar. */
export function resolveSeason(raw: string | null | undefined, now = new Date()): Season | null {
  const value = (raw ?? "auto").trim().toLowerCase();
  if (value === "off" || value === "none" || value === "false") return null;
  if (value === "winter" || value === "spring" || value === "summer" || value === "autumn") return value;
  return seasonForDate(now);
}

export function setSeasonTheme(value: string) {
  localStorage.setItem(SEASON_SETTING, value);
}

export function useSeason(): Season | null {
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
