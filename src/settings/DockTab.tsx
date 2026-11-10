import { useEffect, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Monitor, Eye, EyeOff, BellDot, Square, Search, Shuffle, MonitorCheck, CalendarDays, Maximize2, Keyboard, Sparkles, RotateCcw, LayoutGrid, Trash2, HardDrive, ChevronUp, TextSearch, Settings, ListChecks, Power, Plus, X } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { SettingSection } from "./SettingSection";
import { Dropdown } from "./Dropdown";
import type { MonitorInfo, MonitorMode } from "./types";
import { usePerMonitor } from "./usePerMonitor";
import { useT } from "../i18n";
import { useKiroLogo } from "../kiroLogo";
import type { DockMenuShortcut } from "./useSettings";
import { HideDelay } from "./HideDelay";
import { PreviewDelay } from "./PreviewDelay";

const SEARCH_PROVIDERS = ["windows", "cmdpal", "ptrun", "raycast", "shortcut"];

const DOCK_MENU_ITEMS: { id: string; labelKey: string; icon: typeof Monitor }[] = [
  { id: "addApp", labelKey: "dockmenu.addApp", icon: Plus },
  { id: "calendar", labelKey: "dockmenu.openCalendar", icon: CalendarDays },
  { id: "settings", labelKey: "dockmenu.openSettings", icon: Settings },
  { id: "taskManager", labelKey: "dockmenu.taskManager", icon: ListChecks },
  { id: "restart", labelKey: "general.restart", icon: RotateCcw },
  { id: "clearIcons", labelKey: "dockmenu.clearIconCache", icon: Trash2 },
  { id: "quit", labelKey: "general.quit", icon: Power },
];

