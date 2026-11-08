import { useState, useEffect, useCallback } from "react";
import { parseCcLayout, parsePanelOrder, type CcLayout, type PanelId } from "../panelOrder";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import type { UpdateCheckResult } from "../updater";
import { useSettingsSync } from "../hooks/useSettingsSync";
import { hexToHsl, DEFAULT_ACCENT_COLOR, STYLE_OPACITY, type ThemePreset } from "../theme";
import { DEFAULT_DUAL_CLOCK_ZONE } from "../dualClock";
import type { WidgetConfig, MonitorInfo, MonitorMode } from "./types";
import { hydrateStorageFromSettings } from "../migrate";

function saveSetting(key: string, value: string) {
  localStorage.setItem(key, value);
  invoke("save_setting", { key, value }).catch(console.error);
}

function readBool(val: string | null): boolean {
  return val === "true";
}

function parseDrives(val: string | null): string[] {
  try {
    const parsed = JSON.parse(val ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

export function useSettings() {
  const [autostart, setAutostart] = useState(false);
  const [weatherEnabled, setWeatherEnabled] = useState(true);
  const [calendarEnabled, setCalendarEnabled] = useState(true);
  const [timerEnabled, setTimerEnabled] = useState(true);
  const [timerSoundEnabled, setTimerSoundEnabled] = useState(true);
  const [notchTimerProgress, setNotchTimerProgress] = useState(
    () => localStorage.getItem("kiro-notch-timer-progress") !== "false"
  );
  const [stopwatchEnabled, setStopwatchEnabled] = useState(true);
  const [dualClockEnabled, setDualClockEnabled] = useState(
    () => localStorage.getItem("kiro-dual-clock-enabled") === "true"
  );
  const [dualClockZone, setDualClockZone] = useState(
    () => localStorage.getItem("kiro-dual-clock-zone") || DEFAULT_DUAL_CLOCK_ZONE
  );
  const [dualClockLabel, setDualClockLabel] = useState(
    () => localStorage.getItem("kiro-dual-clock-label") || DEFAULT_DUAL_CLOCK_ZONE
  );
  const [musicModeEnabled, setMusicModeEnabled] = useState(true);
  const [musicCompactNotch, setMusicCompactNotch] = useState(true);
  const [agentApi, setAgentApi] = useState(() => localStorage.getItem("kiro-agent-api") === "true");
  const [notchScrollVolume, setNotchScrollVolume] = useState(
    () => localStorage.getItem("kiro-notch-scroll-volume") === "true"
  );
  const [rememberMode, setRememberMode] = useState(
    () => localStorage.getItem("kiro-notch-remember-mode") === "true"
  );
  const [shelfPersist, setShelfPersist] = useState(
    () => localStorage.getItem("kiro-shelf-persist") === "true"
  );
  const [volumeOverlayEnabled, setVolumeOverlayEnabled] = useState(true);
  const [volumeEdgeEnabled, setVolumeEdgeEnabled] = useState(
    () => localStorage.getItem("kiro-volume-edge-enabled") !== "false"
  );
  const [brightnessOverlayEnabled, setBrightnessOverlayEnabled] = useState(
    () => localStorage.getItem("kiro-brightness-overlay-enabled") !== "false"
  );
  const [brightnessEdgeEnabled, setBrightnessEdgeEnabled] = useState(
    () => localStorage.getItem("kiro-brightness-edge-enabled") !== "false"
  );
  const [mediaAmbienceEnabled, setMediaAmbienceEnabled] = useState(true);
  const [mediaCompactGlowEnabled, setMediaCompactGlowEnabled] = useState(true);
  const [mediaArtworkThemeEnabled, setMediaArtworkThemeEnabled] = useState(
    () => localStorage.getItem("kiro-media-artwork-theme") === "true"
  );
  const [mediaLayout, setMediaLayout] = useState<"classic" | "compact">(
    () => (localStorage.getItem("kiro-media-layout") as "classic" | "compact") || "classic"
  );
  const [cornersEnabled, setCornersEnabled] = useState(
    () => localStorage.getItem("kiro-corners-enabled") === "true"
  );
  const [showUpdateIndicator, setShowUpdateIndicator] = useState(
    () => localStorage.getItem("kiro-show-update-indicator") !== "false"
  );
  const [timeFormat24h, setTimeFormat24h] = useState(
    () => localStorage.getItem("kiro-time-format-24h") !== "false"
  );
  const [legacyMode, setLegacyMode] = useState(
    () => localStorage.getItem("kiro-legacy-mode") === "true"
  );
  const [ramSaver, setRamSaver] = useState(
    () => localStorage.getItem("kiro-ram-saver") !== "false"
  );
  const [autoPerf, setAutoPerf] = useState(
    () => localStorage.getItem("kiro-auto-perf") !== "false"
  );
  const [gameBoost, setGameBoost] = useState(
    () => localStorage.getItem("kiro-game-boost") !== "false"
  );
  const [fpsBoost, setFpsBoost] = useState(
    () => localStorage.getItem("kiro-fps-boost") !== "false"
  );
  const [ramUltra, setRamUltra] = useState(
    () => localStorage.getItem("kiro-ram-ultra") === "true"
  );
  const [tempUnitFahrenheit, setTempUnitFahrenheit] = useState(false);
  const [cityName, setCityName] = useState("");
  const [cityQuery, setCityQuery] = useState("");
  const [citySearchResults, setCitySearchResults] = useState<
    Array<{ name: string; country: string; latitude: number; longitude: number }>
  >([]);
  const [showCityDropdown, setShowCityDropdown] = useState(false);
  const [statusWidgets, setStatusWidgets] = useState<WidgetConfig>({
    left: ["weather"],
    right: ["battery"],
  });
  const [dockEnabled, setDockEnabled] = useState(true);
  const [dockPreviewEnabled, setDockPreviewEnabled] = useState(true);
  const [dockAttentionEnabled, setDockAttentionEnabled] = useState(true);
  const [dockSearchEnabled, setDockSearchEnabled] = useState(true);
  // Kiro's own launcher is the default; the provider rows below only apply
  // when it is switched off.
  const [dockSearchNative, setDockSearchNative] = useState(
    () => localStorage.getItem("kiro-dock-search-native") !== "false"
  );
  const [dockSearchProvider, setDockSearchProvider] = useState(
    () => localStorage.getItem("kiro-dock-search-provider") || "windows"
  );
  const [dockSearchShortcut, setDockSearchShortcut] = useState(
    () => localStorage.getItem("kiro-dock-search-shortcut") || ""
  );
  const [dockCalendarEnabled, setDockCalendarEnabled] = useState(true);
  const [dockTray, setDockTray] = useState(
    () => localStorage.getItem("kiro-dock-tray-enabled") !== "false"
  );
  const [dockShowDesktop, setDockShowDesktop] = useState(
    () => localStorage.getItem("kiro-dock-show-desktop-corner") === "true"
  );
  const [panelControlCenter, setPanelControlCenter] = useState(
    () => localStorage.getItem("kiro-panel-control-center-enabled") !== "false"
  );
  const [panelOrder, setPanelOrder] = useState<PanelId[] | null>(
    () => parsePanelOrder(localStorage.getItem("kiro-panel-order"))
  );
  const [ccLayout, setCcLayout] = useState<CcLayout>(
    () => parseCcLayout(localStorage.getItem("kiro-cc-layout"))
  );
  const [panelShelf, setPanelShelf] = useState(
    () => localStorage.getItem("kiro-panel-shelf-enabled") !== "false"
  );
  const [dockTaskView, setDockTaskView] = useState(
    () => localStorage.getItem("kiro-dock-taskview-enabled") === "true"
  );
  const [dockRecycle, setDockRecycle] = useState(
    () => localStorage.getItem("kiro-dock-recycle-enabled") === "true"
  );
  const [dockDrives, setDockDrives] = useState<string[]>(() => parseDrives(localStorage.getItem("kiro-dock-drives")));
  const [dockIconOnly, setDockIconOnly] = useState(
    () => localStorage.getItem("kiro-dock-icon-only") === "true"
  );
  const [startIcon, setStartIcon] = useState(
    () => localStorage.getItem("kiro-start-icon") || "default"
  );
  const [dockAdaptive, setDockAdaptive] = useState(
    () => localStorage.getItem("kiro-dock-adaptive") === "true"
  );
  const [dockDesktopPersist, setDockDesktopPersist] = useState(
    () => localStorage.getItem("kiro-dock-desktop-persist") !== "false"
  );
  const [notchPosition, setNotchPosition] = useState(
    () => localStorage.getItem("kiro-notch-position") || "bottom-right"
  );
  const [dockWinNumberEnabled, setDockWinNumberEnabled] = useState(
    () => localStorage.getItem("kiro-dock-win-number-enabled") !== "false"
  );
  const [dockMixedReorder, setDockMixedReorder] = useState(
    () => localStorage.getItem("kiro-dock-mixed-reorder") === "true"
  );
  const [dockMode, setDockMode] = useState(() => {
    const raw = localStorage.getItem("kiro-dock-mode") || "smart";
    return raw === "auto-hide" ? "smart" : raw;
  });
  const [notchMode, setNotchMode] = useState("fixed");
  const [dockMonitorMode, setDockMonitorMode] = useState<MonitorMode>(
    () => (localStorage.getItem("kiro-dock-monitor-mode") as MonitorMode) || "primary"
  );
  const [dockMonitorId, setDockMonitorId] = useState(
    () => localStorage.getItem("kiro-dock-monitor-id") || ""
  );
  const [notchMonitorMode, setNotchMonitorMode] = useState<MonitorMode>(
    () => (localStorage.getItem("kiro-notch-monitor-mode") as MonitorMode) || "primary"
  );
  const [notchMonitorId, setNotchMonitorId] = useState(
    () => localStorage.getItem("kiro-notch-monitor-id") || ""
  );
  const [dockModeByMonitor, setDockModeByMonitor] = useState<Record<string, string>>({});
  const [notchModeByMonitor, setNotchModeByMonitor] = useState<Record<string, string>>({});
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [lowBatteryThreshold, setLowBatteryThreshold] = useState(20);
  const [hasBattery, setHasBattery] = useState(() => localStorage.getItem("kiro-has-battery") !== "false");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "uptodate" | "error" | "downloading" | "installing"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [autoUpdate, setAutoUpdate] = useState(
    () => localStorage.getItem("kiro-auto-update") !== "false"
  );
  const [prereleaseChannel, setPrereleaseChannel] = useState(
    () => localStorage.getItem("kiro-update-channel") === "prerelease"
  );
  const [scale, setScale] = useState(
    () => parseFloat(localStorage.getItem("kiro-scale") || "1.0")
  );
  const [themeMode, setThemeMode] = useState(
    () => localStorage.getItem("kiro-theme-mode") || "dark"
  );
  const [themeColor, setThemeColor] = useState(
    () => localStorage.getItem("kiro-theme-color") || "#007aff"
  );
  const [themeOpacity, setThemeOpacity] = useState(() => {
    const val = localStorage.getItem("kiro-theme-opacity");
    return val !== null ? parseFloat(val) : 0.8;
  });
  const [themeSaturation, setThemeSaturation] = useState(() => {
    const val = localStorage.getItem("kiro-theme-saturation");
    return val !== null ? parseFloat(val) : 0.5;
  });
  const [themeBrightness, setThemeBrightness] = useState(() => {
    const val = localStorage.getItem("kiro-theme-brightness");
    return val !== null ? parseFloat(val) : 0.15;
  });
  const [themeStyle, setThemeStyle] = useState(() => localStorage.getItem("kiro-theme-style") || "solid");
  const [themeAccent, setThemeAccent] = useState(() => localStorage.getItem("kiro-theme-accent") || "mono");
  const [themeAccentColor, setThemeAccentColor] = useState(
    () => localStorage.getItem("kiro-theme-accent-color") || DEFAULT_ACCENT_COLOR
  );
  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "success" | "error">("idle");
  const [importStatus, setImportStatus] = useState<"idle" | "importing" | "success" | "error">("idle");
  const [resetStatus, setResetStatus] = useState<"idle" | "confirm" | "resetting">("idle");
  const [uninstallStatus, setUninstallStatus] = useState<"idle" | "confirm" | "uninstalling" | "error">("idle");
  const [uninstallError, setUninstallError] = useState("");

  // ── Load all settings from backend + localStorage ──
  const loadAllSettings = useCallback(async () => {
    try {
      const settings: Record<string, string> = await invoke("load_settings");
      hydrateStorageFromSettings(settings);
      const getVal = (key: string) => {
        const val = settings[key];
        if (val !== undefined && val !== null) return String(val);
        return localStorage.getItem(key);
      };

      const apply = <T>(val: string | null, setter: (v: T) => void, transform: (v: string) => T) => {
        if (val !== null) setter(transform(val));
      };

      apply(getVal("kiro-weather-enabled"), setWeatherEnabled, readBool);
      apply(getVal("kiro-calendar-enabled"), setCalendarEnabled, readBool);
      apply(getVal("kiro-timer-enabled") ?? getVal("kiro-calendar-enabled"), setTimerEnabled, readBool);
      apply(getVal("kiro-timer-sound-enabled"), setTimerSoundEnabled, readBool);
      apply(getVal("kiro-notch-timer-progress"), setNotchTimerProgress, readBool);
      apply(getVal("kiro-stopwatch-enabled") ?? getVal("kiro-calendar-enabled"), setStopwatchEnabled, readBool);
      apply(getVal("kiro-dual-clock-enabled"), setDualClockEnabled, readBool);
      apply(getVal("kiro-dual-clock-zone"), setDualClockZone, (v) => v);
      apply(getVal("kiro-dual-clock-label"), setDualClockLabel, (v) => v);
      apply(getVal("kiro-music-mode-enabled"), setMusicModeEnabled, readBool);
      apply(getVal("kiro-music-compact-notch"), setMusicCompactNotch, readBool);
      apply(getVal("kiro-notch-scroll-volume"), setNotchScrollVolume, (v) => v === "true");
      apply(getVal("kiro-agent-api"), setAgentApi, (v) => v === "true");
      apply(getVal("kiro-shelf-persist"), setShelfPersist, (v) => v === "true");
      apply(getVal("kiro-notch-remember-mode"), setRememberMode, (v) => v === "true");
      apply(getVal("kiro-volume-overlay-enabled"), setVolumeOverlayEnabled, readBool);
      apply(getVal("kiro-brightness-overlay-enabled"), setBrightnessOverlayEnabled, readBool);
      apply(getVal("kiro-media-ambience-enabled"), setMediaAmbienceEnabled, readBool);
      apply(getVal("kiro-media-compact-glow-enabled"), setMediaCompactGlowEnabled, readBool);
      apply(getVal("kiro-media-artwork-theme"), setMediaArtworkThemeEnabled, (v) => v === "true");
      apply(getVal("kiro-corners-enabled"), setCornersEnabled, readBool);
      apply(getVal("kiro-time-format-24h"), setTimeFormat24h, readBool);
      apply(getVal("kiro-legacy-mode"), setLegacyMode, readBool);
      apply(getVal("kiro-show-update-indicator"), setShowUpdateIndicator, readBool);
      apply(getVal("kiro-ram-saver"), setRamSaver, (v) => v !== "false");
      apply(getVal("kiro-auto-perf"), setAutoPerf, (v) => v !== "false");
      apply(getVal("kiro-game-boost"), setGameBoost, (v) => v !== "false");
      apply(getVal("kiro-fps-boost"), setFpsBoost, (v) => v !== "false");
      apply(getVal("kiro-ram-ultra"), setRamUltra, readBool);
      apply(getVal("kiro-auto-update"), setAutoUpdate, readBool);
      apply(getVal("kiro-update-channel"), setPrereleaseChannel, (v) => v === "prerelease");
      apply(getVal("kiro-volume-edge-enabled"), setVolumeEdgeEnabled, readBool);
      apply(getVal("kiro-brightness-edge-enabled"), setBrightnessEdgeEnabled, readBool);
      apply(getVal("kiro-dock-enabled"), setDockEnabled, readBool);
      apply(getVal("kiro-dock-preview-enabled"), setDockPreviewEnabled, readBool);
      apply(getVal("kiro-dock-attention-enabled"), setDockAttentionEnabled, (v) => v !== "false");
      apply(getVal("kiro-dock-search-enabled"), setDockSearchEnabled, readBool);
      apply(getVal("kiro-dock-search-native"), setDockSearchNative, (v) => v !== "false");
      apply(getVal("kiro-dock-search-provider"), setDockSearchProvider, (v) => v);
      apply(getVal("kiro-dock-search-shortcut"), setDockSearchShortcut, (v) => v);
      apply(getVal("kiro-dock-calendar-enabled"), setDockCalendarEnabled, readBool);
      apply(getVal("kiro-dock-tray-enabled"), setDockTray, (v) => v !== "false");
      apply(getVal("kiro-dock-taskview-enabled"), setDockTaskView, readBool);
      apply(getVal("kiro-dock-show-desktop-corner"), setDockShowDesktop, readBool);
      apply(getVal("kiro-panel-control-center-enabled"), setPanelControlCenter, (v) => v !== "false");
      apply(getVal("kiro-panel-shelf-enabled"), setPanelShelf, (v) => v !== "false");
      apply(getVal("kiro-panel-order"), setPanelOrder, (v) => parsePanelOrder(v));
      apply(getVal("kiro-cc-layout"), setCcLayout, (v) => parseCcLayout(v));
      apply(getVal("kiro-dock-recycle-enabled"), setDockRecycle, readBool);
      apply(getVal("kiro-dock-drives"), setDockDrives, parseDrives);
      apply(getVal("kiro-dock-icon-only"), setDockIconOnly, readBool);
      apply(getVal("kiro-start-icon"), setStartIcon, (v) => v);
      apply(getVal("kiro-dock-adaptive"), setDockAdaptive, readBool);
      apply(getVal("kiro-dock-desktop-persist"), setDockDesktopPersist, (v) => v !== "false");
      apply(getVal("kiro-notch-position"), setNotchPosition, (v) => (v === "bottom-right" ? "bottom-right" : "top"));
      apply(getVal("kiro-dock-win-number-enabled"), setDockWinNumberEnabled, readBool);
      apply(getVal("kiro-dock-mixed-reorder"), setDockMixedReorder, readBool);

      apply(getVal("kiro-temp-unit"), setTempUnitFahrenheit, (v) => v === "fahrenheit");
      apply(getVal("kiro-scale"), setScale, parseFloat);
      apply(getVal("kiro-low-battery-threshold"), setLowBatteryThreshold, parseInt);

      apply(getVal("kiro-notch-mode"), setNotchMode, (v) => (v === "auto-hide" ? "smart" : v));
      apply(getVal("kiro-dock-mode"), setDockMode, (v) => (v === "auto-hide" ? "smart" : v));

      apply(getVal("kiro-dock-monitor-mode"), setDockMonitorMode, (v) => v as MonitorMode);
      apply(getVal("kiro-dock-monitor-id"), setDockMonitorId, (v) => v);
      apply(getVal("kiro-notch-monitor-mode"), setNotchMonitorMode, (v) => v as MonitorMode);
      apply(getVal("kiro-notch-monitor-id"), setNotchMonitorId, (v) => v);

      const dockByMonVal = getVal("kiro-dock-mode-by-monitor");
      if (dockByMonVal) {
        try { setDockModeByMonitor(JSON.parse(dockByMonVal)); } catch {}
      }
      const notchByMonVal = getVal("kiro-notch-mode-by-monitor");
      if (notchByMonVal) {
        try { setNotchModeByMonitor(JSON.parse(notchByMonVal)); } catch {}
      }

      const savedCity = getVal("kiro-weather-city");
      if (savedCity) {
        setCityName(savedCity);
        setCityQuery(savedCity);
      }

      apply(getVal("kiro-theme-mode"), setThemeMode, (v) => v);
      apply(getVal("kiro-theme-color"), setThemeColor, (v) => v);
      apply(getVal("kiro-theme-opacity"), setThemeOpacity, parseFloat);
      apply(getVal("kiro-theme-saturation"), setThemeSaturation, parseFloat);
      apply(getVal("kiro-theme-brightness"), setThemeBrightness, parseFloat);
      apply(getVal("kiro-theme-style"), setThemeStyle, (v) => v);
      apply(getVal("kiro-theme-accent"), setThemeAccent, (v) => v);
      apply(getVal("kiro-theme-accent-color"), setThemeAccentColor, (v) => v);

      const widgetsVal = getVal("kiro-status-widgets");
      if (widgetsVal) {
        try {
          const parsed = JSON.parse(widgetsVal);
          if (parsed && Array.isArray(parsed.left) && Array.isArray(parsed.right)) {
            setStatusWidgets(parsed);
          }
        } catch {}
      }
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  }, []);

  // ── Initialize on mount ──
  useEffect(() => {
    loadAllSettings();

    isEnabled()
      .then(setAutostart)
      .catch(() => {});

    getVersion()
      .then((ver) => setAppVersion(ver))
      .catch(() => setAppVersion(""));

    invoke<boolean>("has_battery").then((present) => {
      setHasBattery(present);
      localStorage.setItem("kiro-has-battery", String(present));
    }).catch(() => {});

    checkForUpdates(false);
  }, []);

  useEffect(() => {
    const refreshMonitors = () => {
      invoke<MonitorInfo[]>("get_monitors").then(setMonitors).catch(() => {});
    };
    refreshMonitors();
    const unlisten = listen("monitors-changed", refreshMonitors);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // ── Sync settings from other windows ──
  useSettingsSync({
    "kiro-dock-mode": setDockMode,
    "kiro-notch-mode": setNotchMode,
    "kiro-dock-monitor-mode": (v) => setDockMonitorMode(v as MonitorMode),
    "kiro-dock-monitor-id": setDockMonitorId,
    "kiro-notch-monitor-mode": (v) => setNotchMonitorMode(v as MonitorMode),
    "kiro-notch-monitor-id": setNotchMonitorId,
    "kiro-dock-mode-by-monitor": (v) => { try { setDockModeByMonitor(JSON.parse(v)); } catch {} },
    "kiro-notch-mode-by-monitor": (v) => { try { setNotchModeByMonitor(JSON.parse(v)); } catch {} },
    "kiro-dock-enabled": setDockEnabled,
    "kiro-dock-tray-enabled": (v) => setDockTray(v !== false && v !== "false"),
    "kiro-dock-taskview-enabled": setDockTaskView,
    "kiro-dock-show-desktop-corner": setDockShowDesktop,
    "kiro-panel-control-center-enabled": (v) => setPanelControlCenter(v !== false && v !== "false"),
    "kiro-panel-shelf-enabled": (v) => setPanelShelf(v !== false && v !== "false"),
    "kiro-panel-order": (v) => setPanelOrder(parsePanelOrder(v === null ? null : String(v))),
    "kiro-cc-layout": (v) => setCcLayout(parseCcLayout(v === null ? null : String(v))),
    "kiro-dock-recycle-enabled": setDockRecycle,
    "kiro-dock-drives": (v) => setDockDrives(parseDrives(v)),
    "kiro-dock-icon-only": setDockIconOnly,
    "kiro-start-icon": setStartIcon,
    "kiro-dock-adaptive": setDockAdaptive,
    "kiro-dock-desktop-persist": (v) => setDockDesktopPersist(v !== false && v !== "false"),
    "kiro-notch-position": (v) => setNotchPosition(v === "bottom-right" ? "bottom-right" : "top"),
    "kiro-dock-win-number-enabled": setDockWinNumberEnabled,
    "kiro-dock-preview-enabled": setDockPreviewEnabled,
    "kiro-dock-attention-enabled": (v) => setDockAttentionEnabled(v !== false && v !== "false"),
    "kiro-dock-search-enabled": setDockSearchEnabled,
    "kiro-dock-search-provider": (v) => setDockSearchProvider(String(v)),
    "kiro-dock-search-shortcut": (v) => setDockSearchShortcut(String(v)),
    "kiro-dock-calendar-enabled": setDockCalendarEnabled,
    "kiro-dock-mixed-reorder": setDockMixedReorder,
    "kiro-weather-enabled": setWeatherEnabled,
    "kiro-calendar-enabled": setCalendarEnabled,
    "kiro-timer-enabled": setTimerEnabled,
    "kiro-timer-sound-enabled": setTimerSoundEnabled,
    "kiro-notch-timer-progress": setNotchTimerProgress,
    "kiro-stopwatch-enabled": setStopwatchEnabled,
    "kiro-dual-clock-enabled": setDualClockEnabled,
    "kiro-dual-clock-zone": (v) => setDualClockZone(String(v)),
    "kiro-dual-clock-label": (v) => setDualClockLabel(String(v)),
    "kiro-music-mode-enabled": setMusicModeEnabled,
    "kiro-music-compact-notch": setMusicCompactNotch,
    "kiro-notch-scroll-volume": setNotchScrollVolume,
    "kiro-agent-api": setAgentApi,
    "kiro-shelf-persist": setShelfPersist,
    "kiro-notch-remember-mode": setRememberMode,
    "kiro-media-ambience-enabled": setMediaAmbienceEnabled,
    "kiro-media-compact-glow-enabled": setMediaCompactGlowEnabled,
    "kiro-media-artwork-theme": setMediaArtworkThemeEnabled,
    "kiro-media-layout": setMediaLayout,
    "kiro-corners-enabled": setCornersEnabled,
    "kiro-show-update-indicator": setShowUpdateIndicator,
    "kiro-time-format-24h": setTimeFormat24h,
    "kiro-legacy-mode": setLegacyMode,
    "kiro-ram-saver": (v) => setRamSaver(v !== false && v !== "false"),
    "kiro-ram-ultra": (v) => setRamUltra(v === true || v === "true"),
    "kiro-auto-perf": (v) => setAutoPerf(v !== false && v !== "false"),
    "kiro-game-boost": (v) => setGameBoost(v !== false && v !== "false"),
    "kiro-fps-boost": (v) => setFpsBoost(v !== false && v !== "false"),
    "kiro-low-battery-threshold": setLowBatteryThreshold,
    "kiro-scale": setScale,
    "kiro-temp-unit": (v) => setTempUnitFahrenheit(v === "fahrenheit"),
    "kiro-auto-update": setAutoUpdate,
    "kiro-update-channel": (v) => setPrereleaseChannel(v === "prerelease"),
    "kiro-volume-overlay-enabled": setVolumeOverlayEnabled,
    "kiro-volume-edge-enabled": setVolumeEdgeEnabled,
    "kiro-brightness-overlay-enabled": setBrightnessOverlayEnabled,
    "kiro-brightness-edge-enabled": setBrightnessEdgeEnabled,
    "kiro-theme-mode": setThemeMode,
    "kiro-theme-color": setThemeColor,
    "kiro-theme-opacity": setThemeOpacity,
    "kiro-theme-saturation": setThemeSaturation,
    "kiro-theme-brightness": setThemeBrightness,
    "kiro-theme-style": (v) => setThemeStyle(String(v)),
    "kiro-theme-accent": (v) => setThemeAccent(String(v)),
    "kiro-theme-accent-color": (v) => setThemeAccentColor(String(v)),
    "kiro-weather-city": (v) => {
      setCityName(v || "");
      setCityQuery(v || "");
    },
  });

  // ── Listen for system accent changes (adaptive theme) ──
  useEffect(() => {
    const unlisten = listen<string>("system-accent-changed", (event) => {
      const mode = localStorage.getItem("kiro-theme-mode") || "dark";
      if (mode === "adaptive") {
        try {
          const hsl = hexToHsl(event.payload);
          setThemeSaturation(hsl.s / 100);
          setThemeBrightness(hsl.l / 100);
        } catch (e) {
          console.error("Failed to parse system accent color change HSL:", e);
        }
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // ── City search debounce ──
  useEffect(() => {
    if (cityQuery.trim().length < 2 || cityQuery === cityName) {
      setCitySearchResults([]);
      setShowCityDropdown(false);
      return;
    }

    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityQuery)}&count=5&language=en&format=json`
        );
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          setCitySearchResults(
            data.results.map((r: any) => ({
              name: r.name,
              country: r.country || "",
              latitude: r.latitude,
              longitude: r.longitude,
            }))
          );
          setShowCityDropdown(true);
        } else {
          setCitySearchResults([]);
        }
      } catch {
        setCitySearchResults([]);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [cityQuery, cityName]);

  // ── Update checker ──
  const checkForUpdates = async (manual = true) => {
    setUpdateStatus("checking");
    try {
      const result = await invoke<UpdateCheckResult>("check_for_updates", { force: manual });
      if (result.available) {
        setUpdateStatus("available");
        setUpdateVersion(result.version ?? "");
      } else {
        setUpdateStatus("uptodate");
      }
    } catch (e) {
      console.error("Updater error:", e);
      setUpdateStatus("error");
    }
  };

  const installUpdate = async () => {
    try {
      setUpdateStatus("downloading");
      await invoke("install_update");
      setUpdateStatus("idle");
    } catch (e) {
      console.error(e);
      setUpdateStatus("error");
    }
  };

  // Reflect install progress triggered from any window (including auto-update).
  useEffect(() => {
    const unlisten = listen<{ status: string; progress?: number }>("auto-update-status", (event) => {
      switch (event.payload.status) {
        case "downloading":
          setUpdateStatus("downloading");
          break;
        case "installing":
          setUpdateStatus("installing");
          break;
        case "done":
          setUpdateStatus((prev) => (prev === "downloading" || prev === "installing" ? "idle" : prev));
          break;
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // ── Autostart ──
  const toggleAutostart = async () => {
    try {
      const currentlyEnabled = await isEnabled();
      if (currentlyEnabled) {
        await disable();
        setAutostart(false);
      } else {
        await enable();
        setAutostart(true);
      }
    } catch (err) {}
  };

  // ── Simple boolean toggles ──
  const toggleWeather = () => {
    const next = !weatherEnabled;
    setWeatherEnabled(next);
    saveSetting("kiro-weather-enabled", String(next));
  };

  const toggleCalendar = () => {
    const next = !calendarEnabled;
    setCalendarEnabled(next);
    saveSetting("kiro-calendar-enabled", String(next));
  };

  const toggleTimerEnabled = () => {
    const next = !timerEnabled;
    setTimerEnabled(next);
    saveSetting("kiro-timer-enabled", String(next));
  };

  const toggleTimerSound = () => {
    const next = !timerSoundEnabled;
    setTimerSoundEnabled(next);
    saveSetting("kiro-timer-sound-enabled", String(next));
  };

  const toggleNotchTimerProgress = () => {
    const next = !notchTimerProgress;
    setNotchTimerProgress(next);
    saveSetting("kiro-notch-timer-progress", String(next));
  };

  const toggleStopwatchEnabled = () => {
    const next = !stopwatchEnabled;
    setStopwatchEnabled(next);
    saveSetting("kiro-stopwatch-enabled", String(next));
  };

  const toggleDualClock = () => {
    const next = !dualClockEnabled;
    setDualClockEnabled(next);
    saveSetting("kiro-dual-clock-enabled", String(next));
  };

  const selectDualClockZone = ({ label, zone }: { label: string; zone: string }) => {
    setDualClockZone(zone);
    setDualClockLabel(label);
    saveSetting("kiro-dual-clock-zone", zone);
    saveSetting("kiro-dual-clock-label", label);
  };

  const toggleMusicMode = () => {
    const next = !musicModeEnabled;
    setMusicModeEnabled(next);
    saveSetting("kiro-music-mode-enabled", String(next));
  };

  const toggleMusicCompactNotch = () => {
    const next = !musicCompactNotch;
    setMusicCompactNotch(next);
    saveSetting("kiro-music-compact-notch", String(next));
  };

  const toggleAgentApi = () => {
    const next = !agentApi;
    setAgentApi(next);
    saveSetting("kiro-agent-api", String(next));
  };

  const toggleNotchScrollVolume = () => {
    const next = !notchScrollVolume;
    setNotchScrollVolume(next);
    saveSetting("kiro-notch-scroll-volume", String(next));
  };

  const toggleRememberMode = () => {
    const next = !rememberMode;
    setRememberMode(next);
    saveSetting("kiro-notch-remember-mode", String(next));
  };

  const toggleShelfPersist = () => {
    const next = !shelfPersist;
    setShelfPersist(next);
    saveSetting("kiro-shelf-persist", String(next));
  };

  const toggleMediaLayout = (layout: "classic" | "compact") => {
    setMediaLayout(layout);
    saveSetting("kiro-media-layout", layout);
  };

  const toggleVolumeOverlay = () => {
    const next = !volumeOverlayEnabled;
    setVolumeOverlayEnabled(next);
    saveSetting("kiro-volume-overlay-enabled", String(next));
  };

  const toggleVolumeEdge = () => {
    const next = !volumeEdgeEnabled;
    setVolumeEdgeEnabled(next);
    saveSetting("kiro-volume-edge-enabled", String(next));
  };

  const toggleBrightnessOverlay = () => {
    const next = !brightnessOverlayEnabled;
    setBrightnessOverlayEnabled(next);
    saveSetting("kiro-brightness-overlay-enabled", String(next));
  };

  const toggleBrightnessEdge = () => {
    const next = !brightnessEdgeEnabled;
    setBrightnessEdgeEnabled(next);
    saveSetting("kiro-brightness-edge-enabled", String(next));
  };

  const toggleAmbience = () => {
    const next = !mediaAmbienceEnabled;
    setMediaAmbienceEnabled(next);
    saveSetting("kiro-media-ambience-enabled", String(next));
  };

  const toggleCompactGlow = () => {
    const next = !mediaCompactGlowEnabled;
    setMediaCompactGlowEnabled(next);
    saveSetting("kiro-media-compact-glow-enabled", String(next));
  };

  const toggleArtworkTheme = () => {
    const next = !mediaArtworkThemeEnabled;
    setMediaArtworkThemeEnabled(next);
    saveSetting("kiro-media-artwork-theme", String(next));
  };

  const toggleCorners = () => {
    const next = !cornersEnabled;
    setCornersEnabled(next);
    saveSetting("kiro-corners-enabled", String(next));
  };

  const toggleUpdateIndicator = () => {
    const next = !showUpdateIndicator;
    setShowUpdateIndicator(next);
    saveSetting("kiro-show-update-indicator", String(next));
  };

  const toggleTimeFormat24h = () => {
    const next = !timeFormat24h;
    setTimeFormat24h(next);
    saveSetting("kiro-time-format-24h", String(next));
  };

  const toggleLegacyMode = () => {
    const next = !legacyMode;
    setLegacyMode(next);
    saveSetting("kiro-legacy-mode", String(next));
  };

  const toggleRamSaver = () => {
    const next = !ramSaver;
    setRamSaver(next);
    saveSetting("kiro-ram-saver", String(next));
  };

  const toggleAutoPerf = () => {
    const next = !autoPerf;
    setAutoPerf(next);
    saveSetting("kiro-auto-perf", String(next));
  };

  const toggleGameBoost = () => {
    const next = !gameBoost;
    setGameBoost(next);
    saveSetting("kiro-game-boost", String(next));
  };

  const toggleFpsBoost = () => {
    const next = !fpsBoost;
    setFpsBoost(next);
    saveSetting("kiro-fps-boost", String(next));
  };

  const toggleRamUltra = () => {
    const next = !ramUltra;
    setRamUltra(next);
    saveSetting("kiro-ram-ultra", String(next));
  };

  const toggleTempUnit = () => {
    const next = !tempUnitFahrenheit;
    setTempUnitFahrenheit(next);
    saveSetting("kiro-temp-unit", next ? "fahrenheit" : "celsius");
  };

  const toggleDock = () => {
    const next = !dockEnabled;
    setDockEnabled(next);
    saveSetting("kiro-dock-enabled", String(next));
  };

  const toggleDockPreview = () => {
    const next = !dockPreviewEnabled;
    setDockPreviewEnabled(next);
    saveSetting("kiro-dock-preview-enabled", String(next));
  };

  const toggleDockAttention = () => {
    const next = !dockAttentionEnabled;
    setDockAttentionEnabled(next);
    saveSetting("kiro-dock-attention-enabled", String(next));
  };

  const handleDockSearchProviderChange = (provider: string) => {
    setDockSearchProvider(provider);
    saveSetting("kiro-dock-search-provider", provider);
  };

  const handleDockSearchShortcutChange = (shortcut: string) => {
    setDockSearchShortcut(shortcut);
    saveSetting("kiro-dock-search-shortcut", shortcut);
  };

  const toggleDockSearch = () => {
    const next = !dockSearchEnabled;
    setDockSearchEnabled(next);
    saveSetting("kiro-dock-search-enabled", String(next));
  };

  const toggleDockSearchNative = () => {
    const next = !dockSearchNative;
    setDockSearchNative(next);
    saveSetting("kiro-dock-search-native", String(next));
  };

  const toggleDockTray = () => {
    const next = !dockTray;
    setDockTray(next);
    saveSetting("kiro-dock-tray-enabled", String(next));
  };

  const toggleDockShowDesktop = () => {
    const next = !dockShowDesktop;
    setDockShowDesktop(next);
    saveSetting("kiro-dock-show-desktop-corner", String(next));
  };

  const togglePanelControlCenter = () => {
    const next = !panelControlCenter;
    setPanelControlCenter(next);
    saveSetting("kiro-panel-control-center-enabled", String(next));
  };

  const reorderPanels = (order: PanelId[]) => {
    setPanelOrder(order);
    saveSetting("kiro-panel-order", JSON.stringify(order));
  };

  const changeCcLayout = (next: CcLayout) => {
    setCcLayout(next);
    saveSetting("kiro-cc-layout", JSON.stringify(next));
  };

  const resetCcLayout = () => {
    setCcLayout({});
    localStorage.removeItem("kiro-cc-layout");
    invoke("save_setting", { key: "kiro-cc-layout", value: null }).catch(() => {});
  };

  const resetPanelOrder = () => {
    setPanelOrder(null);
    localStorage.removeItem("kiro-panel-order");
    invoke("save_setting", { key: "kiro-panel-order", value: null }).catch(() => {});
  };

  const togglePanelShelf = () => {
    const next = !panelShelf;
    setPanelShelf(next);
    saveSetting("kiro-panel-shelf-enabled", String(next));
  };

  const toggleDockTaskView = () => {
    const next = !dockTaskView;
    setDockTaskView(next);
    saveSetting("kiro-dock-taskview-enabled", String(next));
  };

  const toggleDockRecycle = () => {
    const next = !dockRecycle;
    setDockRecycle(next);
    saveSetting("kiro-dock-recycle-enabled", String(next));
  };

  const toggleDockDrive = (letter: string) => {
    const next = dockDrives.includes(letter) ? dockDrives.filter((d) => d !== letter) : [...dockDrives, letter].sort();
    setDockDrives(next);
    saveSetting("kiro-dock-drives", JSON.stringify(next));
  };

  const toggleDockCalendar = () => {
    const next = !dockCalendarEnabled;
    setDockCalendarEnabled(next);
    saveSetting("kiro-dock-calendar-enabled", String(next));
  };

  const toggleDockMixedReorder = () => {
    const next = !dockMixedReorder;
    setDockMixedReorder(next);
    saveSetting("kiro-dock-mixed-reorder", String(next));
  };

  const toggleDockIconOnly = () => {
    const next = !dockIconOnly;
    setDockIconOnly(next);
    saveSetting("kiro-dock-icon-only", String(next));
  };

  const handleStartIconChange = (icon: string) => {
    setStartIcon(icon);
    saveSetting("kiro-start-icon", icon);
  };

  const toggleDockAdaptive = () => {
    const next = !dockAdaptive;
    setDockAdaptive(next);
    saveSetting("kiro-dock-adaptive", String(next));
  };

  const toggleDockDesktopPersist = () => {
    const next = !dockDesktopPersist;
    setDockDesktopPersist(next);
    saveSetting("kiro-dock-desktop-persist", String(next));
  };

  const changeNotchPosition = (position: string) => {
    const next = position === "bottom-right" ? "bottom-right" : "top";
    setNotchPosition(next);
    saveSetting("kiro-notch-position", next);
    // The notch window is repositioned by the backend.
    setTimeout(() => invoke("sync_appbar").catch(() => {}), 80);
  };

  const toggleDockWinNumber = () => {
    const next = !dockWinNumberEnabled;
    setDockWinNumberEnabled(next);
    saveSetting("kiro-dock-win-number-enabled", String(next));
  };

  const toggleAutoUpdate = () => {
    const next = !autoUpdate;
    setAutoUpdate(next);
    saveSetting("kiro-auto-update", String(next));
  };

  const togglePrereleaseChannel = async () => {
    const next = !prereleaseChannel;
    const value = next ? "prerelease" : "stable";
    setPrereleaseChannel(next);
    localStorage.setItem("kiro-update-channel", value);
    await invoke("save_setting", { key: "kiro-update-channel", value }).catch(console.error);
    checkForUpdates();
  };

  // ── Value setters ──
  const setDockModeValue = (newMode: string) => {
    setDockMode(newMode);
    saveSetting("kiro-dock-mode", newMode);
  };

  const setNotchModeValue = (newMode: string) => {
    setNotchMode(newMode);
    saveSetting("kiro-notch-mode", newMode);
  };

  const setDockMonitorModeValue = (mode: MonitorMode) => {
    setDockMonitorMode(mode);
    saveSetting("kiro-dock-monitor-mode", mode);
  };

  const setDockMonitorIdValue = (id: string) => {
    setDockMonitorId(id);
    saveSetting("kiro-dock-monitor-id", id);
  };

  const setNotchMonitorModeValue = (mode: MonitorMode) => {
    setNotchMonitorMode(mode);
    saveSetting("kiro-notch-monitor-mode", mode);
  };

  const setNotchMonitorIdValue = (id: string) => {
    setNotchMonitorId(id);
    saveSetting("kiro-notch-monitor-id", id);
  };

  const setDockModeForMonitor = (monitorId: string, mode: string | null) => {
    setDockModeByMonitor((prev) => {
      const next = { ...prev };
      if (mode === null) delete next[monitorId]; else next[monitorId] = mode;
      saveSetting("kiro-dock-mode-by-monitor", JSON.stringify(next));
      return next;
    });
  };

  const replaceDockModesByMonitor = (next: Record<string, string>) => {
    setDockModeByMonitor(next);
    saveSetting("kiro-dock-mode-by-monitor", JSON.stringify(next));
  };

  const replaceNotchModesByMonitor = (next: Record<string, string>) => {
    setNotchModeByMonitor(next);
    saveSetting("kiro-notch-mode-by-monitor", JSON.stringify(next));
  };

  const setNotchModeForMonitor = (monitorId: string, mode: string | null) => {
    setNotchModeByMonitor((prev) => {
      const next = { ...prev };
      if (mode === null) delete next[monitorId]; else next[monitorId] = mode;
      saveSetting("kiro-notch-mode-by-monitor", JSON.stringify(next));
      return next;
    });
  };

  const handleThresholdChange = (val: number) => {
    setLowBatteryThreshold(val);
    saveSetting("kiro-low-battery-threshold", val.toString());
  };

  const handleScaleChange = (val: number) => {
    setScale(val);
    saveSetting("kiro-scale", val.toString());
  };

  const handleWidgetsChange = (config: WidgetConfig) => {
    setStatusWidgets(config);
    saveSetting("kiro-status-widgets", JSON.stringify(config));
  };

  // ── Theme handlers ──
  const handleThemeModeChange = async (mode: string) => {
    setThemeMode(mode);
    saveSetting("kiro-theme-mode", mode);

    if (mode === "adaptive") {
      try {
        const accentHex = await invoke<string>("get_system_accent_color");
        const hsl = hexToHsl(accentHex);
        setThemeSaturation(hsl.s / 100);
        saveSetting("kiro-theme-saturation", String(hsl.s / 100));
        setThemeBrightness(hsl.l / 100);
        saveSetting("kiro-theme-brightness", String(hsl.l / 100));
      } catch (e) {
        console.error("Failed to parse adaptive accent HSL:", e);
      }
    }
  };

  const handleThemeColorChange = (color: string) => {
    setThemeColor(color);
    saveSetting("kiro-theme-color", color);

    try {
      const hsl = hexToHsl(color);
      setThemeSaturation(hsl.s / 100);
      saveSetting("kiro-theme-saturation", String(hsl.s / 100));
      setThemeBrightness(hsl.l / 100);
      saveSetting("kiro-theme-brightness", String(hsl.l / 100));
    } catch (e) {
      console.error("Failed to parse custom color HSL:", e);
    }
  };

  const handleOpacityChange = (value: number) => {
    setThemeOpacity(value);
    saveSetting("kiro-theme-opacity", String(value));
  };

  const handleSaturationChange = (value: number) => {
    setThemeSaturation(value);
    saveSetting("kiro-theme-saturation", String(value));
  };

  const handleBrightnessChange = (value: number) => {
    setThemeBrightness(value);
    saveSetting("kiro-theme-brightness", String(value));
  };

  const handleThemeStyleChange = (style: string) => {
    setThemeStyle(style);
    saveSetting("kiro-theme-style", style);
    // Each style is tuned for an opacity; the slider can still change it afterwards.
    const opacity = STYLE_OPACITY[style];
    if (opacity !== undefined) {
      setThemeOpacity(opacity);
      saveSetting("kiro-theme-opacity", String(opacity));
    }
  };

  const handleAccentChange = (accent: string) => {
    setThemeAccent(accent);
    saveSetting("kiro-theme-accent", accent);
  };

  const handleAccentColorChange = (color: string) => {
    setThemeAccentColor(color);
    saveSetting("kiro-theme-accent-color", color);
  };

  const applyThemePreset = (preset: ThemePreset) => {
    setThemeMode("custom");
    setThemeColor(preset.color);
    setThemeSaturation(preset.saturation);
    setThemeBrightness(preset.brightness);
    setThemeAccent("custom");
    setThemeAccentColor(preset.accent);
    saveSetting("kiro-theme-mode", "custom");
    saveSetting("kiro-theme-color", preset.color);
    saveSetting("kiro-theme-saturation", String(preset.saturation));
    saveSetting("kiro-theme-brightness", String(preset.brightness));
    saveSetting("kiro-theme-accent", "custom");
    saveSetting("kiro-theme-accent-color", preset.accent);
  };

  // ── City search ──
  const selectCity = async (city: {
    name: string;
    country: string;
    latitude: number;
    longitude: number;
  }) => {
    setCityName(city.name);
    setCityQuery(city.name);
    setShowCityDropdown(false);
    setCitySearchResults([]);
    localStorage.setItem("kiro-weather-city", city.name);
    localStorage.setItem("kiro-weather-lat", city.latitude.toString());
    localStorage.setItem("kiro-weather-lon", city.longitude.toString());
    await invoke("save_setting", { key: "kiro-weather-lat", value: city.latitude.toString() }).catch(() => {});
    await invoke("save_setting", { key: "kiro-weather-lon", value: city.longitude.toString() }).catch(() => {});
    await invoke("save_setting", { key: "kiro-weather-city", value: city.name }).catch(() => {});
    emit("weather-refresh", { lat: city.latitude, lon: city.longitude, city: city.name });
  };

  const handleCityClear = async () => {
    setCityName("");
    setCityQuery("");
    setShowCityDropdown(false);
    setCitySearchResults([]);
    localStorage.removeItem("kiro-weather-city");
    localStorage.removeItem("kiro-weather-lat");
    localStorage.removeItem("kiro-weather-lon");
    await invoke("save_setting", { key: "kiro-weather-lat", value: null }).catch(() => {});
    await invoke("save_setting", { key: "kiro-weather-lon", value: null }).catch(() => {});
    await invoke("save_setting", { key: "kiro-weather-city", value: null }).catch(() => {});
    emit("weather-refresh", true);
  };

  // ── Export / Import ──
  const handleExportSettings = async () => {
    setExportStatus("exporting");
    try {
      const saved = await invoke<boolean>("export_settings_dialog");
      if (saved) {
        setExportStatus("success");
        setTimeout(() => setExportStatus("idle"), 2000);
      } else {
        setExportStatus("idle");
      }
    } catch (e) {
      console.error("Export failed:", e);
      setExportStatus("error");
      setTimeout(() => setExportStatus("idle"), 3000);
    }
  };

  const handleImportSettings = async () => {
    setImportStatus("importing");
    try {
      const imported = await invoke<boolean>("import_settings_dialog");
      if (imported) {
        await loadAllSettings();
        setImportStatus("success");
        setTimeout(() => setImportStatus("idle"), 2000);
      } else {
        setImportStatus("idle");
      }
    } catch (e) {
      console.error("Import failed:", e);
      setImportStatus("error");
      setTimeout(() => setImportStatus("idle"), 3000);
    }
  };

  const handleResetSettings = async () => {
    if (resetStatus === "idle") {
      setResetStatus("confirm");
      setTimeout(() => setResetStatus((s) => (s === "confirm" ? "idle" : s)), 4000);
      return;
    }
    if (resetStatus !== "confirm") return;

    setResetStatus("resetting");
    try {
      await invoke("reset_settings");
      localStorage.clear();
      await invoke("restart_kiro");
    } catch (e) {
      console.error("Reset failed:", e);
      setResetStatus("idle");
    }
  };

  const handleUninstallKiro = async () => {
    if (uninstallStatus === "idle" || uninstallStatus === "error") {
      setUninstallStatus("confirm");
      setTimeout(() => setUninstallStatus((s) => (s === "confirm" ? "idle" : s)), 4000);
      return;
    }
    if (uninstallStatus !== "confirm") return;

    setUninstallStatus("uninstalling");
    try {
      await invoke("uninstall_kiro");
    } catch (e) {
      console.error("Uninstall failed:", e);
      setUninstallError(typeof e === "string" ? e : String((e as Error)?.message ?? e));
      setUninstallStatus("error");
      setTimeout(() => setUninstallStatus((s) => (s === "error" ? "idle" : s)), 12000);
    }
  };

  return {
    // System
    autostart,
    toggleAutostart,
    autoUpdate,
    toggleAutoUpdate,
    prereleaseChannel,
    togglePrereleaseChannel,
    lowBatteryThreshold,
    handleThresholdChange,
    timeFormat24h,
    toggleTimeFormat24h,
    legacyMode,
    toggleLegacyMode,
    showUpdateIndicator,
    toggleUpdateIndicator,
    ramSaver,
    toggleRamSaver,
    ramUltra,
    toggleRamUltra,
    autoPerf,
    toggleAutoPerf,
    gameBoost,
    toggleGameBoost,
    fpsBoost,
    toggleFpsBoost,
    scale,
    handleScaleChange,
    cornersEnabled,
    toggleCorners,

    // Theme
    themeMode,
    handleThemeModeChange,
    themeColor,
    handleThemeColorChange,
    themeOpacity,
    handleOpacityChange,
    themeSaturation,
    handleSaturationChange,
    themeBrightness,
    handleBrightnessChange,
    themeStyle,
    handleThemeStyleChange,
    themeAccent,
    handleAccentChange,
    themeAccentColor,
    handleAccentColorChange,
    applyThemePreset,

    // Notch
    notchMode,
    setNotchModeValue,
    calendarEnabled,
    toggleCalendar,
    timerEnabled,
    toggleTimerEnabled,
    timerSoundEnabled,
    toggleTimerSound,
    notchTimerProgress,
    toggleNotchTimerProgress,
    stopwatchEnabled,
    toggleStopwatchEnabled,
    dualClockEnabled,
    toggleDualClock,
    dualClockZone,
    dualClockLabel,
    selectDualClockZone,
    musicModeEnabled,
    toggleMusicMode,
    musicCompactNotch,
    toggleMusicCompactNotch,
    agentApi,
    toggleAgentApi,
    notchScrollVolume,
    toggleNotchScrollVolume,
    shelfPersist,
    toggleShelfPersist,
    rememberMode,
    toggleRememberMode,
    mediaLayout,
    toggleMediaLayout,
    mediaAmbienceEnabled,
    toggleAmbience,
    mediaCompactGlowEnabled,
    toggleCompactGlow,
    mediaArtworkThemeEnabled,
    toggleArtworkTheme,

    // Weather
    weatherEnabled,
    toggleWeather,
    tempUnitFahrenheit,
    toggleTempUnit,
    cityName,
    cityQuery,
    setCityQuery,
    citySearchResults,
    showCityDropdown,
    setShowCityDropdown,
    selectCity,
    handleCityClear,

    // Widgets
    statusWidgets,
    handleWidgetsChange,
    hasBattery,

    // Dock
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
    dockTray,
    toggleDockTray,
    dockTaskView,
    toggleDockTaskView,
    dockShowDesktop,
    toggleDockShowDesktop,
    panelControlCenter,
    togglePanelControlCenter,
    panelShelf,
    togglePanelShelf,
    panelOrder,
    reorderPanels,
    resetPanelOrder,
    ccLayout,
    changeCcLayout,
    resetCcLayout,
    dockRecycle,
    toggleDockRecycle,
    dockDrives,
    toggleDockDrive,
    dockIconOnly,
    toggleDockIconOnly,
    startIcon,
    handleStartIconChange,
    dockAdaptive,
    toggleDockAdaptive,
    dockDesktopPersist,
    toggleDockDesktopPersist,
    notchPosition,
    changeNotchPosition,
    dockWinNumberEnabled,
    toggleDockWinNumber,
    dockMixedReorder,
    toggleDockMixedReorder,

    monitors,
    dockMonitorMode,
    setDockMonitorModeValue,
    dockMonitorId,
    setDockMonitorIdValue,
    notchMonitorMode,
    setNotchMonitorModeValue,
    notchMonitorId,
    setNotchMonitorIdValue,
    dockModeByMonitor,
    setDockModeForMonitor,
    replaceDockModesByMonitor,
    notchModeByMonitor,
    setNotchModeForMonitor,
    replaceNotchModesByMonitor,

    // Overlays
    volumeOverlayEnabled,
    toggleVolumeOverlay,
    volumeEdgeEnabled,
    toggleVolumeEdge,
    brightnessOverlayEnabled,
    toggleBrightnessOverlay,
    brightnessEdgeEnabled,
    toggleBrightnessEdge,

    // Updates
    updateStatus,
    updateVersion,
    appVersion,
    checkForUpdates,
    installUpdate,

    exportStatus,
    importStatus,
    handleExportSettings,
    handleImportSettings,
    resetStatus,
    handleResetSettings,
    uninstallStatus,
    uninstallError,
    handleUninstallKiro,

    // Utilities
    restartKiro: () => invoke("restart_kiro"),
    quitKiro: () => invoke("quit_kiro"),
  };
}
