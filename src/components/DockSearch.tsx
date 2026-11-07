import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../i18n";

/**
 * Kiro's launcher.
 *
 * The magnifier used to hand the job to Windows Search: a separate process, a
 * cold start and a couple of hundred milliseconds before the first keystroke
 * even lands. This panel does the same work inside the dock window instead.
 *
 * Performance notes:
 * - The installed-app list is cached at module level (and mirrored into
 *   localStorage), so opening the panel paints from memory even on the very
 *   first open after a restart.
 * - Filtering is a single pass with a cheap scoring function, capped to ten
 *   visible rows. No virtual list, no per-keystroke IPC.
 * - Icons are requested only for the rows that are actually visible.
 */

interface SearchApp {
  name: string;
  path: string;
  icon: string | null;
  is_running: boolean;
  is_pinned?: boolean;
  hwnd?: number;
  executable?: string;
  all_hwnds?: [number, string][];
  args?: string;
}

const APPS_CACHE_KEY = "kiro-installed-apps-cache";
const RECENTS_KEY = "kiro-search-recents";
const MAX_RESULTS = 10;

let appsCache: SearchApp[] | null = null;
let appsPromise: Promise<SearchApp[]> | null = null;

function readMirror(): SearchApp[] {
  try {
    const raw = localStorage.getItem(APPS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Loads the installed apps once. Returns immediately with whatever is cached
 * and resolves again when the backend scan finishes.
 */
export function loadInstalledApps(): { cached: SearchApp[]; ready: Promise<SearchApp[]> } {
  if (appsCache && appsCache.length > 0) {
    return { cached: appsCache, ready: Promise.resolve(appsCache) };
  }
  const mirror = readMirror();
  if (!appsPromise) {
    appsPromise = invoke<SearchApp[]>("get_installed_apps")
      .then((list) => {
        const sorted = [...list].filter((a) => a.path !== "start").sort((a, b) => a.name.localeCompare(b.name));
        appsCache = sorted;
        try {
          // Icons are stripped: the mirror only needs names and paths to make
          // the first paint instant, icons are fetched per visible row anyway.
          localStorage.setItem(
            APPS_CACHE_KEY,
            JSON.stringify(sorted.map((a) => ({ name: a.name, path: a.path, icon: null, is_running: false, args: a.args })))
          );
        } catch {
          /* quota is not worth failing the launcher over */
        }
        return sorted;
      })
      .catch(() => mirror);
  }
  return { cached: mirror, ready: appsPromise };
}

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function recordRecent(app: SearchApp) {
  try {
    const key = recentKey(app);
    const next = [key, ...readRecents().filter((k) => k !== key)].slice(0, 8);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

const recentKey = (app: SearchApp) => `${app.path}\u0000${app.name}`;

/** Cheap relevance score; -1 means "no match". */
function score(name: string, query: string): number {
  const n = name;
  if (n === query) return 1200;
  if (n.startsWith(query)) return 1000 - n.length;
  // Word starts ("visual studio" finds "Visual Studio Code", "code" finds it too).
  const words = n.split(/[\s\-_.()[\]]+/);
  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith(query)) return 850 - i * 12 - n.length;
  }
  const at = n.indexOf(query);
  if (at >= 0) return 650 - at;
  // Subsequence fallback: "vsc" -> "visual studio code".
  let qi = 0;
  for (let i = 0; i < n.length && qi < query.length; i++) {
    if (n[i] === query[qi]) qi++;
  }
  return qi === query.length ? 320 - n.length : -1;
}

// ---------------------------------------------------------------------------
// Arithmetic without eval(): a small shunting-yard evaluator. Only numbers and
// the operators a launcher needs, so an input like "24*7" never leaves the
// process and nothing is ever executed.
// ---------------------------------------------------------------------------
function evaluateExpression(raw: string): string | null {
  const input = raw.trim().replace(/,/g, ".").replace(/x/gi, "*").replace(/÷/g, "/").replace(/×/g, "*");
  if (!/^[\d\s+\-*/%^().]+$/.test(input)) return null;
  if (!/[\d)]\s*[+\-*/%^]\s*[\d(]/.test(input) && !/[*/^%]/.test(input)) return null;

  const tokens: (number | string)[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " ") { i++; continue; }
    if (/[\d.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[\d.]/.test(input[j])) j++;
      const value = Number(input.slice(i, j));
      if (!Number.isFinite(value)) return null;
      tokens.push(value);
      i = j;
      continue;
    }
    if ("+-*/%^()".includes(ch)) { tokens.push(ch); i++; continue; }
    return null;
  }
  if (tokens.length === 0) return null;

  const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3, "u": 4 };
  const output: (number | string)[] = [];
  const ops: string[] = [];
  let expectOperand = true;
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (typeof token === "number") {
      output.push(token);
      expectOperand = false;
      continue;
    }
    if (token === "(") { ops.push(token); expectOperand = true; continue; }
    if (token === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") output.push(ops.pop()!);
      if (!ops.length) return null;
      ops.pop();
      expectOperand = false;
      continue;
    }
    // Unary minus: a dedicated right-associative operator, so "2*-3" is -6
    // instead of silently evaluating left to right.
    if (token === "-" && expectOperand) {
      ops.push("u");
      continue;
    }
    while (
      ops.length &&
      ops[ops.length - 1] !== "(" &&
      precedence[ops[ops.length - 1]] >= precedence[token]
    ) {
      output.push(ops.pop()!);
    }
    ops.push(token);
    expectOperand = true;
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === "(") return null;
    output.push(op);
  }

  const stack: number[] = [];
  for (const token of output) {
    if (typeof token === "number") { stack.push(token); continue; }
    if (token === "u") {
      const value = stack.pop();
      if (value === undefined) return null;
      stack.push(-value);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return null;
    switch (token) {
      case "+": stack.push(a + b); break;
      case "-": stack.push(a - b); break;
      case "*": stack.push(a * b); break;
      case "/": stack.push(b === 0 ? NaN : a / b); break;
      case "%": stack.push(b === 0 ? NaN : a % b); break;
      case "^": stack.push(Math.pow(a, b)); break;
      default: return null;
    }
  }
  const result = stack.pop();
  if (result === undefined || !Number.isFinite(result)) return null;
  const rounded = Math.round(result * 1e10) / 1e10;
  return String(rounded);
}

