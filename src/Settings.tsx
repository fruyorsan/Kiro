import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { Settings, Palette, PanelTop, Monitor, Layers, Info } from "lucide-react";
import { WindowControls } from "./components/WindowControls";
import {
  useSettings,
  GeneralTab,
  AppearanceTab,
  NotchTab,
  CalendarSyncPage,
  DockTab,
  OverlaysTab,
  AboutTab,
} from "./settings/index";
import type { SettingsTab } from "./settings/index";
import { initTheme } from "./theme";
import { useKiroLogo } from "./kiroLogo";
import { useT } from "./i18n";
import "./Settings.css";

type TabGroupId = "core" | "surfaces" | "system";

const TABS: { id: SettingsTab; labelKey: string; group: TabGroupId; icon: typeof Settings }[] = [
  { id: "general", labelKey: "tabs.general", group: "core", icon: Settings },
  { id: "appearance", labelKey: "tabs.appearance", group: "core", icon: Palette },
  { id: "notch", labelKey: "tabs.notch", group: "surfaces", icon: PanelTop },
  { id: "dock", labelKey: "tabs.dock", group: "surfaces", icon: Monitor },
  { id: "overlays", labelKey: "tabs.overlays", group: "surfaces", icon: Layers },
  { id: "about", labelKey: "tabs.about", group: "system", icon: Info },
];

const TAB_GROUPS: TabGroupId[] = ["core", "surfaces", "system"];

const SEARCH_INDEX: { tab: SettingsTab; labelTr: string; labelEn: string; keywords: string }[] = [
  { tab: "general", labelTr: "Başlangıç ve Dil", labelEn: "Startup & Language", keywords: "startup language dil türkçe english autostart performance perf fps oyun game" },
  { tab: "general", labelTr: "Performans ve FPS", labelEn: "Performance & FPS", keywords: "fps gpu hardware acceleration perf lite cpu güç power" },
  { tab: "appearance", labelTr: "Tema ve Cam Stili", labelEn: "Theme & Surface Style", keywords: "theme dark light frosted liquid material solid color renk saydamlık opacity" },
  { tab: "appearance", labelTr: "Mevsim Efekti (Kar / Sarmaşık / Yaprak / Çiçek)", labelEn: "Seasonal Effect (Snow / Ivy / Autumn / Blossom)", keywords: "season mevsim kar snow buz icicle yağmur rain sarmaşık ivy yaprak autumn sonbahar çiçek blossom" },
  { tab: "appearance", labelTr: "Vurgu Rengi ve Ölçek", labelEn: "Accent Colour & Scale", keywords: "accent vurgu color renk scale ölçek corners köşe saturation brightness" },
  { tab: "notch", labelTr: "Çentik Modu ve Medya", labelEn: "Notch Mode & Media", keywords: "notch çentik media müzik spotify battery pil notes notlar timer" },
  { tab: "notch", labelTr: "Takvim Senkronizasyonu", labelEn: "Calendar Sync", keywords: "calendar takvim event etkinlik google sync" },
  { tab: "dock", labelTr: "Dock Davranışı ve Simgeler", labelEn: "Dock Behaviour & Icons", keywords: "dock taskbar simge icon shortcut kısayol hide gizle magnify büyütme monitor" },
  { tab: "overlays", labelTr: "Ses ve Parlaklık Bindirmeleri", labelEn: "Volume & Brightness Overlays", keywords: "overlay bindirme volume ses brightness parlaklık hud edge" },
  { tab: "about", labelTr: "Sürüm, Yedekleme ve Sıfırlama", labelEn: "Version, Backup & Reset", keywords: "about hakkında version sürüm update güncelleme export import yedek reset sıfırla uninstall" },
];

