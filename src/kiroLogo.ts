/**
 * Custom Kiro logo.
 *
 * Users can replace the bundled mascot (`/kiro.png`) with their own picture.
 * The image is validated and re-encoded by the backend (`prepare_kiro_logo`)
 * and then stored under the `kiro-logo` setting as a small PNG data URI, so it
 * survives restarts and shows up in every window (dock, notch, settings,
 * splash) at once.
 */
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const SETTING_KEY = "kiro-logo";
export const DEFAULT_KIRO_LOGO = "/kiro.png?v=2";

function readStored(): string {
  try {
    return localStorage.getItem(SETTING_KEY) || "";
  } catch {
    return "";
  }
}

let custom = readStored();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A single unmounted consumer must not break the rest.
    }
  }
}

function apply(value: string) {
  if (value === custom) return;
  custom = value;
  notify();
}

/** The logo every surface should render: the user's picture or the default. */
export function getKiroLogoSrc(): string {
  return custom || DEFAULT_KIRO_LOGO;
}

/**
 * Reads the file, hands it to the backend for validation/resizing and returns
 * a data URI. Throws a friendly Error when the file is not a usable image.
 */
export async function prepareKiroLogo(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("image-type");
  }
  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("image-read"));
    reader.readAsDataURL(file);
  });
  return invoke<string>("prepare_kiro_logo", { iconData: dataUri });
}

/** Applies a prepared logo immediately and persists it for other windows. */
export function setKiroLogoSrc(dataUrl: string) {
  apply(dataUrl);
  try {
    localStorage.setItem(SETTING_KEY, dataUrl);
  } catch {
    // Quota exceeded: the in-memory logo still works until restart.
  }
  invoke("save_setting", { key: SETTING_KEY, value: dataUrl }).catch(() => {});
}

/** Restores the bundled logo. */
export function resetKiroLogo() {
  apply("");
  try {
    localStorage.removeItem(SETTING_KEY);
  } catch {
    // ignore
  }
  invoke("save_setting", { key: SETTING_KEY, value: "" }).catch(() => {});
}

/** React binding: components re-render when the logo changes. */
export function useKiroLogo(): string {
  return useSyncExternalStore(subscribe, getKiroLogoSrc, () => DEFAULT_KIRO_LOGO);
}

// Keep every window in sync. Each WebView2 window has its own localStorage
// copy, so the cross-window signal is the `settings-changed` event.
if (typeof window !== "undefined") {
  const onEvent = (event: { payload?: { key?: string; value?: unknown } }) => {
    if (event.payload?.key !== SETTING_KEY) return;
    const value = event.payload.value;
    apply(typeof value === "string" ? value : "");
  };
  listen<{ key: string; value: unknown }>("settings-changed", onEvent).catch(() => {});
  listen<{ key: string; value: unknown }>("settings-external-changed", onEvent).catch(() => {});

  // First paint of a fresh window: pull the saved value from settings.json in
  // case localStorage was cleared while settings were kept.
  invoke<Record<string, unknown>>("load_settings")
    .then((settings) => {
      const value = settings?.[SETTING_KEY];
      if (typeof value === "string") apply(value);
    })
    .catch(() => {});
}
