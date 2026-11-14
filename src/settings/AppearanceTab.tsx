import { Palette, Droplet, Contrast, Droplets, Sun, Square, Maximize2, Layers, SwatchBook, Highlighter, ImagePlus, Snowflake, Zap } from "lucide-react";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SettingRow } from "./SettingRow";
import { SettingSection } from "./SettingSection";
import { Dropdown } from "./Dropdown";
import { useT } from "../i18n";
import { GlassWallpaper } from "./GlassWallpaper";
import { SEASON_SETTING, setSeasonTheme } from "../season";
import { THEME_PRESETS, hexToHsl, hslToHex, type ThemePreset } from "../theme";
import { prepareKiroLogo, resetKiroLogo, setKiroLogoSrc, useKiroLogo } from "../kiroLogo";

const STYLES = ["solid", "frosted", "liquid", "material"];

function presetBackground(preset: ThemePreset): string {
  return hslToHex(hexToHsl(preset.color).h, preset.saturation * 100, preset.brightness * 100);
}

interface AppearanceTabProps {
  themeMode: string;
  handleThemeModeChange: (mode: string) => void;
  themeColor: string;
  handleThemeColorChange: (color: string) => void;
  themeOpacity: number;
  handleOpacityChange: (val: number) => void;
  themeSaturation: number;
  handleSaturationChange: (val: number) => void;
  themeBrightness: number;
  handleBrightnessChange: (val: number) => void;
  cornersEnabled: boolean;
  toggleCorners: () => void;
  scale: number;
  handleScaleChange: (val: number) => void;
  themeStyle: string;
  handleThemeStyleChange: (style: string) => void;
  themeAccent: string;
  handleAccentChange: (accent: string) => void;
  themeAccentColor: string;
  handleAccentColorChange: (color: string) => void;
  applyThemePreset: (preset: ThemePreset) => void;
  legacyMode: boolean;
  fpsThrottled?: boolean;
  toggleFpsThrottled?: () => void;
}

