import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let styleEl: HTMLStyleElement | null = null;
let pauseAnimations = true;

function ensureStyle() {
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "kiro-perf-lite";
    document.head.appendChild(styleEl);
  }
  // Backdrop blur is the expensive part: every blurred surface forces the
  // compositor to re-read the pixels behind it every frame. While a game owns
  // the screen there is nothing behind the dock worth blurring, so drop it and
  // shorten transitions. Releasing compositor layers (`will-change`) keeps
  // hidden windows from waking the GPU at all.
  //
  // Pausing CSS animations is only safe for the dock/notch: those windows are
  // hidden by game_boost, so a frozen entrance animation cannot be seen. The
  // overlay still shows volume/brightness OSDs during a game, so it keeps its
  // animations (otherwise an opacity animation would freeze at 0 and the card
  // would never appear).
  styleEl.textContent = `
    html.perf-lite *,
    html.perf-lite *::before,
    html.perf-lite *::after {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      transition-duration: 1ms !important;
      transition-delay: 0ms !important;
      will-change: auto !important;
    }
    ${
      pauseAnimations
        ? `html.perf-lite *,
    html.perf-lite *::before,
    html.perf-lite *::after {
      animation-play-state: paused !important;
    }`
        : ""
    }
  `;
}

export function applyPerfMode(on: boolean) {
  ensureStyle();
  document.documentElement.classList.toggle("perf-lite", on);
}

/**
 * Auto performance mode listener. A fullscreen game makes the backend send
 * `perf-mode`; while it is on we drop the blur work the compositor would
 * otherwise do every frame for windows nobody can see.
 *
 * `pauseAnimations` is true for the dock/notch renderers (hidden during a
 * game) and false for the overlay, whose OSD has to stay visible.
 */
export function initPerfMode(pauseAnimationsForWindow = true) {
  pauseAnimations = pauseAnimationsForWindow;
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
