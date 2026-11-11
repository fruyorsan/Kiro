import { Palette, Droplet, Contrast, Droplets, Sun, Square, Maximize2, Layers, SwatchBook, Highlighter, ImagePlus, Snowflake } from "lucide-react";
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
}: AppearanceTabProps) {
  const t = useT();
  const kiroLogo = useKiroLogo();
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [seasonTheme, setSeasonThemeState] = useState(() => localStorage.getItem(SEASON_SETTING) ?? "auto");
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

  return (
    <>
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
          <SettingRow icon={Snowflake} label={t("appearance.season")} desc={t("appearance.season.desc")}>
            <Dropdown
              value={seasonTheme}
              onChange={handleSeasonChange}
              options={[
                { value: "auto", label: t("appearance.season.auto") },
                { value: "winter", label: t("appearance.season.winter") },
                { value: "spring", label: t("appearance.season.spring") },
                { value: "summer", label: t("appearance.season.summer") },
                { value: "autumn", label: t("appearance.season.autumn") },
                { value: "off", label: t("appearance.season.off") },
              ]}
            />
          </SettingRow>
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
