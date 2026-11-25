import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import en from "./locales/en.json";

type Messages = Record<string, string>;

export const LANGUAGES: Record<string, { name: string }> = {
  en: { name: "English" },
  tr: { name: "Türkçe" },
  de: { name: "Deutsch" },
  fr: { name: "Français" },
  es: { name: "Español" },
  it: { name: "Italiano" },
  pt: { name: "Português" },
  ru: { name: "Русский" },
  uk: { name: "Українська" },
  pl: { name: "Polski" },
  nl: { name: "Nederlands" },
  id: { name: "Bahasa Indonesia" },
  zh: { name: "中文" },
  ja: { name: "日本語" },
  ko: { name: "한국어" },
  ar: { name: "العربية" },
};

// Each locale is its own chunk, fetched only when that language is picked, so
// sixteen languages cost nothing in RAM or download for anyone using one. A
// locale file may translate only the shell and finish in English: `t` falls
// back key by key, so a missing string never shows as a raw key.
const LAZY_LOCALES: Record<string, () => Promise<{ default: Messages }>> = {
  tr: () => import("./locales/tr.json"),
  de: () => import("./locales/de.json"),
  fr: () => import("./locales/fr.json"),
  es: () => import("./locales/es.json"),
  it: () => import("./locales/it.json"),
  pt: () => import("./locales/pt.json"),
  ru: () => import("./locales/ru.json"),
  uk: () => import("./locales/uk.json"),
  pl: () => import("./locales/pl.json"),
  nl: () => import("./locales/nl.json"),
  id: () => import("./locales/id.json"),
  zh: () => import("./locales/zh.json"),
  ja: () => import("./locales/ja.json"),
  ko: () => import("./locales/ko.json"),
  ar: () => import("./locales/ar.json"),
};

const loaded: Record<string, Messages> = { en: en as Messages };
// `loaded[lang] = {}` marks a download in flight, so it cannot double-start.
// It cannot stand for "messages are here" either: the snapshot needs the real
// moment the chunk arrived to re-render with it.
const arrived = new Set<string>(["en"]);

function loadIfNeeded(lang: string) {
  if (loaded[lang] || !LAZY_LOCALES[lang]) return;
  loaded[lang] = {};
  LAZY_LOCALES[lang]()
    .then((mod) => {
      loaded[lang] = mod.default as Messages;
      arrived.add(lang);
      listeners.forEach((l) => l());
    })
    .catch(() => {
    });
}

const STORAGE_KEY = "kiro-language";
const listeners = new Set<() => void>();

// The settings window writes the language through save_setting, which emits a
// Tauri event. Windows do not share WebView2's in-memory localStorage, so the
// `storage` event alone leaves the notch/dock in the old language until a
// restart. Follow the event here and re-render every subscribed component.
function applyExternalLanguage(value: unknown) {
  if (value === null || value === undefined) return;
  try {
    const next = String(value);
    if (localStorage.getItem(STORAGE_KEY) === next) return;
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    return;
  }
  loadIfNeeded(resolve(String(value)));
  listeners.forEach((l) => l());
}

listen<{ key: string; value: unknown }>("settings-changed", (event) => {
  if (event.payload?.key === STORAGE_KEY) applyExternalLanguage(event.payload.value);
}).catch(() => {});
listen<{ key: string; value: unknown }>("settings-external-changed", (event) => {
  if (event.payload?.key === STORAGE_KEY) applyExternalLanguage(event.payload.value);
}).catch(() => {});

function readPreference(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "system";
  } catch {
    return "system";
  }
}

function resolve(preference: string): string {
  if (preference in LANGUAGES) return preference;
  const system = (navigator.language || "en").toLowerCase().split("-")[0];
  return system in LANGUAGES ? system : "en";
}

export function getLanguagePreference(): string {
  return readPreference();
}

export function setLanguagePreference(value: string) {
  localStorage.setItem(STORAGE_KEY, value);
  invoke("save_setting", { key: STORAGE_KEY, value }).catch(console.error);
  loadIfNeeded(resolve(value));
  listeners.forEach((l) => l());
}

export function t(key: string, params?: Record<string, string | number>): string {
  const lang = resolve(readPreference());
  if (lang !== "en") loadIfNeeded(lang);
  const messages = loaded[lang];
  const text = messages?.[key] ?? (en as Messages)[key] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** Locale for dates and times, so they match the chosen UI language. */
export function dateLocale(): string {
  return resolve(readPreference());
}

/** Weekday names starting on Sunday. */
export function weekdayNames(width: "short" | "narrow"): string[] {
  return Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(dateLocale(), { weekday: width }));
}

// Locales that read a month as Monday-first. English and the east-Asian
// locales keep Sunday first, which is what their weekday names imply.
const MONDAY_FIRST = new Set(["tr", "de", "fr", "es", "it", "pt", "nl", "pl", "ru", "uk"]);

/** First day of the week as `Date#getDay()` numbers: 0 = Sunday, 1 = Monday. */
export function weekStartsOn(): number {
  return MONDAY_FIRST.has(dateLocale()) ? 1 : 0;
}

/** Weekday names rotated so the first entry is the first day of the week. */
export function weekHeader(width: "short" | "narrow"): string[] {
  const names = weekdayNames(width);
  const start = weekStartsOn();
  return Array.from({ length: 7 }, (_, i) => names[(start + i) % 7]);
}

export function timeAgo(ms: number | null, translate: (key: string, params?: Record<string, string | number>) => string): string {
  if (!ms) return translate("common.ago.never");
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return translate("common.ago.now");
  if (mins < 60) return translate("common.ago.minutes", { count: mins });
  const hours = Math.round(mins / 60);
  return hours < 24
    ? translate("common.ago.hours", { count: hours })
    : translate("common.ago.days", { count: Math.round(hours / 24) });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  loadIfNeeded(resolve(readPreference()));
  // Other windows change the setting through localStorage.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) {
      loadIfNeeded(resolve(readPreference()));
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

// A lazy locale arrives after the first paint. `useSyncExternalStore` only
// re-renders when the snapshot changes, and the preference itself did not, so
// the finished download went unnoticed and the UI stayed in English. The
// snapshot therefore also says whether that locale's messages are in memory.
function snapshot(): string {
  const preference = readPreference();
  const lang = resolve(preference);
  return `${preference}:${arrived.has(lang) ? 1 : 0}`;
}

/** Re-renders the calling component when the language changes; returns the translate function. */
export function useT() {
  useSyncExternalStore(subscribe, snapshot);
  return t;
}

export type TFunction = typeof t;
