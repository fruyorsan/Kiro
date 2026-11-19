import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * Opens Settings and deep-links it to a page.
 *
 * Settings is built on demand, so the navigation event used to be emitted
 * while the new window was still booting its webview — the listener did not
 * exist yet and the user landed on the General tab. The freshly mounted window
 * announces `settings-ready`, and the immediate emit still covers the case
 * where the window was already open.
 */
export async function openSettingsAt(payload: string) {
  let off: (() => void) | undefined;
  try {
    off = await listen("settings-ready", () => {
      void emit("settings-navigate", payload);
      off?.();
    });
    // Never leak the listener if the window is closed before it mounts.
    window.setTimeout(() => off?.(), 6000);
  } catch {
    // The plain emit below is still enough when the window already exists.
  }
  await invoke("open_settings_window");
  await emit("settings-navigate", payload);
}