function SettingsApp() {
  const t = useT();
  const kiroLogo = useKiroLogo();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const settings = useSettings();

  useEffect(() => {
    return initTheme();
  }, []);

  // A dock menu entry deep-links here; wait for the tab to paint, then scroll.
  useEffect(() => {
    if (!scrollTarget) return;
    const id = window.setTimeout(() => {
      document.getElementById(scrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setScrollTarget(null);
    }, 180);
    return () => window.clearTimeout(id);
  }, [scrollTarget, activeTab]);

  useEffect(() => {
    const unlisten = listen<string>("settings-navigate", (e) => {
      if (e.payload === "calendar-sync") setActiveTab("calendar-sync");
      if (e.payload === "dock-menu") {
        setActiveTab("dock");
        setScrollTarget("dock-menu");
      }
    });
    // A window opened on demand mounts its listener after the opener already
    // emitted the navigation, so tell anyone waiting that it is safe to send.
    void emit("settings-ready");
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const [searchQuery, setSearchQuery] = useState("");

  const resolvedHeadTab = activeTab === "calendar-sync" ? "notch" : activeTab;
  const activeTabMeta = TABS.find((tab) => tab.id === resolvedHeadTab) ?? TABS[0];
  const ActiveTabIcon = activeTabMeta.icon;
  const isTurkish = t("settings.title") === "Ayarlar";
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const searchResults = normalizedQuery
    ? SEARCH_INDEX.filter((item) => {
        const title = (isTurkish ? item.labelTr : item.labelEn).toLowerCase();
        return title.includes(normalizedQuery) || item.keywords.includes(normalizedQuery);
      })
    : [];

  useEffect(() => {
    const root = document.getElementById("settings-main-scroll");
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
    let firstMatch: HTMLElement | null = null;
    for (const row of rows) {
      const text = (row.textContent ?? "").toLowerCase();
      const hit = normalizedQuery.length > 1 && text.includes(normalizedQuery);
      row.classList.toggle("search-highlight", hit);
      if (hit && !firstMatch) firstMatch = row;
    }
    if (firstMatch) {
      firstMatch.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [normalizedQuery, activeTab]);

  useEffect(() => {
    const preventContext: EventListener = (e) => e.preventDefault();
    document.addEventListener("contextmenu", preventContext);

    return () => {
      document.removeEventListener("contextmenu", preventContext);
    };
  }, []);

  useEffect(() => {
    invoke("resize_settings_window", {
      width: 860 * settings.scale,
      height: 660 * settings.scale,
    }).catch(console.error);
  }, [settings.scale]);

  return (
    <div className="settings-container" style={{ zoom: settings.scale }}>
      <div className="title-bar" data-tauri-drag-region>
        <div className="title-brand" data-tauri-drag-region>
          <img className="title-mark" src={kiroLogo} alt="" aria-hidden draggable={false} />
          <span className="title-text" data-tauri-drag-region>
            Kiro
          </span>
          <span className="title-divider" aria-hidden />
          <span className="title-section" data-tauri-drag-region>
            {t(`tabs.${activeTab === "calendar-sync" ? "notch" : activeTab}`)}
          </span>
        </div>
        <WindowControls />
      </div>

      <div className="settings-body">
        <nav className="settings-sidebar" aria-label={t("tabs.general")}>
          <div className="sidebar-brand-card">
            <div className="brand-logo-box" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                <rect x="3" y="4" width="18" height="6" rx="3" fill="currentColor" fillOpacity="0.92" />
                <rect x="5" y="13.5" width="14" height="6.5" rx="3.2" fill="currentColor" fillOpacity="0.45" />
                <circle cx="8" cy="7" r="1.1" fill="var(--bg)" />
              </svg>
            </div>
            <div className="brand-meta">
              <span className="brand-name">Kiro</span>
              <span className="brand-sub">{t("settings.subtitle")}</span>
            </div>
            <span className="brand-ver-badge">v{__KIRO_VERSION__}</span>
          </div>

          <div className="sidebar-search">
            <svg className="sidebar-search-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              className="sidebar-search-input"
              placeholder={t("settings.search.placeholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchQuery("");
              }}
            />
            {searchQuery && (
              <button
                type="button"
                className="sidebar-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>

          {normalizedQuery ? (
            <div className="sidebar-search-results">
              {searchResults.length > 0 ? (
                searchResults.map((hit, idx) => (
                  <button
                    key={`${hit.tab}-${idx}`}
                    type="button"
                    className={`search-hit-btn ${activeTab === hit.tab ? "is-current" : ""}`}
                    onClick={() => setActiveTab(hit.tab)}
                  >
                    <span className="search-hit-title">{isTurkish ? hit.labelTr : hit.labelEn}</span>
                    <span className="search-hit-tab">{t(`tabs.${hit.tab}`)}</span>
                  </button>
                ))
              ) : (
                <div className="sidebar-search-empty">{t("settings.search.empty")}</div>
              )}
            </div>
          ) : (
            <div className="sidebar-tabs" role="tablist">
              {TAB_GROUPS.map((group) => (
                <div key={group} className="sidebar-group">
                  <div className="sidebar-group-label">{t(`settings.group.${group}`)}</div>
                  {TABS.filter((tab) => tab.group === group).map(({ id, labelKey, icon: Icon }) => {
                    const isActive =
                      activeTab === id || (id === "notch" && activeTab === "calendar-sync");
                    return (
                      <button
                        key={id}
                        role="tab"
                        aria-selected={isActive}
                        className={`side-tab ${isActive ? "active" : ""}`}
                        onClick={() => setActiveTab(id)}
                      >
                        <span className="side-tab-icon">
                          <Icon size={14} strokeWidth={1.85} />
                        </span>
                        <span className="side-tab-label">{t(labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <span className="sidebar-version">
            {t("settings.version")} {__KIRO_VERSION__}
          </span>
        </nav>

        <div id="settings-main-scroll" className="settings-main">
          <div className="settings-content">
            <div className="settings-page-head settings-page-head-card">
              <div className="page-head-icon-box" aria-hidden="true">
                <ActiveTabIcon size={20} strokeWidth={1.75} />
              </div>
              <div className="page-head-text">
                <h1>{t(`tabs.${resolvedHeadTab}`)}</h1>
                <p>{t(`tabs.${resolvedHeadTab}.desc`)}</p>
              </div>
            </div>
          {/* Keyed by tab so each page fades in on its own; the page itself is
              never unmounted piecemeal while React swaps the tab body. */}
          <div className="settings-pane" key={activeTab}>
          {activeTab === "general" && (
            <GeneralTab
              autostart={settings.autostart}
              toggleAutostart={settings.toggleAutostart}
              timeFormat24h={settings.timeFormat24h}
              toggleTimeFormat24h={settings.toggleTimeFormat24h}
              legacyMode={settings.legacyMode}
              toggleLegacyMode={settings.toggleLegacyMode}
              showUpdateIndicator={settings.showUpdateIndicator}
              toggleUpdateIndicator={settings.toggleUpdateIndicator}
              ramSaver={settings.ramSaver}
              toggleRamSaver={settings.toggleRamSaver}
              ramUltra={settings.ramUltra}
              toggleRamUltra={settings.toggleRamUltra}
              lowBatteryThreshold={settings.lowBatteryThreshold}
              hasBattery={settings.hasBattery}
              handleThresholdChange={settings.handleThresholdChange}
              autoPerf={settings.autoPerf}
              toggleAutoPerf={settings.toggleAutoPerf}
              gameBoost={settings.gameBoost}
              toggleGameBoost={settings.toggleGameBoost}
              fpsBoost={settings.fpsBoost}
              toggleFpsBoost={settings.toggleFpsBoost}
              restartKiro={settings.restartKiro}
              quitKiro={settings.quitKiro}
            />
          )}
          {activeTab === "appearance" && (
            <AppearanceTab
              themeMode={settings.themeMode}
              handleThemeModeChange={settings.handleThemeModeChange}
              themeColor={settings.themeColor}
              handleThemeColorChange={settings.handleThemeColorChange}
              themeOpacity={settings.themeOpacity}
              handleOpacityChange={settings.handleOpacityChange}
              themeSaturation={settings.themeSaturation}
              handleSaturationChange={settings.handleSaturationChange}
              themeBrightness={settings.themeBrightness}
              handleBrightnessChange={settings.handleBrightnessChange}
              themeStyle={settings.themeStyle}
              handleThemeStyleChange={settings.handleThemeStyleChange}
              themeAccent={settings.themeAccent}
              handleAccentChange={settings.handleAccentChange}
              themeAccentColor={settings.themeAccentColor}
              handleAccentColorChange={settings.handleAccentColorChange}
              applyThemePreset={settings.applyThemePreset}
              legacyMode={settings.legacyMode}
              cornersEnabled={settings.cornersEnabled}
              toggleCorners={settings.toggleCorners}
              scale={settings.scale}
              handleScaleChange={settings.handleScaleChange}
              fpsThrottled={settings.fpsThrottled}
              toggleFpsThrottled={settings.toggleFpsThrottled}
            />
          )}
          {activeTab === "calendar-sync" && <CalendarSyncPage onBack={() => setActiveTab("notch")} />}
          {activeTab === "notch" && (
            <NotchTab
              onOpenCalendarSync={() => setActiveTab("calendar-sync")}
              notchMode={settings.notchMode}
              setNotchModeValue={settings.setNotchModeValue}
              notchPosition={settings.notchPosition}
              changeNotchPosition={settings.changeNotchPosition}
              monitors={settings.monitors}
              notchMonitorMode={settings.notchMonitorMode}
              setNotchMonitorModeValue={settings.setNotchMonitorModeValue}
              notchMonitorId={settings.notchMonitorId}
              setNotchMonitorIdValue={settings.setNotchMonitorIdValue}
              notchModeByMonitor={settings.notchModeByMonitor}
              setNotchModeForMonitor={settings.setNotchModeForMonitor}
              replaceNotchModes={settings.replaceNotchModesByMonitor}
              calendarEnabled={settings.calendarEnabled}
              toggleCalendar={settings.toggleCalendar}
              timerEnabled={settings.timerEnabled}
              toggleTimerEnabled={settings.toggleTimerEnabled}
              timerSoundEnabled={settings.timerSoundEnabled}
              toggleTimerSound={settings.toggleTimerSound}
              notchTimerProgress={settings.notchTimerProgress}
              toggleNotchTimerProgress={settings.toggleNotchTimerProgress}
              stopwatchEnabled={settings.stopwatchEnabled}
              toggleStopwatchEnabled={settings.toggleStopwatchEnabled}
              legacyMode={settings.legacyMode}
              dualClockEnabled={settings.dualClockEnabled}
              toggleDualClock={settings.toggleDualClock}
              dualClockZone={settings.dualClockZone}
              dualClockLabel={settings.dualClockLabel}
              selectDualClockZone={settings.selectDualClockZone}
              musicModeEnabled={settings.musicModeEnabled}
              toggleMusicMode={settings.toggleMusicMode}
              musicCompactNotch={settings.musicCompactNotch}
              toggleMusicCompactNotch={settings.toggleMusicCompactNotch}
              mediaLayout={settings.mediaLayout}
              toggleMediaLayout={settings.toggleMediaLayout}
              mediaAmbienceEnabled={settings.mediaAmbienceEnabled}
              toggleAmbience={settings.toggleAmbience}
              mediaCompactGlowEnabled={settings.mediaCompactGlowEnabled}
              toggleCompactGlow={settings.toggleCompactGlow}
              artworkThemeEnabled={settings.mediaArtworkThemeEnabled}
              toggleArtworkTheme={settings.toggleArtworkTheme}
              agentApi={settings.agentApi}
              toggleAgentApi={settings.toggleAgentApi}
              notchScrollVolume={settings.notchScrollVolume}
              toggleNotchScrollVolume={settings.toggleNotchScrollVolume}
              shelfPersist={settings.shelfPersist}
              toggleShelfPersist={settings.toggleShelfPersist}
              rememberMode={settings.rememberMode}
              toggleRememberMode={settings.toggleRememberMode}
              panelControlCenter={settings.panelControlCenter}
              togglePanelControlCenter={settings.togglePanelControlCenter}
              panelShelf={settings.panelShelf}
              togglePanelShelf={settings.togglePanelShelf}
              panelOrder={settings.panelOrder}
              reorderPanels={settings.reorderPanels}
              resetPanelOrder={settings.resetPanelOrder}
              ccLayout={settings.ccLayout}
              changeCcLayout={settings.changeCcLayout}
              resetCcLayout={settings.resetCcLayout}
              weatherEnabled={settings.weatherEnabled}
              toggleWeather={settings.toggleWeather}
              tempUnitFahrenheit={settings.tempUnitFahrenheit}
              toggleTempUnit={settings.toggleTempUnit}
              cityName={settings.cityName}
              cityQuery={settings.cityQuery}
              setCityQuery={settings.setCityQuery}
              citySearchResults={settings.citySearchResults}
              showCityDropdown={settings.showCityDropdown}
              setShowCityDropdown={settings.setShowCityDropdown}
              selectCity={settings.selectCity}
              handleCityClear={settings.handleCityClear}
              statusWidgets={settings.statusWidgets}
              handleWidgetsChange={settings.handleWidgetsChange}
              hasBattery={settings.hasBattery}
            />
          )}
          {activeTab === "dock" && (
            <DockTab
              dockEnabled={settings.dockEnabled}
              toggleDock={settings.toggleDock}
              dockMode={settings.dockMode}
              setDockModeValue={settings.setDockModeValue}
              dockPreviewEnabled={settings.dockPreviewEnabled}
              toggleDockPreview={settings.toggleDockPreview}
              dockAttentionEnabled={settings.dockAttentionEnabled}
              toggleDockAttention={settings.toggleDockAttention}
              dockSearchEnabled={settings.dockSearchEnabled}
              toggleDockSearch={settings.toggleDockSearch}
              dockSearchNative={settings.dockSearchNative}
              toggleDockSearchNative={settings.toggleDockSearchNative}
              dockSearchProvider={settings.dockSearchProvider}
              handleDockSearchProviderChange={settings.handleDockSearchProviderChange}
              dockSearchShortcut={settings.dockSearchShortcut}
              handleDockSearchShortcutChange={settings.handleDockSearchShortcutChange}
              dockCalendarEnabled={settings.dockCalendarEnabled}
              toggleDockCalendar={settings.toggleDockCalendar}
              legacyMode={settings.legacyMode}
              dockTray={settings.dockTray}
              toggleDockTray={settings.toggleDockTray}
              dockNotepad={settings.dockNotepad}
              toggleDockNotepad={settings.toggleDockNotepad}
              dockTaskView={settings.dockTaskView}
              toggleDockTaskView={settings.toggleDockTaskView}
              dockShowDesktop={settings.dockShowDesktop}
              toggleDockShowDesktop={settings.toggleDockShowDesktop}
              dockRecycle={settings.dockRecycle}
              toggleDockRecycle={settings.toggleDockRecycle}
              dockDrives={settings.dockDrives}
              toggleDockDrive={settings.toggleDockDrive}
              dockMenuHidden={settings.dockMenuHidden}
              toggleDockMenuItem={settings.toggleDockMenuItem}
              dockMenuShortcuts={settings.dockMenuShortcuts}
              addDockMenuShortcut={settings.addDockMenuShortcut}
              removeDockMenuShortcut={settings.removeDockMenuShortcut}
              dockIconOnly={settings.dockIconOnly}
              toggleDockIconOnly={settings.toggleDockIconOnly}
              dockAdaptive={settings.dockAdaptive}
              toggleDockAdaptive={settings.toggleDockAdaptive}
              dockDesktopPersist={settings.dockDesktopPersist}
              toggleDockDesktopPersist={settings.toggleDockDesktopPersist}
              startIcon={settings.startIcon}
              handleStartIconChange={settings.handleStartIconChange}
              dockWinNumberEnabled={settings.dockWinNumberEnabled}
              toggleDockWinNumber={settings.toggleDockWinNumber}
              dockMixedReorder={settings.dockMixedReorder}
              toggleDockMixedReorder={settings.toggleDockMixedReorder}
              monitors={settings.monitors}
              dockMonitorMode={settings.dockMonitorMode}
              setDockMonitorModeValue={settings.setDockMonitorModeValue}
              dockMonitorId={settings.dockMonitorId}
              setDockMonitorIdValue={settings.setDockMonitorIdValue}
              dockModeByMonitor={settings.dockModeByMonitor}
              setDockModeForMonitor={settings.setDockModeForMonitor}
              replaceDockModes={settings.replaceDockModesByMonitor}
              fpsThrottled={settings.fpsThrottled}
              toggleFpsThrottled={settings.toggleFpsThrottled}
            />
          )}
          {activeTab === "overlays" && (
            <OverlaysTab
              volumeOverlayEnabled={settings.volumeOverlayEnabled}
              toggleVolumeOverlay={settings.toggleVolumeOverlay}
              volumeEdgeEnabled={settings.volumeEdgeEnabled}
              toggleVolumeEdge={settings.toggleVolumeEdge}
              brightnessOverlayEnabled={settings.brightnessOverlayEnabled}
              toggleBrightnessOverlay={settings.toggleBrightnessOverlay}
              brightnessEdgeEnabled={settings.brightnessEdgeEnabled}
              toggleBrightnessEdge={settings.toggleBrightnessEdge}
            />
          )}
          {activeTab === "about" && (
            <AboutTab
              appVersion={settings.appVersion}
              autoUpdate={settings.autoUpdate}
              toggleAutoUpdate={settings.toggleAutoUpdate}
              prereleaseChannel={settings.prereleaseChannel}
              togglePrereleaseChannel={settings.togglePrereleaseChannel}
              updateStatus={settings.updateStatus}
              updateVersion={settings.updateVersion}
              checkForUpdates={settings.checkForUpdates}
              installUpdate={settings.installUpdate}
              exportStatus={settings.exportStatus}
              importStatus={settings.importStatus}
              handleExportSettings={settings.handleExportSettings}
              handleImportSettings={settings.handleImportSettings}
              resetStatus={settings.resetStatus}
              handleResetSettings={settings.handleResetSettings}
              uninstallStatus={settings.uninstallStatus}
              uninstallError={settings.uninstallError}
              handleUninstallKiro={settings.handleUninstallKiro}
            />
          )}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>
);