type Action = { id: string; label: string; hint: string; run: () => void };

function buildActions(t: (key: string) => string): Action[] {
  return [
    {
      id: "settings",
      label: t("dockmenu.openSettings"),
      hint: "↵",
      run: () => invoke("open_settings_window").catch(() => {}),
    },
    {
      id: "taskmgr",
      label: t("dockmenu.taskManager"),
      hint: "↵",
      run: () => invoke("open_app", { appName: "taskmgr" }).catch(() => {}),
    },
    {
      id: "desktop",
      label: t("dockmenu.showDesktop"),
      hint: "↵",
      run: () => invoke("show_desktop").catch(() => {}),
    },
    {
      id: "restart",
      label: t("general.restart"),
      hint: "↵",
      run: () => invoke("restart_kiro").catch(() => {}),
    },
  ];
}

interface Props {
  scale: number;
  bottom: number;
  pinned: SearchApp[];
  running: SearchApp[];
  onClose: () => void;
  onLaunch: (app: SearchApp) => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

export function DockSearch({ scale, bottom, pinned, running, onClose, onLaunch, containerRef: externalRef }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<SearchApp[]>(() => loadInstalledApps().cached);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const ownRef = useRef<HTMLDivElement>(null);
  const containerRef = externalRef ?? ownRef;
  const listRef = useRef<HTMLDivElement>(null);

  // One backend call for the whole session, shared through the module cache.
  useEffect(() => {
    let alive = true;
    loadInstalledApps().ready.then((list) => {
      if (alive && list.length > 0) setApps(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    invoke("set_window_keyboard_focus", { enabled: true })
      .catch(() => {})
      .finally(() => inputRef.current?.focus());
    return () => {
      invoke("set_window_keyboard_focus", { enabled: false }).catch(() => {});
    };
  }, []);

  const actions = useMemo(() => buildActions(t), [t]);
  const math = useMemo(() => evaluateExpression(query), [query]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Empty box: recents first, then running apps, then a short list of
      // everything else. All of it comes from memory.
      const recents = readRecents();
      const byKey = new Map<string, SearchApp>();
      for (const app of [...pinned, ...running, ...apps]) byKey.set(recentKey(app), app);
      const out: SearchApp[] = [];
      const seen = new Set<string>();
      for (const key of recents) {
        const app = byKey.get(key);
        if (app && !seen.has(key)) { out.push(app); seen.add(key); }
        if (out.length >= 5) break;
      }
      for (const app of running) {
        const key = recentKey(app);
        if (!seen.has(key) && app.path !== "start") { out.push(app); seen.add(key); }
        if (out.length >= MAX_RESULTS) break;
      }
      if (out.length < MAX_RESULTS) {
        for (const app of apps) {
          const key = recentKey(app);
          if (!seen.has(key)) { out.push(app); seen.add(key); }
          if (out.length >= MAX_RESULTS) break;
        }
      }
      return out;
    }

    const scored: { app: SearchApp; s: number }[] = [];
    for (const app of apps) {
      const s = score(app.name.toLowerCase(), q);
      if (s > 0) scored.push({ app, s });
    }
    for (const app of [...running, ...pinned]) {
      if (scored.some((entry) => entry.app.path === app.path && entry.app.name === app.name)) continue;
      const s = score(app.name.toLowerCase(), q);
      if (s > 0) scored.push({ app, s: s + 5 });
    }
    scored.sort((a, b) => b.s - a.s || a.app.name.localeCompare(b.app.name));
    return scored.slice(0, MAX_RESULTS).map((entry) => entry.app);
  }, [apps, pinned, running, query]);

  // Actions match the query too, so "ayar" finds the settings entry.
  const actionResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return actions.filter((action) => action.label.toLowerCase().includes(q)).slice(0, 2);
  }, [actions, query]);