export function AppearanceTab({
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
  cornersEnabled,
  toggleCorners,
  scale,
  handleScaleChange,
  themeStyle,
  handleThemeStyleChange,
  themeAccent,
  handleAccentChange,
  themeAccentColor,
  handleAccentColorChange,
  applyThemePreset,
  legacyMode,
  fpsThrottled,
  toggleFpsThrottled,
}: AppearanceTabProps) {
  const t = useT();
  const kiroLogo = useKiroLogo();
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState("");
  // The dropdown only knows the current effect names; a setting written by an
  // older build still says winter/spring/summer/autumn, so map it on read or
  // the select would show no option at all.
  const [seasonTheme, setSeasonThemeState] = useState(() => {
    const raw = (localStorage.getItem(SEASON_SETTING) ?? "auto").toLowerCase();
    const legacy: Record<string, string> = { winter: "snow", spring: "blossom", summer: "rain", autumn: "leaves" };
    return legacy[raw] ?? raw;
  });
  // Seasonal decoration is cosmetic and lives in the notch/dock windows, so it
  // is written through the shared settings file instead of a render prop: every
  // window picks the change up from the `settings-changed` event.
  const handleSeasonChange = (value: string) => {
    setSeasonThemeState(value);
    setSeasonTheme(value);
    invoke("save_setting", { key: SEASON_SETTING, value }).catch(() => {});
  };
  const isMaterial = !legacyMode && themeStyle === "material";
  const showCustomColor = themeMode === "custom";
  // Material You builds the whole palette from the accent, so these don't apply there.
  const showAdvancedSliders = !isMaterial && (themeMode === "custom" || themeMode === "adaptive");
  const isActivePreset = (preset: ThemePreset) =>
    themeMode === "custom" &&
    themeColor.toLowerCase() === preset.color.toLowerCase() &&
    Math.abs(themeSaturation - preset.saturation) < 0.01 &&
    Math.abs(themeBrightness - preset.brightness) < 0.01;

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    setLogoError("");
    setLogoBusy(true);
    try {
      // Validated and squared by the backend so a huge photo or an odd format
      // cannot break the dock, notch or splash.
      setKiroLogoSrc(await prepareKiroLogo(file));
    } catch {
      setLogoError(t("appearance.logo.error"));
    } finally {
      setLogoBusy(false);
    }
  };

  const seasonOptions = [
    { value: "auto", label: t("appearance.season.auto"), tone: "auto" },
    { value: "snow", label: t("appearance.season.snow"), tone: "snow" },
    { value: "rain", label: t("appearance.season.rain"), tone: "rain" },
    { value: "leaves", label: t("appearance.season.leaves"), tone: "leaves" },
    { value: "blossom", label: t("appearance.season.blossom"), tone: "blossom" },
    { value: "off", label: t("appearance.season.off"), tone: "off" },
  ] as const;

  const activeSeasonOption =
    seasonOptions.find((opt) => opt.value === seasonTheme) ?? seasonOptions[0];
  const isLightPreview = themeMode === "light";
  const previewSurfaceBg =
    themeMode === "custom"
      ? themeColor
      : isLightPreview
      ? `rgba(244, 245, 250, ${Math.max(0.55, themeOpacity).toFixed(2)})`
      : `rgba(18, 19, 24, ${Math.max(0.55, themeOpacity).toFixed(2)})`;
  const previewAccent =
    themeAccent === "custom" ? themeAccentColor : isLightPreview ? "#2563eb" : "#7c9cff";

  return (
    <>
      <div className={`appearance-live-preview ${isLightPreview ? "is-light" : "is-dark"} style-${themeStyle}`}>
        <div className="live-preview-stage">
          <div
            className={`live-mini-notch season-badge-${activeSeasonOption.value}`}
            style={{
              background: previewSurfaceBg,
              borderColor: `${previewAccent}44`,
            }}
          >
            <span className="mini-notch-dot" style={{ background: previewAccent }} />
            <span className="mini-notch-time">12:15</span>
            <span className="mini-notch-chip" style={{ color: previewAccent }}>18°C</span>
          </div>

          <div
            className={`live-mini-dock season-badge-${activeSeasonOption.value}`}
            style={{
              background: previewSurfaceBg,
              borderColor: `${previewAccent}33`,
            }}
          >
            <span className="mini-dock-pill" style={{ background: previewAccent }} />
            <span className="mini-dock-pill" />
            <span className="mini-dock-pill" />
            <span className="mini-dock-pill" />
          </div>
        </div>

        <div className="live-preview-meta">
          <span className="live-preview-tag">{t("appearance.preview.label")}</span>
          <div className="live-preview-badges">
            <span className="preview-chip">{themeStyle}</span>
            <span className="preview-chip accent" style={{ borderColor: `${previewAccent}55` }}>
              {activeSeasonOption.label}
            </span>
          </div>
        </div>
      </div>

      <SettingSection id="appearance-theme" title={t("appearance.theme.group")} defaultOpen>
        {!legacyMode && (
          <>
            <SettingRow icon={Layers} label={t("appearance.style")} desc={t("appearance.style.desc")} divider={false} />
            <div className="style-tiles" role="radiogroup" aria-label={t("appearance.style")}>
              {STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  role="radio"
                  aria-checked={themeStyle === style}
                  className={`style-tile${themeStyle === style ? " active" : ""}`}
                  onClick={() => handleThemeStyleChange(style)}
                >
                  <span className={`style-tile-preview style-preview-${style}`}>
                    <span className="style-tile-pill">
                      <i />
                      <i />
                    </span>
                    <span className="style-tile-dock">
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                  <span className="style-tile-label">{t(`appearance.style.${style}`)}</span>
                </button>
              ))}
            </div>
            <div className="setting-divider" />
            {(themeStyle === "frosted" || themeStyle === "liquid") && <GlassWallpaper />}

            <SettingRow
              icon={ImagePlus}
              label={t("appearance.logo")}
              desc={logoError || t("appearance.logo.desc")}
              stacked
            >
              <div className="logo-picker">
                <span className="logo-picker-preview">
                  <img src={kiroLogo} alt="" draggable={false} />
                </span>
                <label className={`logo-picker-btn${logoBusy ? " busy" : ""}`}>
                  {logoBusy ? t("notepad.images.adding") : t("appearance.logo.choose")}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    disabled={logoBusy}
                    onChange={(e) => {
                      void pickLogo(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button type="button" className="logo-picker-reset" onClick={() => resetKiroLogo()}>
                  {t("appearance.logo.reset")}
                </button>
              </div>
              <span className="logo-picker-hint">{t("appearance.logo.hint")}</span>
            </SettingRow>
          </>
        )}

        <SettingRow icon={Palette} label={t("appearance.mode")} desc={t("appearance.mode.desc")}>
          <Dropdown
            value={themeMode}
            onChange={handleThemeModeChange}
            options={[
              { value: "auto", label: t("appearance.mode.auto") },
              { value: "dark", label: t("appearance.mode.dark") },
              { value: "light", label: t("appearance.mode.light") },
              { value: "custom", label: t("appearance.mode.custom") },
              { value: "adaptive", label: t("appearance.mode.adaptive") },
            ]}
          />
        </SettingRow>

        {!legacyMode && (
          <div className="season-setting-block">
            <SettingRow icon={Snowflake} label={t("appearance.season")} desc={t("appearance.season.desc")} divider={false} />
            <div className="season-picker-grid" role="radiogroup" aria-label={t("appearance.season")}>
              {seasonOptions.map((opt) => {
                const selected = seasonTheme === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`season-card season-tone-${opt.tone} ${selected ? "active" : ""}`}
                    onClick={() => handleSeasonChange(opt.value)}
                  >
                    <span className="season-card-glyph" aria-hidden="true">
                      {opt.value === "auto" && (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <rect x="3" y="4" width="18" height="17" rx="3" />
                          <path d="M8 2v4M16 2v4M3 10h18" />
                          <circle cx="12" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
                        </svg>
                      )}
                      {opt.value === "snow" && (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <path d="M12 2v20M4.9 6l14.2 12M19.1 6L4.9 18M9 4l3 3 3-3M9 20l3-3 3 3" />
                        </svg>
                      )}
                      {opt.value === "rain" && (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 19c2-7 8-12 14-14-1 7-6 13-14 14Z" fill="currentColor" fillOpacity="0.22" />
                          <path d="M5 19c4-4 8-8 14-14" />
                          <circle cx="16.5" cy="16.5" r="2" fill="currentColor" fillOpacity="0.4" />
                        </svg>
                      )}
                      {opt.value === "leaves" && (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 3l2.2 4.5 4.8-1-2 4.3 3.5 2.7-4.5 1.8.8 3.7-4.8-2.5L7.2 19l.8-3.7L3.5 13.5 7 10.8l-2-4.3 4.8 1z" fill="currentColor" fillOpacity="0.22" />
                          <path d="M12 15v6" />
                        </svg>
                      )}
                      {opt.value === "blossom" && (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <circle cx="12" cy="7" r="3" fill="currentColor" fillOpacity="0.24" />
                          <circle cx="17" cy="11" r="3" fill="currentColor" fillOpacity="0.24" />
                          <circle cx="15" cy="17" r="3" fill="currentColor" fillOpacity="0.24" />
                          <circle cx="9" cy="17" r="3" fill="currentColor" fillOpacity="0.24" />
                          <circle cx="7" cy="11" r="3" fill="currentColor" fillOpacity="0.24" />
                          <circle cx="12" cy="12" r="2" fill="currentColor" />
                        </svg>
                      )}
                      {opt.value === "off" && (
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <circle cx="12" cy="12" r="8" />
                          <path d="m6.5 6.5 11 11" />
                        </svg>
                      )}
                    </span>
                    <span className="season-card-label">{opt.label}</span>
                  </button>
                );
              })}
            </div>
            {seasonTheme !== "off" && (
              <SettingRow
                icon={Zap}
                label={t("appearance.fpsBoost")}
                desc={t("appearance.fpsBoost.desc")}
                divider={false}
              >
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={fpsThrottled ?? false}
                    onChange={toggleFpsThrottled}
                  />
                  <span className="slider"></span>
                </label>
              </SettingRow>
            )}
            <div className="setting-divider" />
          </div>
        )}

        <SettingRow icon={SwatchBook} label={t("appearance.presets")} desc={t("appearance.presets.desc")}>
          <div className="preset-swatches">
            {THEME_PRESETS.map((preset) => {
              const name = t(`appearance.preset.${preset.name.toLowerCase()}`);
              return (
                <button
                  key={preset.name}
                  type="button"
                  className={`preset-swatch${isActivePreset(preset) ? " active" : ""}`}
                  style={{ background: presetBackground(preset) }}
                  onClick={() => applyThemePreset(preset)}
                  title={name}
                  aria-label={name}
                >
                  <span style={{ background: preset.accent }} />
                </button>
              );
            })}
          </div>
        </SettingRow>

        {!legacyMode && (
          <SettingRow
            icon={Highlighter}
            label={t("appearance.accent")}
            desc={isMaterial ? t("appearance.accent.descMaterial") : t("appearance.accent.desc")}
          >
            <Dropdown
              value={isMaterial && themeAccent === "mono" ? "system" : themeAccent}
              onChange={handleAccentChange}
              options={[
                ...(isMaterial ? [] : [{ value: "mono", label: t("appearance.accent.mono") }]),
                { value: "system", label: t("appearance.accent.system") },
                { value: "custom", label: t("appearance.accent.custom") },
              ]}
            />
          </SettingRow>
        )}

        {!legacyMode && themeAccent === "custom" && (
          <SettingRow icon={Droplet} label={t("appearance.accentColor")} desc={t("appearance.accentColor.desc")}>
            <div className="color-picker-row">
              <input
                type="color"
                value={themeAccentColor}
                onChange={(e) => handleAccentColorChange(e.target.value)}
                className="color-picker-input"
              />
              <span className="color-picker-label">{themeAccentColor.toUpperCase()}</span>
            </div>
          </SettingRow>
        )}

        {showCustomColor && (
          <SettingRow icon={Droplet} label={t("appearance.color")} desc={t("appearance.color.desc")}>
            <div className="color-picker-row">
              <input
                type="color"
                value={themeColor}
                onChange={(e) => handleThemeColorChange(e.target.value)}
                className="color-picker-input"
              />
              <span className="color-picker-label">{themeColor.toUpperCase()}</span>
            </div>
          </SettingRow>
        )}

        <SettingRow
          icon={Contrast}
          label={t("appearance.opacity")}
          desc={t("appearance.opacity.desc", { percent: Math.round(themeOpacity * 100) })}
          divider={showAdvancedSliders}
        >
          <input
            type="range"
            min="0.1"
            max="1.0"
            step="0.05"
            value={themeOpacity}
            onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
            className="settings-slider"
          />
        </SettingRow>

        {showAdvancedSliders && (
          <>
            <SettingRow
              icon={Droplets}
              label={t("appearance.saturation")}
              desc={t("appearance.saturation.desc", { percent: Math.round(themeSaturation * 100) })}
            >
              <input
                type="range"
                min="0.0"
                max="1.0"
                step="0.02"
                value={themeSaturation}
                onChange={(e) => handleSaturationChange(parseFloat(e.target.value))}
                className="settings-slider"
              />
            </SettingRow>

            <SettingRow
              icon={Sun}
              label={t("appearance.brightness")}
              desc={t("appearance.brightness.desc", { percent: Math.round(themeBrightness * 100) })}
              divider={false}
            >
              <input
                type="range"
                min="0.0"
                max="1.0"
                step="0.02"
                value={themeBrightness}
                onChange={(e) => handleBrightnessChange(parseFloat(e.target.value))}
                className="settings-slider"
              />
            </SettingRow>
          </>
        )}
      </SettingSection>

      <SettingSection id="appearance-display" title={t("appearance.display.group")}>
        <SettingRow icon={Square} label={t("appearance.corners")} desc={t("appearance.corners.desc")}>
          <label className="toggle-switch">
            <input type="checkbox" checked={cornersEnabled} onChange={toggleCorners} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow
          icon={Maximize2}
          label={t("appearance.scale")}
          desc={t("appearance.scale.desc", { percent: Math.round(scale * 100) })}
          divider={false}
        >
          <div className="scale-button-container">
            <button
              onClick={() => handleScaleChange(Math.max(0.8, parseFloat((scale - 0.1).toFixed(1))))}
              disabled={scale <= 0.8}
              className="scale-adjust-btn"
              title={t("appearance.scale.decrease")}
            >
              —
            </button>
            <span className="scale-display-value">{Math.round(scale * 100)}%</span>
            <button
              onClick={() => handleScaleChange(Math.min(1.3, parseFloat((scale + 0.1).toFixed(1))))}
              disabled={scale >= 1.3}
              className="scale-adjust-btn"
              title={t("appearance.scale.increase")}
            >
              +
            </button>
          </div>
        </SettingRow>
      </SettingSection>
    </>
  );
}
