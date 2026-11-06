import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let installed = false;

function ensureStyle() {
  if (installed) return;
  installed = true;
  const style = document.createElement("style");
  style.id = "kiro-perf-lite";
  style.textContent = `
    html.perf-lite *,
    html.perf-lite *::before,
    html.perf-lite *::after {
      animation-duration: 1ms !important;
      animation-delay: 0ms !important;
      transition-duration: 1ms !important;
      transition-delay: 0ms !important;
    }
    html.perf-lite .dock-panel,
    html.perf-lite .notch-panel,
    html.perf-lite [class*="backdrop"],
    html.perf-lite [class*="blur"] {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
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
 * `perf-mode`; while it is on we drop CSS blur and animations so the compositor
 * has nothing extra to do. Motion that is driven in JS (the dock spring) is
 * left alone so the UI still feels right.
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
