/**
 * setInterval for UI polling that has no value while nobody can see it.
 *
 * Two cases are skipped:
 *  - the page is in a background tab / window (`document.hidden`),
 *  - the automatic performance mode is on (`html.perf-lite`): a fullscreen game
 *    owns the machine and the dock/notch are hidden at the OS level, so waking
 *    up to fetch CPU/RAM, media sessions or wifi state only steals frame time.
 *
 * The interval keeps running, so the first tick after the game closes refreshes
 * everything immediately.
 */
export function setVisibleInterval(handler: () => void, ms: number): number {
  return window.setInterval(() => {
    if (document.hidden) return;
    if (document.documentElement.classList.contains("perf-lite")) return;
    handler();
  }, ms);
}