const SHORTCUT_MODIFIERS: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  win: "Win",
  windows: "Win",
  meta: "Win",
  super: "Win",
};
const NAMED_KEYS = ["Space", "Enter", "Tab", "Esc", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right"];

// Same grammar the dock's Rust side presses (launchers.rs): modifiers, then one key.
// Returns the tidied shortcut, "" for empty, or null if it can't be pressed.
function normalizeShortcut(text: string): string | null {
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const mods = new Set<string>();
  let key: string | null = null;
  for (const part of parts) {
    const mod = SHORTCUT_MODIFIERS[part.toLowerCase()];
    if (mod) {
      mods.add(mod);
      continue;
    }
    if (key) return null;
    if (/^[a-z0-9]$/i.test(part) || /^f([1-9]|1\d|2[0-4])$/i.test(part)) key = part.toUpperCase();
    else if (part.length === 1 && "`-=,./;'[]\\".includes(part)) key = part;
    else key = NAMED_KEYS.find((k) => k.toLowerCase() === part.toLowerCase()) ?? null;
    if (!key) return null;
  }
  if (!key) return null;
  return [...["Win", "Ctrl", "Alt", "Shift"].filter((m) => mods.has(m)), key].join("+");
}

function ShortcutField({ value, placeholder, onCommit }: { value: string; placeholder: string; onCommit: (shortcut: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const normalized = normalizeShortcut(draft);
  const commit = () => {
    if (normalized === null) return;
    setDraft(normalized);
    if (normalized !== value) onCommit(normalized);
  };
  return (
    <input
      className={`shortcut-input${normalized === null ? " invalid" : ""}`}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      spellCheck={false}
      aria-label={t("dock.searchShortcut")}
      title={normalized === null ? t("dock.searchShortcut.invalid") : undefined}
    />
  );
}

const START_ICON_PRESETS = [
  { key: "default", src: "/kiro.png?v=2", label: "Kiro" },
  { key: "windows", src: "/windows.svg", label: "Windows" },
];

const startIconTileStyle = (active: boolean): CSSProperties => ({
  width: "48px",
  height: "48px",
  borderRadius: "12px",
  border: active ? "2px solid var(--kiro-accent, #007aff)" : "2px solid rgba(255,255,255,0.1)",
  background: active ? "color-mix(in srgb, var(--kiro-accent, #007aff) 16%, transparent)" : "rgba(255,255,255,0.05)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  transition: "all 0.15s ease",
  padding: "6px",
  color: "rgba(255,255,255,0.5)",
});

interface DriveInfo {
  letter: string;
  label: string;
  removable: boolean;
}

interface DockTabProps {
  dockEnabled: boolean;
  toggleDock: () => void;
  dockMode: string;
  setDockModeValue: (mode: string) => void;
  dockPreviewEnabled: boolean;
  toggleDockPreview: () => void;
  dockAttentionEnabled: boolean;
  toggleDockAttention: () => void;
  dockSearchEnabled: boolean;
  toggleDockSearch: () => void;
  dockSearchNative: boolean;
  toggleDockSearchNative: () => void;
  dockSearchProvider: string;
  handleDockSearchProviderChange: (provider: string) => void;
  dockSearchShortcut: string;
  handleDockSearchShortcutChange: (shortcut: string) => void;
  dockCalendarEnabled: boolean;
  toggleDockCalendar: () => void;
  legacyMode: boolean;
  dockTray: boolean;
  toggleDockTray: () => void;
  dockNotepad: boolean;
  toggleDockNotepad: () => void;
  dockTaskView: boolean;
  toggleDockTaskView: () => void;
  dockShowDesktop: boolean;
  toggleDockShowDesktop: () => void;
  dockRecycle: boolean;
  toggleDockRecycle: () => void;
  dockDrives: string[];
  toggleDockDrive: (letter: string) => void;
  dockMenuHidden: string[];
  toggleDockMenuItem: (id: string) => void;
  dockMenuShortcuts: DockMenuShortcut[];
  addDockMenuShortcut: (label: string, path: string) => void;
  removeDockMenuShortcut: (id: string) => void;
  dockIconOnly: boolean;
  toggleDockIconOnly: () => void;
  dockAdaptive: boolean;
  toggleDockAdaptive: () => void;
  dockDesktopPersist: boolean;
  toggleDockDesktopPersist: () => void;
  startIcon: string;
  handleStartIconChange: (icon: string) => void;
  dockWinNumberEnabled: boolean;
  toggleDockWinNumber: () => void;
  dockMixedReorder: boolean;
  toggleDockMixedReorder: () => void;
  monitors: MonitorInfo[];
  dockMonitorMode: MonitorMode;
  setDockMonitorModeValue: (mode: MonitorMode) => void;
  dockMonitorId: string;
  setDockMonitorIdValue: (id: string) => void;
  dockModeByMonitor: Record<string, string>;
  setDockModeForMonitor: (monitorId: string, mode: string | null) => void;
  replaceDockModes: (next: Record<string, string>) => void;
}

export function DockTab({
  dockEnabled,
  toggleDock,
  dockMode,
  setDockModeValue,
  dockPreviewEnabled,
  toggleDockPreview,
  dockAttentionEnabled,
  toggleDockAttention,
  dockSearchEnabled,
  toggleDockSearch,
  dockSearchNative,
  toggleDockSearchNative,
  dockSearchProvider,
  handleDockSearchProviderChange,
  dockSearchShortcut,
  handleDockSearchShortcutChange,
  dockCalendarEnabled,
  toggleDockCalendar,
  legacyMode,
  dockTray,
  toggleDockTray,
  dockNotepad,
  toggleDockNotepad,
  dockTaskView,
  toggleDockTaskView,
  dockShowDesktop,
  toggleDockShowDesktop,
  dockRecycle,
  toggleDockRecycle,
  dockDrives,
  toggleDockDrive,
  dockMenuHidden,
  toggleDockMenuItem,
  dockMenuShortcuts,
  addDockMenuShortcut,
  removeDockMenuShortcut,
  dockIconOnly,
  toggleDockIconOnly,
  dockAdaptive,
  toggleDockAdaptive,
  dockDesktopPersist,
  toggleDockDesktopPersist,
  startIcon,
  handleStartIconChange,
  dockWinNumberEnabled,
  toggleDockWinNumber,
  dockMixedReorder,
  toggleDockMixedReorder,
  monitors,
  dockMonitorMode,
  setDockMonitorModeValue,
  dockMonitorId,
  setDockMonitorIdValue,
  dockModeByMonitor,
  setDockModeForMonitor,
  replaceDockModes,
}: DockTabProps) {
  const t = useT();
  // The "Kiro" tile previews whatever logo the user picked.
  const kiroLogo = useKiroLogo();
  const perMonitor = usePerMonitor(dockMode, dockModeByMonitor, replaceDockModes, monitors);
  const multiMonitor = dockMonitorMode === "all" && monitors.length > 1;
  const showPerMonitor = multiMonitor && perMonitor.enabled;
  const [drives, setDrives] = useState<DriveInfo[]>([]);

  const pickMenuShortcut = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: t("dock.menu.apps"), extensions: ["exe", "lnk", "bat", "cmd"] }],
      });
      if (typeof selected !== "string") return;
      const label = selected.split(/[\\/]/).pop()?.replace(/\.(exe|lnk|bat|cmd)$/i, "") || selected;
      addDockMenuShortcut(label, selected);
    } catch (e) {
      console.error("Could not add dock menu shortcut:", e);
    }
  };

  useEffect(() => {
    invoke<DriveInfo[]>("get_drives").then(setDrives).catch(() => {});
  }, []);

  const handleStartIconUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      handleStartIconChange(`custom:${reader.result as string}`);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <>
      <SettingSection id="dock-main" title={t("dock.group")} defaultOpen>
        <SettingRow icon={Monitor} label={t("dock.enable")} desc={t("dock.enable.desc")}>
          <label className="toggle-switch">
            <input type="checkbox" checked={dockEnabled} onChange={toggleDock} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {dockEnabled && (
          <>
            {!showPerMonitor && (
              <SettingRow
                icon={dockMode === "fixed" ? EyeOff : Eye}
                label={t("dock.behavior")}
                desc={t(`dock.behavior.${dockMode}.desc`)}
              >
                <Dropdown
                  value={dockMode}
                  onChange={setDockModeValue}
                  options={[
                    { value: "fixed", label: t("common.fixed") },
                    { value: "smart", label: t("common.smart") },
                    { value: "peek", label: t("common.peek") },
                  ]}
                />
              </SettingRow>
            )}

            {dockMode !== "fixed" && <HideDelay />}

            <SettingRow icon={MonitorCheck} label={t("common.showOn")} desc={t("dock.showOn.desc")}>
              <Dropdown
                value={dockMonitorMode}
                onChange={(v) => setDockMonitorModeValue(v as MonitorMode)}
                options={[
                  { value: "primary", label: t("common.monitors.primary") },
                  { value: "all", label: t("common.monitors.all") },
                  { value: "specific", label: t("common.monitors.specific") },
                ]}
              />
            </SettingRow>

            {dockMonitorMode === "specific" && (
              <SettingRow icon={Monitor} label={t("common.monitor")} desc={t("dock.monitor.desc")}>
                <Dropdown
                  value={dockMonitorId}
                  onChange={setDockMonitorIdValue}
                  placeholder={monitors.length === 0 ? t("common.loading") : undefined}
                  options={monitors.map((m) => ({
                    value: m.id,
                    label: `${m.label}${m.is_primary ? ` (${t("common.primary")})` : ""}`,
                  }))}
                />
              </SettingRow>
            )}

            {multiMonitor && (
              <SettingRow icon={Monitor} label={t("common.perMonitor")} desc={t("common.perMonitor.desc")}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={perMonitor.enabled} onChange={perMonitor.toggle} />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}

            {showPerMonitor && monitors.map((m) => (
              <SettingRow key={m.id} icon={Monitor} label={t("common.monitorBehavior", { name: m.label })} desc={m.is_primary ? t("common.primaryMonitor") : undefined}>
                <Dropdown
                  value={dockModeByMonitor[m.id] || dockMode}
                  onChange={(v) => setDockModeForMonitor(m.id, v)}
                  options={[
                    { value: "fixed", label: t("common.fixed") },
                    { value: "smart", label: t("common.smart") },
                    { value: "peek", label: t("common.peek") },
                  ]}
                />
              </SettingRow>
            ))}

          </>
        )}
      </SettingSection>

      {dockEnabled && (
        <>
          <SettingSection id="dock-shortcuts" title={t("dock.section.shortcuts")}>
            <SettingRow icon={Eye} label={t("dock.previews")} desc={t("dock.previews.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockPreviewEnabled} onChange={toggleDockPreview} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            {dockPreviewEnabled && <PreviewDelay />}

            {!legacyMode && (
              <SettingRow icon={BellDot} label={t("dock.attention")} desc={t("dock.attention.desc")}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={dockAttentionEnabled} onChange={toggleDockAttention} />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}

            <SettingRow icon={Search} label={t("dock.search")} desc={t("dock.search.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockSearchEnabled} onChange={toggleDockSearch} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            {dockSearchEnabled && (
              <SettingRow icon={Sparkles} label={t("dock.searchNative")} desc={t("dock.searchNative.desc")}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={dockSearchNative} onChange={toggleDockSearchNative} />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}

            {!legacyMode && dockSearchEnabled && !dockSearchNative && (
              <SettingRow
                icon={TextSearch}
                label={t("dock.searchWith")}
                desc={t(`dock.searchWith.${SEARCH_PROVIDERS.includes(dockSearchProvider) ? dockSearchProvider : "windows"}.desc`)}
              >
                <Dropdown
                  value={dockSearchProvider}
                  onChange={handleDockSearchProviderChange}
                  options={SEARCH_PROVIDERS.map((value) => ({ value, label: t(`dock.searchWith.${value}`) }))}
                />
              </SettingRow>
            )}

            {!legacyMode && dockSearchEnabled && !dockSearchNative && (dockSearchProvider === "raycast" || dockSearchProvider === "shortcut") && (
              <SettingRow
                icon={Keyboard}
                label={t("dock.searchShortcut")}
                desc={t(dockSearchProvider === "raycast" ? "dock.searchShortcut.descRaycast" : "dock.searchShortcut.desc")}
              >
                <ShortcutField
                  value={dockSearchShortcut}
                  placeholder={dockSearchProvider === "raycast" ? "Alt+Space" : t("dock.searchShortcut.placeholder")}
                  onCommit={handleDockSearchShortcutChange}
                />
              </SettingRow>
            )}

            <SettingRow icon={CalendarDays} label={t("dock.calendar")} desc={t("dock.calendar.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockCalendarEnabled} onChange={toggleDockCalendar} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            {!legacyMode && (
              <>
                <SettingRow icon={ChevronUp} label={t("dock.tray")} desc={t("dock.tray.desc")}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={dockTray} onChange={toggleDockTray} />
                    <span className="slider"></span>
                  </label>
                </SettingRow>

                <SettingRow icon={LayoutGrid} label={t("dock.notepad")} desc={t("dock.notepad.desc")}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={dockNotepad} onChange={toggleDockNotepad} />
                    <span className="slider"></span>
                  </label>
                </SettingRow>

                <SettingRow icon={LayoutGrid} label={t("dock.taskView")} desc={t("dock.taskView.desc")}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={dockTaskView} onChange={toggleDockTaskView} />
                    <span className="slider"></span>
                  </label>
                </SettingRow>

                <SettingRow icon={Monitor} label={t("dock.showDesktop")} desc={t("dock.showDesktop.desc")}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={dockShowDesktop} onChange={toggleDockShowDesktop} />
                    <span className="slider"></span>
                  </label>
                </SettingRow>

                <SettingRow icon={Trash2} label={t("dock.recycleBin")} desc={t("dock.recycleBin.desc")}>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={dockRecycle} onChange={toggleDockRecycle} />
                    <span className="slider"></span>
                  </label>
                </SettingRow>

                {drives.map((d) => (
                  <SettingRow
                    key={d.letter}
                    icon={HardDrive}
                    label={t("dock.drive", { letter: d.letter })}
                    desc={d.label ? `${d.label}${d.removable ? ` (${t("dock.drive.removableSuffix")})` : ""}` : d.removable ? t("dock.drive.removable") : t("dock.drive.local")}
                  >
                    <label className="toggle-switch">
                      <input type="checkbox" checked={dockDrives.includes(d.letter)} onChange={() => toggleDockDrive(d.letter)} />
                      <span className="slider"></span>
                    </label>
                  </SettingRow>
                ))}
              </>
            )}

          </SettingSection>

          <SettingSection id="dock-menu" title={t("dock.section.menu")}>
            <div className="setting-item" style={{ alignItems: "flex-start" }}>
              <div className="setting-info">
                <span className="setting-desc">{t("dock.menu.desc")}</span>
              </div>
            </div>

            {DOCK_MENU_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <SettingRow key={item.id} icon={Icon} label={t(item.labelKey)}>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={!dockMenuHidden.includes(item.id)}
                      onChange={() => toggleDockMenuItem(item.id)}
                    />
                    <span className="slider"></span>
                  </label>
                </SettingRow>
              );
            })}

            <SettingRow
              icon={Plus}
              label={t("dock.menu.shortcuts")}
              desc={t("dock.menu.shortcuts.desc")}
            >
              <button
                type="button"
                onClick={pickMenuShortcut}
                style={{
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.06)",
                  color: "inherit",
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {t("dock.menu.add")}
              </button>
            </SettingRow>

            {dockMenuShortcuts.length === 0 ? (
              <div className="setting-item">
                <div className="setting-info">
                  <span className="setting-desc">{t("dock.menu.empty")}</span>
                </div>
              </div>
            ) : (
              dockMenuShortcuts.map((shortcut) => (
                <SettingRow key={shortcut.id} icon={LayoutGrid} label={shortcut.label} desc={shortcut.path}>
                  <button
                    type="button"
                    onClick={() => removeDockMenuShortcut(shortcut.id)}
                    title={t("dock.menu.remove")}
                    style={{
                      width: 26,
                      height: 26,
                      display: "grid",
                      placeItems: "center",
                      border: "1px solid rgba(255,255,255,0.14)",
                      background: "rgba(255,255,255,0.04)",
                      color: "inherit",
                      borderRadius: 7,
                      cursor: "pointer",
                    }}
                  >
                    <X size={13} />
                  </button>
                </SettingRow>
              ))
            )}
          </SettingSection>

          <SettingSection id="dock-style" title={t("dock.section.style")}>
            <SettingRow icon={Square} label={t("dock.iconOnly")} desc={t("dock.iconOnly.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockIconOnly} onChange={toggleDockIconOnly} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <SettingRow icon={Keyboard} label={t("dock.winNumber")} desc={t("dock.winNumber.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockWinNumberEnabled} onChange={toggleDockWinNumber} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            {dockMode === "fixed" && (
              <SettingRow icon={Maximize2} label={t("dock.adaptive")} desc={t("dock.adaptive.desc")}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={dockAdaptive} onChange={toggleDockAdaptive} />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}

            <SettingRow icon={MonitorCheck} label={t("dock.desktopPersist")} desc={t("dock.desktopPersist.desc")}>
              <label className="toggle-switch">
                <input type="checkbox" checked={dockDesktopPersist} onChange={toggleDockDesktopPersist} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <SettingRow
              icon={Shuffle}
              label={t("dock.mixed")}
              desc={dockMixedReorder ? t("dock.mixed.on") : t("dock.mixed.off")}
            >
              <label className="toggle-switch">
                <input type="checkbox" checked={dockMixedReorder} onChange={toggleDockMixedReorder} />
                <span className="slider"></span>
              </label>
            </SettingRow>

            <div className="setting-item" style={{ flexDirection: "column", alignItems: "flex-start", gap: "10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%" }}>
                <div className="setting-icon-bg">
                  <Sparkles size={14} strokeWidth={1.5} />
                </div>
                <div className="setting-info">
                  <span className="setting-label">{t("dock.startIcon")}</span>
                  <span className="setting-desc">{t("dock.startIcon.desc")}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", paddingLeft: "34px" }}>
                {START_ICON_PRESETS.map((icon) => (
                  <div
                    key={icon.key}
                    onClick={() => handleStartIconChange(icon.key)}
                    style={startIconTileStyle(startIcon === icon.key)}
                    title={icon.label}
                  >
                    <img src={icon.key === "default" ? kiroLogo : icon.src} alt={icon.label} style={{ width: "100%", height: "100%", objectFit: "contain" }} draggable={false} />
                  </div>
                ))}
                <div
                  onClick={() => document.getElementById("start-icon-file-input")?.click()}
                  style={startIconTileStyle(startIcon.startsWith("custom:"))}
                  title={t("dock.startIcon.custom")}
                >
                  {startIcon.startsWith("custom:") ? (
                    <img
                      src={startIcon.replace("custom:", "")}
                      alt={t("dock.startIcon.customAlt")}
                      style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "8px" }}
                      draggable={false}
                    />
                  ) : (
                    <span style={{ fontSize: "20px" }}>+</span>
                  )}
                </div>
                {startIcon !== "default" && (
                  <div onClick={() => handleStartIconChange("default")} style={startIconTileStyle(false)} title={t("dock.startIcon.reset")}>
                    <RotateCcw size={18} strokeWidth={1.5} />
                  </div>
                )}
              </div>
              <input
                id="start-icon-file-input"
                type="file"
                accept=".png,.ico,.jpg,.jpeg,.svg,.bmp"
                style={{ display: "none" }}
                onChange={handleStartIconUpload}
              />
            </div>
          </SettingSection>
        </>
      )}
    </>
  );
}