  const rowCount = results.length + (math ? 1 : 0) + actionResults.length;

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    setSelected((i) => Math.min(i, Math.max(0, rowCount - 1)));
  }, [rowCount]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector(`[data-row="${selected}"]`) as HTMLElement | null;
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Icons only for the rows on screen.
  useEffect(() => {
    let alive = true;
    const wanted = results.filter((app) => !icons[app.path]);
    if (wanted.length === 0) return;
    Promise.all(
      wanted.map(async (app) => {
        try {
          const icon = await invoke<string | null>("get_app_icon", { path: app.path });
          return [app.path, icon] as const;
        } catch {
          return [app.path, null] as const;
        }
      })
    ).then((pairs) => {
      if (!alive) return;
      const batch: Record<string, string> = {};
      for (const [path, icon] of pairs) if (icon) batch[path] = icon;
      if (Object.keys(batch).length > 0) setIcons((prev) => ({ ...prev, ...batch }));
    });
    return () => {
      alive = false;
    };
  }, [results, icons]);

  const copyMath = () => {
    if (!math) return;
    // navigator.clipboard needs a secure context; the Tauri webview usually is
    // one, but keep the execCommand path for the cases where it is not.
    const fallback = () => {
      try {
        const area = document.createElement("textarea");
        area.value = math;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } catch {
        /* nothing else to try */
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(math).catch(fallback);
    } else {
      fallback();
    }
    onClose();
  };

  const launch = (app: SearchApp) => {
    recordRecent(app);
    onLaunch(app);
    onClose();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, rowCount - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (math && selected === 0) {
          copyMath();
          return;
        }
        const appIndex = selected - (math ? 1 : 0);
        if (appIndex >= 0 && appIndex < results.length) {
          launch(results[appIndex]);
          return;
        }
        const action = actionResults[appIndex - results.length];
        if (action) {
          action.run();
          onClose();
        }
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // The magnifier toggles the panel itself; treating its click as an
      // outside click would close and instantly reopen the panel.
      if (target?.closest?.("[data-dock-search-trigger]")) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [actionResults, math, onClose, results, rowCount, selected]);

  const queryText = query.trim();
  const pathHint = (app: SearchApp) => {
    if (app.is_running) return t("dockmenu.running").toLowerCase();
    const lower = app.path.toLowerCase();
    if (lower.endsWith(".lnk")) return "shortcut";
    if (!lower.includes("\\")) return "app";
    return "";
  };

  return (
    <div className="add-popup-anchor" style={{ zoom: scale, bottom }}>
      <motion.div
        ref={containerRef}
        className="add-app-popup search-launcher"
        style={{ transformOrigin: "bottom center" }}
        initial={{ opacity: 0, y: 8, scaleY: 0.98 }}
        animate={{ opacity: 1, y: 0, scaleY: 1 }}
        exit={{ opacity: 0, y: 6, transition: { duration: 0.12, ease: "easeIn" } }}
        transition={{ duration: 0.14, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="popup-search-row">
          <svg className="popup-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="popup-search-input"
            placeholder={t("dock.search.placeholder")}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="search-launcher-key">esc</span>
          <button
            className="search-launcher-close"
            aria-label={t("window.close")}
            title={t("window.close")}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </div>

        <div className="popup-apps-scroll" ref={listRef}>
          {math && (
            <div
              data-row={0}
              className={`search-math-row${selected === 0 ? " selected" : ""}`}
              onMouseEnter={() => setSelected(0)}
              onClick={copyMath}
            >
              <span className="search-math-eq">=</span>
              <span className="search-math-value">{math}</span>
              <span className="search-math-hint">{t("dock.search.copy")}</span>
            </div>
          )}

          {results.map((app, index) => {
            const row = index + (math ? 1 : 0);
            const icon = icons[app.path];
            return (
              <div
                key={recentKey(app)}
                data-row={row}
                className={`popup-app-row${row === selected ? " selected" : ""}`}
                onMouseEnter={() => setSelected(row)}
                onClick={() => launch(app)}
              >
                <div className="popup-app-icon">
                  {icon ? (
                    <img src={icon} alt="" draggable={false} />
                  ) : (
                    <span className="popup-app-initial">{app.name[0] || "?"}</span>
                  )}
                </div>
                <span className="popup-app-name">{app.name}</span>
                <span className="search-row-hint">{pathHint(app)}</span>
              </div>
            );
          })}

          {actionResults.map((action, index) => {
            const row = results.length + index + (math ? 1 : 0);
            return (
              <div
                key={action.id}
                data-row={row}
                className={`popup-app-row search-action-row${row === selected ? " selected" : ""}`}
                onMouseEnter={() => setSelected(row)}
                onClick={() => {
                  action.run();
                  onClose();
                }}
              >
                <div className="popup-app-icon search-action-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
                <span className="popup-app-name">{action.label}</span>
                <span className="search-row-hint">{action.hint}</span>
              </div>
            );
          })}

          {!math && results.length === 0 && actionResults.length === 0 && (
            <div className="popup-empty">{queryText ? t("dockmenu.noResults") : t("dockmenu.emptyHint")}</div>
          )}
        </div>

        <div className="search-launcher-foot">
          <span>↑↓ {t("dock.search.navigate")}</span>
          <span>↵ {t("dock.search.open")}</span>
        </div>
      </motion.div>
    </div>
  );
}
