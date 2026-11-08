import { Power, Download, Clock, History, BatteryWarning, RefreshCw, LogOut, Languages, MemoryStick, Zap, Gamepad2, Sparkles, KeyRound, Cpu } from "lucide-react";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SettingRow } from "./SettingRow";
import { SettingSection } from "./SettingSection";
import { Dropdown } from "./Dropdown";
import { LANGUAGES, getLanguagePreference, setLanguagePreference, useT } from "../i18n";

/**
 * Live "auto performance is running" pill. The mode engages on its own when a
 * fullscreen app takes over, so the settings page is the only place where the
 * user can see that it works.
 */
function PerfStateBadge() {
  const t = useT();
  const [active, setActive] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_perf_mode").then((on) => setActive(!!on)).catch(() => {});
    const unlisten = listen<boolean>("perf-mode", (event) => setActive(!!event.payload));
    return () => {
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  return (
    <span className={`perf-state-pill${active ? " is-active" : ""}`}>
      <span className="perf-state-dot" />
      {active ? t("general.autoPerf.on") : t("general.autoPerf.auto")}
    </span>
  );
}

/**
 * Live "fps boost is running" pill. Shows the game Kiro is boosting right now,
 * so the capability is visible without a settings switch per game.
 */
function FpsBoostBadge() {
  const t = useT();
  const [game, setGame] = useState<string | null>(null);

  useEffect(() => {
    const name = (exe?: string | null) => (exe ? exe.split(/[\\/]/).pop() ?? null : null);
    invoke<{ active: boolean; exe: string | null }>("fps_boost_state")
      .then((s) => setGame(s.active ? name(s.exe) : null))
      .catch(() => {});
    const unlisten = listen<{ active: boolean; exe: string | null }>("fps-boost", (event) => {
      const payload = event.payload;
      setGame(payload?.active ? name(payload.exe) : null);
    });
    return () => {
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  return (
    <span className={`perf-state-pill${game ? " is-active" : ""}`}>
      <span className="perf-state-dot" />
      {game ?? t("general.autoPerf.auto")}
    </span>
  );
}

interface AuditFinding {
  level: "good" | "warn" | "bad" | "info" | string;
  title: string;
  detail: string;
  gain: string;
}

interface AuditReport {
  gpus: Array<{
    name: string;
    driver: string;
    power_limit: number | null;
    power_max: number | null;
    display_active: boolean | null;
    utilization: number | null;
  }>;
  refresh_hz: number;
  ram_total_mb: number;
  ram_modules: string[];
  ram_asymmetric: boolean;
  hags: boolean;
  game_drive: string | null;
  findings: AuditFinding[];
}

interface ProfileInfo {
  exe: string;
  name: string;
  applied: boolean;
}

/**
 * The honest half of the FPS feature: read the machine and tell the user what
 * is actually costing them frames, instead of applying more silent tweaks.
 */
function FpsAuditPanel() {
  const t = useT();
  const [report, setReport] = useState<AuditReport | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [tweaks, setTweaks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProfiles = () => {
    invoke<ProfileInfo[]>("fps_boost_profiles").then(setProfiles).catch(() => {});
  };

  useEffect(() => {
    loadProfiles();
    invoke<boolean>("fps_boost_system_tweaks_active").then(setTweaks).catch(() => {});
  }, []);

  const runAudit = () => {
    setBusy(true);
    setError(null);
    invoke<AuditReport>("fps_boost_audit", { exe: null })
      .then(setReport)
      .catch((e) => setError(typeof e === "string" ? e : String(e)))
      .finally(() => setBusy(false));
  };

  const toggleTweaks = () => {
    const next = !tweaks;
    setTweaks(next);
    invoke<boolean>("fps_boost_set_system_tweaks", { enabled: next })
      .then(setTweaks)
      .catch((e) => {
        setTweaks(!next);
        setError(typeof e === "string" ? e : String(e));
      });
  };

  const removeProfile = (exe: string) => {
    invoke("fps_boost_remove_profile", { exe })
      .then(loadProfiles)
      .catch((e) => setError(typeof e === "string" ? e : String(e)));
  };

  const restoreAll = () => {
    invoke("fps_boost_restore_all").then(loadProfiles).catch(() => {});
  };

  return (
    <>
      <SettingRow
        icon={Gamepad2}
        label={t("general.fpsBoost.systemTweaks")}
        desc={t("general.fpsBoost.systemTweaks.desc")}
      >
        <label className="toggle-switch">
          <input type="checkbox" checked={tweaks} onChange={toggleTweaks} />
          <span className="slider"></span>
        </label>
      </SettingRow>

      <SettingRow
        icon={Zap}
        label={t("general.fpsBoost.audit")}
        desc={t("general.fpsBoost.audit.desc")}
        action
        onClick={busy ? undefined : runAudit}
        divider={profiles.length > 0}
      >
        <span className="fps-audit-button">{busy ? t("general.fpsBoost.running") : t("general.fpsBoost.run")}</span>
      </SettingRow>

      {error && <div className="fps-audit-error">{error}</div>}

      {report && (
        <div className="fps-audit">
          {report.findings.map((finding, index) => (
            <div key={index} className={`fps-audit-item is-${finding.level}`}>
              <div className="fps-audit-head">
                <span className="fps-audit-title">{finding.title}</span>
                {finding.gain && finding.gain !== "—" && (
                  <span className="fps-audit-gain">{finding.gain}</span>
                )}
              </div>
              <p className="fps-audit-detail">{finding.detail}</p>
            </div>
          ))}
          {report.ram_modules.length > 0 && (
            <p className="fps-audit-meta">{report.ram_modules.join(" · ")}</p>
          )}
        </div>
      )}

      {profiles.length > 0 && (
        <div className="fps-profiles">
          <div className="fps-profiles-head">
            <span>{t("general.fpsBoost.profiles")}</span>
            <button type="button" className="fps-link" onClick={restoreAll}>
              {t("general.fpsBoost.restoreAll")}
            </button>
          </div>
          {profiles.map((profile) => (
            <div key={profile.exe} className="fps-profile">
              <span className={`fps-profile-dot${profile.applied ? " is-applied" : ""}`} />
              <span className="fps-profile-name">{profile.name}</span>
              <button type="button" className="fps-link" onClick={() => removeProfile(profile.exe)}>
                {t("general.fpsBoost.undo")}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

interface GeneralTabProps {
  autostart: boolean;
  toggleAutostart: () => void;
  timeFormat24h: boolean;
  toggleTimeFormat24h: () => void;
  legacyMode: boolean;
  toggleLegacyMode: () => void;
  showUpdateIndicator: boolean;
  toggleUpdateIndicator: () => void;
  ramSaver: boolean;
  toggleRamSaver: () => void;
  autoPerf: boolean;
  toggleAutoPerf: () => void;
  gameBoost: boolean;
  toggleGameBoost: () => void;
  fpsBoost: boolean;
  toggleFpsBoost: () => void;
  lowBatteryThreshold: number;
  hasBattery: boolean;
  handleThresholdChange: (val: number) => void;
  restartKiro: () => void;
  quitKiro: () => void;
}

/**
 * Notch AI settings. The provider picker chooses which assistant the notch
 * talks to; Claude can fall back to the local Claude Code CLI, ChatGPT and
 * Gemini use their HTTP APIs with the key stored here.
 */
const AI_PROVIDERS = [
  { value: "claude", label: "Claude", keyHint: "sk-ant-…", model: "claude-sonnet-4-5" },
  { value: "openai", label: "ChatGPT", keyHint: "sk-…", model: "gpt-4o-mini" },
  { value: "gemini", label: "Gemini", keyHint: "AIza…", model: "gemini-3.5-flash" },
];

function AiSection() {
  const t = useT();
  const [provider, setProvider] = useState(() => localStorage.getItem("kiro-ai-provider") ?? "claude");
  const [backend, setBackend] = useState(() => localStorage.getItem("kiro-ai-backend") ?? "auto");
  const providerInfo = AI_PROVIDERS.find((item) => item.value === provider) ?? AI_PROVIDERS[0];
  // Claude keeps the original keys so an existing setup survives the update.
  const keySetting = provider === "claude" ? "kiro-ai-key" : `kiro-ai-key-${provider}`;
  const modelSetting = provider === "claude" ? "kiro-ai-model" : `kiro-ai-model-${provider}`;
  const [key, setKey] = useState(() => localStorage.getItem(keySetting) ?? "");
  const [model, setModel] = useState(
    () => localStorage.getItem(modelSetting) ?? providerInfo.model
  );

  useEffect(() => {
    setKey(localStorage.getItem(keySetting) ?? "");
    setModel(localStorage.getItem(modelSetting) ?? providerInfo.model);
  }, [keySetting, modelSetting, providerInfo.model]);

  const save = (k: string, v: string) => {
    localStorage.setItem(k, v);
    invoke("save_setting", { key: k, value: v }).catch(() => {});
  };

  const backendOptions = [
    { value: "auto", label: t("general.aiBackend.auto") },
    { value: "cli", label: t("general.aiBackend.cli") },
    { value: "api", label: t("general.aiBackend.api") },
  ];

  return (
    <SettingSection id="general-ai" title={t("general.aiSection")}>
      <SettingRow icon={Sparkles} label={t("general.aiProvider")} desc={t("general.aiProvider.desc")}>
        <Dropdown
          value={provider}
          options={AI_PROVIDERS.map((item) => ({ value: item.value, label: item.label }))}
          onChange={(value) => {
            setProvider(value);
            save("kiro-ai-provider", value);
          }}
        />
      </SettingRow>

      {provider === "claude" && (
        <SettingRow icon={Sparkles} label={t("general.aiBackend")} desc={t("general.aiBackend.desc")}>
          <Dropdown
            value={backend}
            options={backendOptions}
            onChange={(value) => {
              setBackend(value);
              save("kiro-ai-backend", value);
            }}
          />
        </SettingRow>
      )}

      <SettingRow icon={KeyRound} label={t("general.aiKey")} desc={t("general.aiKey.desc")}>
        <input
          className="ai-settings-input"
          type="password"
          value={key}
          placeholder={providerInfo.keyHint}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setKey(e.target.value);
            save(keySetting, e.target.value.trim());
          }}
        />
      </SettingRow>

      <SettingRow icon={Cpu} label={t("general.aiModel")} desc={t("general.aiModel.desc")} divider={false}>
        <input
          className="ai-settings-input"
          type="text"
          value={model}
          placeholder={providerInfo.model}
          spellCheck={false}
          onChange={(e) => {
            setModel(e.target.value);
            save(modelSetting, e.target.value.trim());
          }}
        />
      </SettingRow>
    </SettingSection>
  );
}

export function GeneralTab({
  autostart,
  toggleAutostart,
  timeFormat24h,
  toggleTimeFormat24h,
  legacyMode,
  toggleLegacyMode,
  showUpdateIndicator,
  toggleUpdateIndicator,
  ramSaver,
  toggleRamSaver,
  autoPerf,
  toggleAutoPerf,
  gameBoost,
  toggleGameBoost,
  fpsBoost,
  toggleFpsBoost,
  lowBatteryThreshold,
  hasBattery,
  handleThresholdChange,
  restartKiro,
  quitKiro,
}: GeneralTabProps) {
  const t = useT();
  const languageOptions = [
    { value: "system", label: t("general.language.system") },
    ...Object.entries(LANGUAGES).map(([value, { name }]) => ({ value, label: name })),
  ];
  return (
    <>
      <SettingSection id="general-system" title={t("general.system")} defaultOpen>
        <SettingRow icon={Power} label={t("general.launchAtLogin")} desc={t("general.launchAtLogin.desc")}>
          <label className="toggle-switch">
            <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={Download} label={t("general.updateIndicator")} desc={t("general.updateIndicator.desc")}>
          <label className="toggle-switch">
            <input type="checkbox" checked={showUpdateIndicator} onChange={toggleUpdateIndicator} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow icon={Languages} label={t("general.language")} desc={t("general.language.desc")}>
          <Dropdown value={getLanguagePreference()} options={languageOptions} onChange={setLanguagePreference} />
        </SettingRow>

        <SettingRow icon={Clock} label={t("general.time24h")} desc={t("general.time24h.desc")}>
          <label className="toggle-switch">
            <input type="checkbox" checked={timeFormat24h} onChange={toggleTimeFormat24h} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow
          icon={History}
          label={t("general.legacyMode")}
          desc={t("general.legacyMode.desc")}
        >
          <label className="toggle-switch">
            <input type="checkbox" checked={legacyMode} onChange={toggleLegacyMode} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow
          icon={MemoryStick}
          label={t("general.ramSaver")}
          desc={t("general.ramSaver.desc")}
        >
          <label className="toggle-switch">
            <input type="checkbox" checked={ramSaver} onChange={toggleRamSaver} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        <SettingRow
          icon={Zap}
          label={t("general.autoPerf")}
          desc={t("general.autoPerf.desc")}
        >
          <div className="perf-row-controls">
            <PerfStateBadge />
            <label className="toggle-switch">
              <input type="checkbox" checked={autoPerf} onChange={toggleAutoPerf} />
              <span className="slider"></span>
            </label>
          </div>
        </SettingRow>

        <SettingRow
          icon={Gamepad2}
          label={t("general.gameBoost")}
          desc={t("general.gameBoost.desc")}
        >
          <label className="toggle-switch">
            <input type="checkbox" checked={gameBoost} onChange={toggleGameBoost} />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {hasBattery && (
          <SettingRow
            icon={BatteryWarning}
            label={t("general.lowBattery")}
            desc={t("general.lowBattery.desc", { percent: lowBatteryThreshold })}
            divider={false}
          >
            <input
              type="range"
              min="5"
              max="50"
              step="5"
              value={lowBatteryThreshold}
              onChange={(e) => handleThresholdChange(parseInt(e.target.value))}
              className="settings-slider"
            />
          </SettingRow>
        )}
      </SettingSection>

      <SettingSection id="general-fps" title={t("general.fpsSection")}>
        <SettingRow
          icon={Gamepad2}
          label={t("general.fpsBoost")}
          desc={t("general.fpsBoost.desc")}
        >
          <div className="perf-row-controls">
            <FpsBoostBadge />
            <label className="toggle-switch">
              <input type="checkbox" checked={fpsBoost} onChange={toggleFpsBoost} />
              <span className="slider"></span>
            </label>
          </div>
        </SettingRow>
        <FpsAuditPanel />
      </SettingSection>

      <AiSection />

      <SettingSection id="general-app" title={t("general.app")}>
        <SettingRow icon={RefreshCw} label={t("general.restart")} desc={t("general.restart.desc")} action onClick={restartKiro} />
        <SettingRow icon={LogOut} label={t("general.quit")} desc={t("general.quit.desc")} action danger onClick={quitKiro} divider={false} />
      </SettingSection>
    </>
  );
}
