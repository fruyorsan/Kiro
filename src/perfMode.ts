import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let installed = false;

function ensureStyle() {
  if (installed) return;
  installed = true;
  const style = document.createElement("style");
  style.id = "kiro-perf-lite";
  // Backdrop blur is the expensive part: every blurred surface forces the
  // compositor to re-read the pixels behind it every frame. While a game owns
  // the screen there is nothing behind the dock worth blurring, so drop it and
  // shorten transitions. Framer-motion animations are driven from JS and are
  // deliberately left alone so the UI still behaves normally.
  style.textContent = `
    html.perf-lite *,
    html.perf-lite *::before,
    html.perf-lite *::after {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      transition-duration: 1ms !important;
      transition-delay: 0ms !important;
    }
  `;
  document.head.appendChild(style);
}

export function applyPerfMode(on: boolean) {
  ensureStyle();
  document.documentElement.classList.toggle("perf-lite", on);
}

/**
 * Auto performance mode listener. A fullscreen game makes the backend send
 * `perf-mode`; while it is on we drop the blur work the compositor would
 * otherwise do every frame for windows nobody can see.
 */
export function initPerfMode() {
  ensureStyle();
  const unlisten = listen<boolean>("perf-mode", (event) => {
    applyPerfMode(!!event.payload);
  });
  // Sync in case the mode engaged before this window finished loading.
  invoke<boolean>("get_perf_mode")
    .then((on) => applyPerfMode(!!on))
    .catch(() => {});
  return () => {
    unlisten.then((off) => off()).catch(() => {});
  };
}
