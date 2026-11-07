import { motion, AnimatePresence, useAnimation } from "framer-motion";
import { useEffect, useState, useCallback, useRef, useMemo, memo } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UpdateCheckResult } from "./updater";
import "./App.css";
import "./surfaces.css";
import { initTheme } from "./theme";
import { hydrateStorageFromSettings } from "./migrate";
import { PlayIcon, PauseIcon, SkipBackIcon, SkipForwardIcon, VolumeLowIcon, VolumeHighIcon, MusicNoteIcon } from "./icons";
import { CompactMediaPlayer } from "./CompactMediaPlayer";
import { artTheme, FALLBACK_THEME, type ArtTheme } from "./music/palette";
import { useWeather } from "./hooks/useWeather";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useTrailingThrottle } from "./hooks/useTrailingThrottle";
import { useCaldav } from "./hooks/useCaldav";
import { NotchCalendar } from "./components/NotchCalendar";
import { NotchClock, StopwatchReadout } from "./components/NotchClock";
import { MediaSourceButton, type MediaSession } from "./components/MediaSourceButton";
import { ConnectionsView } from "./components/ConnectionsView";
import { NotchTour } from "./components/NotchTour";
import { useStopwatch } from "./hooks/useStopwatch";
import { t as translate, useT, dateLocale } from "./i18n";
import { NotchShelf, useShelf } from "./components/NotchShelf";
import { parseCcLayout, parsePanelOrder, resolveCcLayout, type CcKind } from "./panelOrder";
import { NotchProgressBorder } from "./components/NotchProgressBorder";
import { SurfaceShape } from "./components/SurfaceShape";
import { playAgentSound } from "./agentSounds";
import { AgentLeft, AgentDot, AgentPanel, type AgentActivity } from "./components/AgentStatus";
import type { WidgetConfig } from "./components/StatusWidgetConfig";
import {
  DEFAULT_DUAL_CLOCK_ZONE,
  dayShiftLabel,
  formatZoneTime,
  measureDualClock,
  zoneDayShift,
  zoneDifferenceLabel,
  zoneOffsetLabel,
} from "./dualClock";
import {
  ChevronRight,
  Cpu,
  MemoryStick,
  HardDrive,
  ArrowUpDown,
} from "lucide-react";
import { setVisibleInterval } from "./hooks/visibleInterval";

// One critically damped spring for the notch's width, height and corners, so the shape settles
// together without overshooting or wobbling.
const SHELL_SPRING = { type: "spring", stiffness: 400, damping: 40 } as const;

// Timer chime, synthesized with Web Audio so there's no asset. The context is made on the
// Start click so autoplay lets it play when the timer ends.
let timerChimeCtx: AudioContext | null = null;

const getTimerChimeCtx = (): AudioContext | null => {
  try {
    if (!timerChimeCtx) timerChimeCtx = new AudioContext();
    if (timerChimeCtx.state === "suspended") timerChimeCtx.resume().catch(() => {});
    return timerChimeCtx;
  } catch {
    return null;
  }
};

const playTimerChime = () => {
  const ctx = getTimerChimeCtx();
  if (!ctx) return;
  const start = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = 0.45;
  master.connect(ctx.destination);

  // Rising bell (A5, C#6, E6) with a quiet harmonic.
  const notes = [
    { freq: 880.0, at: 0 },
    { freq: 1108.73, at: 0.18 },
    { freq: 1318.51, at: 0.36 },
  ];
  notes.forEach(({ freq, at }) => {
    const osc = ctx.createOscillator();
    const harmonic = ctx.createOscillator();
    const gain = ctx.createGain();
    const harmonicGain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    harmonic.type = "sine";
    harmonic.frequency.value = freq * 2.01;
    harmonicGain.gain.value = 0.12;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(0.32, start + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 1.4);
    osc.connect(gain);
    harmonic.connect(harmonicGain);
    harmonicGain.connect(gain);
    gain.connect(master);
    osc.start(start + at);
    harmonic.start(start + at);
    osc.stop(start + at + 1.5);
    harmonic.stop(start + at + 1.5);
  });
};

// Simple SVG icons
function WifiIcon({ enabled, connected }: { enabled: boolean; connected: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity={!enabled ? 0.4 : connected ? 1 : 0.7}>
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function batteryTooltip(charging: boolean, level: number, secondsLeft: number | null): string {
  if (charging && level >= 100) return translate("battery.full");
  const state = translate(charging ? "battery.charging" : "battery.onBattery");
  if (secondsLeft === null || secondsLeft <= 0) return translate("battery.status", { state, level });
  return translate(charging ? "battery.untilFull" : "battery.left", { state, level, duration: formatDuration(secondsLeft) });
}

function EthernetIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="11" rx="2" />
      <path d="M8 15v3h8v-3" />
      <line x1="9" y1="8" x2="9" y2="11" />
      <line x1="12" y1="8" x2="12" y2="11" />
      <line x1="15" y1="8" x2="15" y2="11" />
    </svg>
  );
}

function TrayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="15" width="6" height="6" rx="1" />
      <rect x="3" y="15" width="6" height="6" rx="1" />
    </svg>
  );
}

function BatteryIcon({ charging, level, threshold = 20 }: { charging: boolean; level: number; threshold?: number }) {
  const percentage = Math.min(Math.max(level, 0), 100);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      position: 'relative',
      height: '14px',
      justifyContent: 'center'
    }}>
      <svg width="20" height="10" viewBox="0 0 20 10" fill="none">
        {/* Battery Shell - Centered at 9px within 20px width, ignoring the tip's offset */}
        <rect
          x="2" y="0.75" width="14" height="8.5" rx="2.4"
          stroke="currentColor" strokeOpacity={0.35} strokeWidth="1.1"
        />
        {/* Battery Tip */}
        <path
          d="M17.5 3.5V6.5"
          stroke="currentColor" strokeOpacity={0.35} strokeWidth="1.2" strokeLinecap="round"
        />
        {/* Fill */}
        <rect
          x="3.8" y="2.5"
          width={Math.max(0.5, (percentage / 100) * 10.4)}
          height="5" rx="1"
          fill={charging ? "#32D74B" : (percentage <= threshold ? "#FF453A" : "white")}
        />
      </svg>
      {/* Charging Bolt - Centered on the battery body */}
      {charging && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '9px',
          transform: 'translate(-50%, -50%)',
          color: 'white',
          filter: 'drop-shadow(0px 0px 1.5px rgba(0,0,0,0.8))'
        }}>
          <svg width="7" height="10" viewBox="0 0 8 12" fill="currentColor">
            <path d="M4.5 0L0 7H3.5L2.5 12L8 5H4.5L5.5 0H4.5Z" />
          </svg>
        </div>
      )}
    </div>
  );
}

function GreenDownArrowIcon() {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '18px',
      height: '18px',
      borderRadius: '50%',
      background: 'rgba(50, 215, 75, 0.15)',
      border: '1px solid rgba(50, 215, 75, 0.35)',
      boxShadow: '0 0 8px rgba(50, 215, 75, 0.25)',
      flexShrink: 0,
      verticalAlign: 'middle'
    }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#32D74B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="4" x2="12" y2="16"></line>
        <polyline points="18 10 12 16 6 10"></polyline>
        <line x1="6" y1="20" x2="18" y2="20"></line>
      </svg>
    </div>
  );
}

export const Visualizer = memo(function Visualizer({ isPlaying, bars = 5, height = 20 }: { isPlaying: boolean; bars?: number; height?: number }) {
  const [audioData, setAudioData] = useState<number[]>(new Array(bars).fill(0.18));

  useEffect(() => {
    if (!isPlaying) {
      setAudioData(new Array(bars).fill(0.18));
      return;
    }

    // Frames arrive in bursts faster than the screen refreshes; keep the newest and render it
    // once per frame instead of re-rendering (and restarting the bar springs) for every event.
    let latest: number[] | null = null;
    let frame = 0;
    const unlisten = listen<{ frequencies: number[] }>("audio-visualization", (event) => {
      // If we receive fewer frequencies than bars, repeat or interpolate
      // If more, slice
      let data = event.payload.frequencies;
      if (data.length > bars) data = data.slice(0, bars);
      while (data.length < bars) data.push(0.18);
      latest = data;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (latest) setAudioData(latest);
        });
      }
    });

    return () => {
      unlisten.then(fn => fn());
      cancelAnimationFrame(frame);
    };
  }, [isPlaying, bars]);

  return (
    <div className="visualizer-horizontal" style={{ height: `${height}px`, width: `${bars * 6}px` }}>
      {audioData.map((value, i) => (
        <div
          key={i}
          className="bar-horizontal"
          style={{
            transform: `scaleY(${isPlaying ? Math.max(0.2, value) : 0.1})`,
            opacity: isPlaying ? 0.95 : 0.5,
          }}
        />
      ))}
    </div>
  );
});

function UpdateActivity() {
  return (
    <div className="update-activity">
      <motion.div
        className="update-activity-glow"
        animate={{ opacity: [0.5, 1, 0.5], scale: [0.9, 1, 0.9] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#32D74B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v11" />
          <path d="M6 12l6 6 6-6" />
        </svg>
      </motion.div>
    </div>
  );
}

interface WifiStatus {
  enabled: boolean;
  connected: boolean;
}

interface MediaInfo {
  title: string;
  artist: string;
  is_playing: boolean;
  has_media: boolean;
  artwork?: string[];
  position_ms?: number;
  duration_ms?: number;
  seek_enabled?: boolean;
  position_updated_at?: number;
}

const MARQUEE_SPEED = 30; // px/s — constant for all titles
const MARQUEE_MIN_DURATION = 5; // floor so short titles don't flicker

const TitleMarquee = ({ title }: { title: string }) => {
  const textRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [scrollDistance, setScrollDistance] = useState(0);
  const [scrollDuration, setScrollDuration] = useState(8);

  useEffect(() => {
    const check = () => {
      if (textRef.current && containerRef.current) {
        const textWidth = textRef.current.scrollWidth;
        const containerWidth = containerRef.current.clientWidth;
        const overflow = textWidth > containerWidth;
        setIsOverflowing(overflow);
        if (overflow) {
          const distance = textWidth - containerWidth;
          setScrollDistance(distance);
          setScrollDuration(Math.max(distance / MARQUEE_SPEED, MARQUEE_MIN_DURATION));
        }
      }
    };
    check();
    const observer = new ResizeObserver(check);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [title]);

  return (
    <div ref={containerRef} className="premium-title-wrap" style={{ width: '100%', overflow: 'hidden' }}>
      <span
        ref={textRef}
        className={`premium-title ${isOverflowing ? 'marquee' : ''}`}
        style={{
          '--scroll-distance': isOverflowing ? `-${scrollDistance}px` : undefined,
          '--scroll-duration': `${scrollDuration}s`,
        } as React.CSSProperties}
      >
        {title}
      </span>
    </div>
  );
};




function TimeDisplay({ hour12 }: { hour12: boolean }) {
  const format = () => new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12,
  });
  const [text, setText] = useState(format);

  useEffect(() => {
    let timer: number;
    const tick = () => {
      setText(format());
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => clearTimeout(timer);
  }, [hour12]);

  return <>{text}</>;
}

function App() {
  const t = useT();
  useEffect(() => {
    return initTheme({ backdrop: true });
  }, []);

  const [time, setTime] = useState("");
  const [dualTime, setDualTime] = useState("");
  const [dualDayShift, setDualDayShift] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [scale, setScale] = useState(() => parseFloat(localStorage.getItem("kiro-scale") || "1.0"));
  const [timeFormat24h, setTimeFormat24h] = useState(() => localStorage.getItem("kiro-time-format-24h") !== "false");


  const [batteryLevel, setBatteryLevel] = useState(100);
  const [isCharging, setIsCharging] = useState(false);
  const [batterySecondsLeft, setBatterySecondsLeft] = useState<number | null>(null);
  const [widgetTip, setWidgetTip] = useState<string | null>(null);
  const [hasBattery, setHasBattery] = useState(() => localStorage.getItem("kiro-has-battery") !== "false");
  const [showPowerPulse, setShowPowerPulse] = useState(false);
  const [showLowBatteryPulse, setShowLowBatteryPulse] = useState(false);
  const [lowBatteryThreshold, setLowBatteryThreshold] = useState(() => parseInt(localStorage.getItem("kiro-low-battery-threshold") || "20"));
  const prevChargingRef = useRef<boolean | null>(null);
  const powerPulseTimeoutRef = useRef<any>(null);
  const lowBatteryPulseShownRef = useRef<boolean>(false);

  const [eventPeek, setEventPeek] = useState(false);
  const eventPeekTimeoutRef = useRef<any>(null);
  const updatePulseTimerRef = useRef<any>(null);
  const triggerEventPeek = useCallback((duration = 3000) => {
    setEventPeek(true);
    if (eventPeekTimeoutRef.current) clearTimeout(eventPeekTimeoutRef.current);
    eventPeekTimeoutRef.current = setTimeout(() => setEventPeek(false), duration);
  }, []);

  const [notchMode, setNotchMode] = useState(() => {
    const raw = localStorage.getItem("kiro-notch-mode") || "fixed";
    if (raw === "auto-hide") return "smart";
    return raw;
  });


  useEffect(() => {
    if (hasBattery && isReady && prevChargingRef.current !== null && prevChargingRef.current !== isCharging) {
      setShowPowerPulse(true);
      if (notchMode === 'peek') triggerEventPeek(4000);
      if (powerPulseTimeoutRef.current) clearTimeout(powerPulseTimeoutRef.current);
      powerPulseTimeoutRef.current = setTimeout(() => {
        setShowPowerPulse(false);
      }, 4000);
    }
    prevChargingRef.current = isCharging;
  }, [isCharging, isReady, notchMode, triggerEventPeek, hasBattery]);

  useEffect(() => {
    // Trigger pulse when dropping below threshold while discharging
    if (hasBattery && isReady && batteryLevel <= lowBatteryThreshold && !isCharging && !lowBatteryPulseShownRef.current) {
      setShowLowBatteryPulse(true);
      if (notchMode === 'peek') triggerEventPeek(5000);
      lowBatteryPulseShownRef.current = true;
      setTimeout(() => setShowLowBatteryPulse(false), 5000);
    }

    // Reset the "shown" state if battery is charged or threshold is lowered
    if (isCharging || batteryLevel > lowBatteryThreshold) {
      lowBatteryPulseShownRef.current = false;
    }
  }, [batteryLevel, isCharging, lowBatteryThreshold, isReady, notchMode, triggerEventPeek, hasBattery]);

  // Weather state (managed by useWeather hook)

  // Media state
  const [isPlaying, setIsPlaying] = useState(false);
  const [mediaInfo, setMediaInfo] = useState<MediaInfo>({
    title: "",
    artist: "",
    is_playing: false,
    has_media: false
  });
  const [albumArtUrl, setAlbumArtUrl] = useState<string | null>(null);
  const [albumArtKey, setAlbumArtKey] = useState(0);
  const [musicTheme, setMusicTheme] = useState<ArtTheme>(FALLBACK_THEME);
  const musicThemeCache = useRef(new Map<string, ArtTheme>());
  const [volume, setVolume] = useState(0.5);
  const [isMuted, setIsMuted] = useState(false);
  // Sliders show 0 while muted, like the overlay.
  const displayVolume = isMuted ? 0 : volume;
  // null until the first fetch so the pill doesn't flash a wrong default.
  const [wifiStatus, setWifiStatus] = useState<WifiStatus | null>(null);
  const wifiEnabled = wifiStatus?.enabled ?? false;
  const wifiConnected = wifiStatus?.connected ?? false;
  const [bluetoothEnabled, setBluetoothEnabled] = useState(true);
  const [settingsLegacyMode, setSettingsLegacyMode] = useState(() => localStorage.getItem("kiro-legacy-mode") === "true");
  const [ccView, setCcView] = useState<'main' | 'wifi' | 'bluetooth' | 'audio'>('main');
  const showConnections = !settingsLegacyMode && ccView !== 'main';
  const [lanStatus, setLanStatus] = useState<{ present: boolean; connected: boolean; name: string } | null>(null);
  const showLan = !settingsLegacyMode && !!lanStatus?.connected && !(wifiStatus?.enabled && wifiStatus.connected);
  const [batterySaverEnabled, setBatterySaverEnabled] = useState(false);
  const [currentBrightness, setCurrentBrightness] = useState(50);

  // System metrics for status widgets
  const [cpuUsage, setCpuUsage] = useState(0);
  const [ramUsage, setRamUsage] = useState(0);
  const [diskSpace, setDiskSpace] = useState(0);
  const [netUpSpeed, setNetUpSpeed] = useState(0);
  const [netDownSpeed, setNetDownSpeed] = useState(0);
  const [statusWidgets, setStatusWidgets] = useState<WidgetConfig>({ left: ["weather"], right: ["battery"] });

  const [windowLabel, setWindowLabel] = useState<string>("");
  useEffect(() => {
    setWindowLabel(getCurrentWebviewWindow().label);
  }, []);
  const isNotchWindow = windowLabel === 'main' || windowLabel.startsWith('main-');

  // Update state
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [showUpdateIndicator, setShowUpdateIndicator] = useState(() => localStorage.getItem("kiro-show-update-indicator") !== "false");
  const [showUpdatePulse, setShowUpdatePulse] = useState(false);

  useEffect(() => {
    if (windowLabel !== 'main') return;

    let unlisten: (() => void) | undefined;
    let disposed = false;

    listen<UpdateCheckResult>("update-available", (event) => {
      setUpdateAvailable(event.payload.available);
      if (!event.payload.available) {
        setShowUpdatePulse(false);
        if (updatePulseTimerRef.current) clearTimeout(updatePulseTimerRef.current);
        return;
      }
      setShowUpdatePulse(true);
      if (notchMode === 'peek') triggerEventPeek(6000);
      if (updatePulseTimerRef.current) clearTimeout(updatePulseTimerRef.current);
      updatePulseTimerRef.current = setTimeout(() => {
        setShowUpdatePulse(false);
      }, 6000);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    invoke<UpdateCheckResult>("get_update_state")
      .then((state) => setUpdateAvailable(state.available))
      .catch((e) => console.error("Failed to read update state:", e));

    return () => {
      disposed = true;
      unlisten?.();
      if (updatePulseTimerRef.current) clearTimeout(updatePulseTimerRef.current);
    };
  }, [windowLabel, notchMode, triggerEventPeek]);

  const [isVisible, setIsVisible] = useState(true);
  const [isImpacted, setIsImpacted] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [startupAnimating, setStartupAnimating] = useState(false);

  const [dockMode, setDockMode] = useState(() => {
    const raw = localStorage.getItem("kiro-dock-mode") || "smart";
    if (raw === "auto-hide") return "smart";
    return raw;
  });
  const [dndActive, setDndActive] = useState(false);
  const [dockEnabled, setDockEnabled] = useState(() => localStorage.getItem("kiro-dock-enabled") !== "false");
  const [isNotchHovered, setIsNotchHovered] = useState(false);
  const [agentActivity, setAgentActivity] = useState<AgentActivity | null>(null);
  const lastAgentKey = useRef("");
  const windowLabelRef = useRef("");
  windowLabelRef.current = windowLabel;

  const [isEdgeHovered, setIsEdgeHovered] = useState(false);
  const [isOverlapped, setIsOverlapped] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [interactionState, setInteractionState] = useState<'active' | 'grace' | 'none'>('none');
  const kiroRef = useRef<HTMLDivElement>(null);
  const dockEnabledInitial = useRef(true);
  const dockModeInitial = useRef(true);
  const notchModeInitial = useRef(true);

  const [kiroMode, setKiroMode] = useState<'music' | 'calendar' | 'command-center' | 'status' | 'shelf' | 'tour' | 'agent'>('status');

  const isAnyInteraction = isHovered || isNotchHovered || isEdgeHovered;
  const [notchBottomRight, setNotchBottomRight] = useState(() => localStorage.getItem("kiro-notch-position") === "bottom-right");
  // The bottom-right layout is a floating pill, not an edge strip: it stays
  // visible and only gets out of the way for a fullscreen app (or a window
  // actually covering that corner, handled by the smart-mode overlap check).
  const notchIdleHidden = notchBottomRight
    ? (notchMode === 'smart' && isOverlapped && interactionState === 'none')
    : ((notchMode === 'smart' && isOverlapped && interactionState === 'none') ||
       (notchMode === 'peek' && interactionState === 'none' && !eventPeek));
  // The bottom-right layout is a floating pill: it sits over the corner where
  // fullscreen video players put their controls, so it gets out of the way
  // whenever an app owns the whole screen, whatever the notch mode.
  const isHidden = ((notchMode === 'smart' || notchMode === 'peek' || notchBottomRight) && isFullscreen) ||
    (!startupAnimating && kiroMode !== 'tour' && !(agentActivity && isNotchWindow) && notchIdleHidden);

  useEffect(() => {
    if (isAnyInteraction) {
      setInteractionState('active');
    } else if (interactionState !== 'none') {
      setInteractionState('grace');
      const timer = setTimeout(() => setInteractionState('none'), 800);
      return () => clearTimeout(timer);
    }
  }, [isAnyInteraction]);

  useEffect(() => {
    if (isNotchWindow) {
      invoke('set_notch_hovered', { hovered: isNotchHovered }).catch(() => { });
    }
  }, [isNotchHovered, isNotchWindow]);

  // Tell the backend when the notch is hidden (smart/peek) so it stays click-through.
  useEffect(() => {
    if (isNotchWindow) {
      invoke('set_notch_hidden', { hidden: !isVisible || isHidden }).catch(() => { });
    }
  }, [isVisible, isHidden, isNotchWindow]);

  useEffect(() => {
    let lastSent = "";
    const updateRect = () => {
      if (kiroRef.current && isNotchWindow) {
        const rect = kiroRef.current.getBoundingClientRect();
        const next = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
        const key = `${next.x},${next.y},${next.width},${next.height}`;
        if (key === lastSent) return;
        lastSent = key;
        invoke('update_notch_rect', { rect: next }).catch(() => { lastSent = ""; });
      }
    };

    updateRect();
    window.addEventListener('resize', updateRect);
    const observer = new ResizeObserver(updateRect);
    if (kiroRef.current) observer.observe(kiroRef.current);

    const poll = setVisibleInterval(updateRect, 500);

    return () => {
      window.removeEventListener('resize', updateRect);
      observer.disconnect();
      clearInterval(poll);
    };
  }, [isExpanded, isHidden, windowLabel, scale]);

  useEffect(() => {
    if (!windowLabel) return;

    // Only animate the main top-bar
    if (windowLabel !== 'main') {
      setIsReady(true);
      setIsImpacted(true);
      setIsExpanded(true);
      return;
    }

    const proceedWithStartup = () => {
      const checkVisibility = async () => {
        try {
          const win = getCurrentWebviewWindow();
          const visible = await win.isVisible();
          if (visible) {
            setStartupAnimating(true);
            setIsReady(true);
            setTimeout(() => {
              setIsImpacted(true);
              setIsExpanded(true);
            }, 240);
            setTimeout(() => setStartupAnimating(false), 1500);
            return true;
          }
        } catch (e) { }
        return false;
      };

      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        if (attempts > 50 && attempts % 10 !== 0) return;
        if (await checkVisibility()) clearInterval(interval);
      }, 100);

      checkVisibility();
      return interval;
    };

    const DOCK_SYNC_DELAY_MS = 400;
    const waitForSplash = () => {
      let started = false;
      let interval: any;
      let syncTimer: any;
      const begin = () => {
        if (started) return;
        started = true;
        syncTimer = setTimeout(() => { interval = proceedWithStartup(); }, DOCK_SYNC_DELAY_MS);
      };
      const unlistenSplash = listen("splash-done", () => {
        begin();
        unlistenSplash.then(fn => fn());
      });
      const safetyTimer = setTimeout(() => {
        begin();
        unlistenSplash.then(fn => fn());
      }, 6000);
      return () => {
        clearTimeout(safetyTimer);
        clearTimeout(syncTimer);
        if (interval) clearInterval(interval);
        unlistenSplash.then(fn => fn());
      };
    };

    return waitForSplash();
  }, [windowLabel]);

  // Settings state
  const [settingsWeatherEnabled, setSettingsWeatherEnabled] = useState(() => localStorage.getItem("kiro-weather-enabled") !== "false");
  const [settingsCalendarEnabled, setSettingsCalendarEnabled] = useState(() => localStorage.getItem("kiro-calendar-enabled") !== "false");
  const [settingsTimerEnabled, setSettingsTimerEnabled] = useState(
    () => (localStorage.getItem("kiro-timer-enabled") ?? localStorage.getItem("kiro-calendar-enabled")) !== "false",
  );
  const [settingsTimerSoundEnabled, setSettingsTimerSoundEnabled] = useState(
    () => localStorage.getItem("kiro-timer-sound-enabled") !== "false",
  );
  const [settingsTimerProgressEnabled, setSettingsTimerProgressEnabled] = useState(
    () => localStorage.getItem("kiro-notch-timer-progress") !== "false",
  );
  const [settingsStopwatchEnabled, setSettingsStopwatchEnabled] = useState(
    () => (localStorage.getItem("kiro-stopwatch-enabled") ?? localStorage.getItem("kiro-calendar-enabled")) !== "false",
  );
  const showClockColumn = settingsTimerEnabled || settingsStopwatchEnabled;
  const [settingsDualClockEnabled, setSettingsDualClockEnabled] = useState(() => localStorage.getItem("kiro-dual-clock-enabled") === "true");
  const [dualClockZone, setDualClockZone] = useState(() => localStorage.getItem("kiro-dual-clock-zone") || DEFAULT_DUAL_CLOCK_ZONE);
  const [dualClockLabel, setDualClockLabel] = useState(() => localStorage.getItem("kiro-dual-clock-label") || DEFAULT_DUAL_CLOCK_ZONE);
  const productivityEnabled = settingsCalendarEnabled || showClockColumn;
  const [settingsMusicModeEnabled, setSettingsMusicModeEnabled] = useState(() => localStorage.getItem("kiro-music-mode-enabled") !== "false");
  const [settingsMusicCompactNotch, setSettingsMusicCompactNotch] = useState(() => localStorage.getItem("kiro-music-compact-notch") !== "false");
  const [settingsScrollVolume, setSettingsScrollVolume] = useState(() => localStorage.getItem("kiro-notch-scroll-volume") === "true");
  const [settingsShelfPersist, setSettingsShelfPersist] = useState(() => localStorage.getItem("kiro-shelf-persist") === "true");
  const [settingsRememberMode, setSettingsRememberMode] = useState(() => localStorage.getItem("kiro-notch-remember-mode") === "true");
  const [panelControlCenter, setPanelControlCenter] = useState(() => localStorage.getItem("kiro-panel-control-center-enabled") !== "false");
  const [panelShelf, setPanelShelf] = useState(() => localStorage.getItem("kiro-panel-shelf-enabled") !== "false");
  const [panelOrder, setPanelOrder] = useState(() => parsePanelOrder(localStorage.getItem("kiro-panel-order")));
  // Date shown in the bottom-right pill. Minute precision is enough; the notch
  // re-renders often enough that a plain interval is cheaper than polling.
  const [todayDate, setTodayDate] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTodayDate(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const [ccLayout, setCcLayout] = useState(() => parseCcLayout(localStorage.getItem("kiro-cc-layout")));
  const ccResolved = resolveCcLayout(ccLayout);
  const ccStyle = (kind: CcKind, id: string) => {
    const index = ccResolved[kind].indexOf(id);
    return index < 0 ? { display: 'none' as const } : { order: index };
  };
  const rememberedModeRef = useRef<"command-center" | "calendar" | "shelf" | null>(null);
  // True while the shelf was the panel the user last saw (e.g. right after a
  // drop). Used to reopen it on the next hover instead of the quick settings.
  const wasShelfRef = useRef(false);
  const [settingsVisualizerEnabled, setSettingsVisualizerEnabled] = useState(() => localStorage.getItem("kiro-visualizer-enabled") !== "false");
  const [settingsAlbumArtEnabled, setSettingsAlbumArtEnabled] = useState(() => localStorage.getItem("kiro-media-album-art-enabled") !== "false");
  const [settingsAmbienceEnabled, setSettingsAmbienceEnabled] = useState(() => localStorage.getItem("kiro-media-ambience-enabled") !== "false");
  const [settingsCompactGlowEnabled, setSettingsCompactGlowEnabled] = useState(() => localStorage.getItem("kiro-media-compact-glow-enabled") !== "false");
  const [settingsArtworkTheme, setSettingsArtworkTheme] = useState(() => localStorage.getItem("kiro-media-artwork-theme") === "true");
  const [settingsCornersEnabled, setSettingsCornersEnabled] = useState(() => localStorage.getItem("kiro-corners-enabled") === "true");
  const [mediaLayout, setMediaLayout] = useState<'classic' | 'compact'>(() => (localStorage.getItem("kiro-media-layout") as 'classic' | 'compact') || 'classic');
  const [compactVolumeExpanded, setCompactVolumeExpanded] = useState(false);

  // Album-art color grading: extract the palette once per artwork URL and cache
  // it (Rust re-emits the same data URL for the same track, see services.rs).
  useEffect(() => {
    if (!settingsArtworkTheme || !albumArtUrl) {
      setMusicTheme(FALLBACK_THEME);
      return;
    }
    const cached = musicThemeCache.current.get(albumArtUrl);
    if (cached) {
      setMusicTheme(cached);
      return;
    }
    let cancelled = false;
    artTheme(albumArtUrl).then((theme) => {
      musicThemeCache.current.set(albumArtUrl, theme);
      if (!cancelled) setMusicTheme(theme);
    });
    return () => {
      cancelled = true;
    };
  }, [albumArtUrl, settingsArtworkTheme]);

  // Weather hook
  const { temperature, weatherCondition, weatherIcon: WeatherIcon, cityName, tempUnit } = useWeather(settingsWeatherEnabled);

  const refreshNotchMode = () => {
    invoke<string>('get_notch_mode_for_window').then(setNotchMode).catch(() => {});
  };

  const refreshDockMode = () => {
    invoke<string>('get_dock_mode_for_window').then(setDockMode).catch(() => {});
  };

  useEffect(() => {
    const unlisten = listen("monitors-changed", () => { refreshNotchMode(); refreshDockMode(); });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    if (!windowLabel) return;

    invoke("load_settings").then((settings: any) => {
      hydrateStorageFromSettings(settings);
      const getVal = (key: string, fallback: string | null = null) => {
        const val = settings[key];
        if (val !== undefined && val !== null) return String(val);
        const local = localStorage.getItem(key);
        if (local !== null) return local;
        return fallback;
      };

      setSettingsWeatherEnabled(getVal("kiro-weather-enabled", "true") !== "false");
      setSettingsCalendarEnabled(getVal("kiro-calendar-enabled", "true") !== "false");
      setSettingsTimerEnabled((getVal("kiro-timer-enabled") ?? getVal("kiro-calendar-enabled", "true")) !== "false");
      setSettingsTimerSoundEnabled(getVal("kiro-timer-sound-enabled", "true") !== "false");
      setSettingsStopwatchEnabled((getVal("kiro-stopwatch-enabled") ?? getVal("kiro-calendar-enabled", "true")) !== "false");
      setSettingsDualClockEnabled(getVal("kiro-dual-clock-enabled", "false") === "true");
      setDualClockZone(getVal("kiro-dual-clock-zone") || DEFAULT_DUAL_CLOCK_ZONE);
      setDualClockLabel(getVal("kiro-dual-clock-label") || DEFAULT_DUAL_CLOCK_ZONE);
      setSettingsMusicModeEnabled(getVal("kiro-music-mode-enabled", "true") !== "false");
      setSettingsMusicCompactNotch(getVal("kiro-music-compact-notch", "true") !== "false");
      const viz = getVal("kiro-media-visualizer-enabled") ?? getVal("kiro-visualizer-enabled", "true");
      setSettingsVisualizerEnabled(viz !== "false");
      setSettingsAlbumArtEnabled(getVal("kiro-media-album-art-enabled", "true") !== "false");
      setSettingsAmbienceEnabled(getVal("kiro-media-ambience-enabled", "true") !== "false");
      setSettingsCompactGlowEnabled(getVal("kiro-media-compact-glow-enabled", "true") !== "false");
      setSettingsArtworkTheme(getVal("kiro-media-artwork-theme", "false") === "true");
      setSettingsCornersEnabled(getVal("kiro-corners-enabled", "false") === "true");
      setNotchBottomRight(getVal("kiro-notch-position", "bottom-right") === "bottom-right");
      // Panel visibility has to come from the stored settings too, otherwise a
      // stale localStorage value can hide the quick-settings panel forever.
      setPanelControlCenter(getVal("kiro-panel-control-center-enabled", "true") !== "false");
      setPanelShelf(getVal("kiro-panel-shelf-enabled", "true") !== "false");
      setPanelOrder(parsePanelOrder(getVal("kiro-panel-order")));
      setTimeFormat24h(getVal("kiro-time-format-24h") !== "false");
      setSettingsLegacyMode(getVal("kiro-legacy-mode") === "true");
      const scrollVolume = getVal("kiro-notch-scroll-volume") === "true";
      localStorage.setItem("kiro-notch-scroll-volume", String(scrollVolume));
      setSettingsScrollVolume(scrollVolume);

      const thresholdStr = getVal("kiro-low-battery-threshold", "20");
      if (thresholdStr) setLowBatteryThreshold(parseInt(thresholdStr as string));

      refreshNotchMode();
      refreshDockMode();

      if (windowLabel === 'main') {
        const firstRun = localStorage.getItem("kiro-first-run") === null;
        if (firstRun) {
          import("@tauri-apps/plugin-autostart").then(({ enable, isEnabled }) => {
            isEnabled().then(enabled => {
              if (!enabled) enable().catch(() => { });
            });
          });
          localStorage.setItem("kiro-first-run", "done");
        }
        const rawDockMode = getVal("kiro-dock-mode", "smart") as string;
        const dockMode = rawDockMode === "auto-hide" ? "smart" : rawDockMode;
        const syncWindows = async () => {
          const dockEnabled = getVal("kiro-dock-enabled", "true") === "true";
          const resolvedNotchMode = await invoke<string>('get_notch_mode_for_window').catch(() => "fixed");
          await Promise.all([
            dockEnabled ? invoke("init_dock", { mode: dockMode }) : Promise.resolve(),
            invoke("change_notch_mode", { mode: resolvedNotchMode }),
          ]);
          await invoke("sync_appbar");
        };

        const dockEnabled = getVal("kiro-dock-enabled", "true") === "true";
        const runDockInit = () => {
          // 1. Snappy initial sync
          setTimeout(syncWindows, 400);
          // 2. Safety-net dock retry
          if (dockEnabled) {
            setTimeout(() => invoke("init_dock", { mode: dockMode }).catch(() => {}), 1500);
          }
          // 3. Layout corrections
          setTimeout(() => invoke("sync_appbar"), 1000);
          setTimeout(() => invoke("sync_appbar"), 2500);
          setTimeout(() => invoke("sync_appbar"), 5000);
        };

        const runDockInitAfterSplash = () => {
          let dockStarted = false;
          const unlistenDock = listen("splash-done", () => {
            if (dockStarted) return;
            dockStarted = true;
            runDockInit();
            unlistenDock.then(fn => fn());
          });
          setTimeout(() => {
            if (dockStarted) return;
            dockStarted = true;
            runDockInit();
            unlistenDock.then(fn => fn());
          }, 6000);
        };

        runDockInitAfterSplash();
      }

      const scaleVal = getVal("kiro-scale");
      if (scaleVal !== null) setScale(parseFloat(scaleVal));

      const widgetsVal = getVal("kiro-status-widgets");
      if (widgetsVal) {
        try {
          const parsed = JSON.parse(widgetsVal);
          if (parsed && Array.isArray(parsed.left) && Array.isArray(parsed.right)) {
            setStatusWidgets(parsed);
          }
        } catch {}
      }
    }).catch(console.error);
  }, [windowLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Disable context menu globally
    const preventContext = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('contextmenu', preventContext);

    const unlistenVisibility = listen<boolean>("visibility-change", (event) => {
      setIsVisible(event.payload);
    });

    // Only this notch's events, the other monitor's notch shouldn't react.
    const thisWindow = getCurrentWebviewWindow();

    const unlistenNotchOverlap = thisWindow.listen<boolean>("notch-overlap", (event) => {
      setIsOverlapped(event.payload);
    });

    const unlistenNotchEdgeHover = thisWindow.listen<boolean>("notch-edge-hover", (event) => {
      setIsEdgeHovered(event.payload);
    });

    const unlistenNotchFullscreen = thisWindow.listen<boolean>("notch-fullscreen", (event) => {
      setIsFullscreen(event.payload);
      if (event.payload) {
        setIsEdgeHovered(false);
        setIsNotchHovered(false);
      }
    });

    const unlistenSettingsReset = listen("settings-reset", () => {
      localStorage.clear();
      window.location.reload();
    });

    return () => {
      unlistenVisibility.then(f => f());
      unlistenNotchOverlap.then(f => f());
      unlistenNotchEdgeHover.then(f => f());
      unlistenNotchFullscreen.then(f => f());
      unlistenSettingsReset.then(f => f());
      document.removeEventListener('contextmenu', preventContext);
    };
  }, [windowLabel]);

  // Settings sync — consolidated dispatch for all settings events
  useSettingsSync(
    {
      "kiro-weather-enabled": setSettingsWeatherEnabled,
      "kiro-calendar-enabled": setSettingsCalendarEnabled,
      "kiro-timer-enabled": setSettingsTimerEnabled,
      "kiro-timer-sound-enabled": setSettingsTimerSoundEnabled,
      "kiro-notch-timer-progress": setSettingsTimerProgressEnabled,
      "kiro-stopwatch-enabled": setSettingsStopwatchEnabled,
      "kiro-dual-clock-enabled": setSettingsDualClockEnabled,
      "kiro-dual-clock-zone": (value) => setDualClockZone(String(value)),
      "kiro-dual-clock-label": (value) => setDualClockLabel(String(value)),
      "kiro-music-mode-enabled": setSettingsMusicModeEnabled,
      "kiro-music-compact-notch": setSettingsMusicCompactNotch,
      "kiro-notch-scroll-volume": setSettingsScrollVolume,
      "kiro-shelf-persist": setSettingsShelfPersist,
      "kiro-notch-remember-mode": setSettingsRememberMode,
      "kiro-panel-control-center-enabled": (v) => setPanelControlCenter(v !== false && v !== "false"),
      "kiro-panel-shelf-enabled": (v) => setPanelShelf(v !== false && v !== "false"),
      "kiro-panel-order": (v) => setPanelOrder(parsePanelOrder(v === null ? null : String(v))),
      "kiro-cc-layout": (v) => setCcLayout(parseCcLayout(v === null ? null : String(v))),
      "kiro-media-visualizer-enabled": setSettingsVisualizerEnabled,
      "kiro-visualizer-enabled": setSettingsVisualizerEnabled,
      "kiro-media-album-art-enabled": setSettingsAlbumArtEnabled,
      "kiro-media-ambience-enabled": setSettingsAmbienceEnabled,
      "kiro-media-compact-glow-enabled": setSettingsCompactGlowEnabled,
      "kiro-media-artwork-theme": setSettingsArtworkTheme,
      "kiro-media-layout": setMediaLayout,
      "kiro-corners-enabled": setSettingsCornersEnabled,
      "kiro-scale": setScale,
      "kiro-low-battery-threshold": setLowBatteryThreshold,
      "kiro-dock-enabled": setDockEnabled,
      "kiro-dock-mode": refreshDockMode,
      "kiro-dock-mode-by-monitor": refreshDockMode,
      "kiro-dock-monitor-mode": refreshDockMode,
      "kiro-dock-monitor-id": refreshDockMode,
      "kiro-notch-mode": refreshNotchMode,
      "kiro-notch-mode-by-monitor": refreshNotchMode,
      "kiro-notch-monitor-mode": refreshNotchMode,
      "kiro-notch-monitor-id": refreshNotchMode,
      "kiro-status-widgets": (value) => {
        try {
          const parsed = JSON.parse(value);
          if (parsed && Array.isArray(parsed.left) && Array.isArray(parsed.right)) {
            setStatusWidgets(parsed);
          }
        } catch {}
      },
      "kiro-show-update-indicator": (value) => setShowUpdateIndicator(String(value) === "true"),
      "kiro-time-format-24h": setTimeFormat24h,
      "kiro-legacy-mode": setSettingsLegacyMode,
      "kiro-notch-position": (v) => {
        setNotchBottomRight(v === "bottom-right");
        // The window has to be repositioned/resized by the backend.
        setTimeout(() => invoke("sync_appbar"), 60);
      },
    },
    [windowLabel]
  );

  // Side effects: dock-enabled (skip first render — startup code handles initial state)
  useEffect(() => {
    if (windowLabel !== 'main') return;
    if (dockEnabledInitial.current) { dockEnabledInitial.current = false; return; }
    if (dockEnabled) {
      invoke("init_dock", { mode: localStorage.getItem("kiro-dock-mode") || "smart" });
    } else {
      invoke("toggle_dock", { enable: false });
    }
    setTimeout(() => invoke("sync_appbar"), 200);
  }, [dockEnabled, windowLabel]);

  // Side effects: dock-mode (skip first render)
  useEffect(() => {
    if (windowLabel !== 'main') return;
    if (dockModeInitial.current) { dockModeInitial.current = false; return; }
    invoke("change_dock_mode", { mode: dockMode });
    setTimeout(() => invoke("sync_appbar"), 200);
  }, [dockMode, windowLabel]);

  // Side effects: notch-mode (skip first render)
  useEffect(() => {
    if (windowLabel !== 'main') return;
    if (notchModeInitial.current) { notchModeInitial.current = false; return; }
    invoke("change_notch_mode", { mode: notchMode });
  }, [notchMode, windowLabel]);

  const [tourStep, setTourStep] = useState(0);
  const tourAutoStartedRef = useRef(false);

  const startTour = useCallback(() => {
    setTourStep(0);
    setKiroMode('tour');
  }, []);

  const closeTour = useCallback(() => {
    setKiroMode('status');
    localStorage.setItem("kiro-tour-seen", "1");
    invoke("save_setting", { key: "kiro-tour-seen", value: "1" }).catch(console.error);
  }, []);

  useEffect(() => {
    if (windowLabel !== 'main' || settingsLegacyMode || !isReady || !isExpanded || tourAutoStartedRef.current) return;
    tourAutoStartedRef.current = true;
    if (localStorage.getItem("kiro-tour-seen") === "1") return;
    const timer = setTimeout(startTour, 1500);
    return () => clearTimeout(timer);
  }, [windowLabel, settingsLegacyMode, isReady, isExpanded, startTour]);

  useEffect(() => {
    if (windowLabel !== 'main') return;
    const unlisten = listen("start-tour", startTour);
    return () => { unlisten.then(f => f()); };
  }, [windowLabel, startTour]);

  useEffect(() => {
    if (ccView !== 'main' && (!isHovered || kiroMode !== 'command-center')) setCcView('main');
  }, [ccView, isHovered, kiroMode]);
  const caldav = useCaldav();

  // Window height is now kept constant to prevent rendering layout lag and sharp corners

  const wheelAccumRef = useRef(0);
  const wheelIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const WHEEL_STEP_THRESHOLD = 60;
  const WHEEL_IDLE_RESET_MS = 180;

  // Music shifts position based on playing state:
  // Playing: command-center → music → status → calendar (active, near command-center)
  // Paused:  command-center → status → music → calendar (secondary, after status)
  const availableNotchModes = () => {
    const musicBeforeStatus = isPlaying && mediaInfo.has_media && settingsMusicModeEnabled;
    const modes: ('command-center' | 'status' | 'music' | 'calendar' | 'shelf')[] = panelOrder
      ? [...panelOrder]
      : musicBeforeStatus
        ? ['command-center', 'music', 'status', 'calendar', 'shelf']
        : ['command-center', 'status', 'music', 'calendar', 'shelf'];
    return modes.filter(m => {
      if (m === 'music' && (!settingsMusicModeEnabled || !mediaInfo.has_media)) return false;
      if (m === 'calendar' && !productivityEnabled) return false;
      if (m === 'shelf' && (!isNotchWindow || settingsLegacyMode || !panelShelf)) return false;
      if (m === 'command-center' && !panelControlCenter) return false;
      return true;
    });
  };

  const handleWheel = (e: React.WheelEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.calendar-grid') || target.closest('.timer-column') || target.closest('.cal-scroll')) {
      return;
    }

    if (!isHovered) return;

    // Use absolute values to detect horizontal swipe gestures on trackpad
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 2) return; // Ignore near-zero noise

    wheelAccumRef.current += delta;
    if (wheelIdleTimeoutRef.current) clearTimeout(wheelIdleTimeoutRef.current);
    wheelIdleTimeoutRef.current = setTimeout(() => { wheelAccumRef.current = 0; }, WHEEL_IDLE_RESET_MS);

    if (Math.abs(wheelAccumRef.current) < WHEEL_STEP_THRESHOLD) return;
    const direction = wheelAccumRef.current > 0 ? 1 : -1;
    wheelAccumRef.current = 0;

    const availableModes = availableNotchModes();

    if (kiroMode === 'agent') { if (availableModes[0]) setKiroMode(availableModes[0]); return; }
    if (kiroMode === 'tour') return;
    const currentIndex = availableModes.indexOf(kiroMode);
    if (currentIndex === -1) return;

    const nextIndex = (currentIndex + direction + availableModes.length) % availableModes.length;
    const nextMode = availableModes[nextIndex];
    manualMusicRef.current = nextMode === 'music';
    setKiroMode(nextMode);
  };



  // Timer state
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerTotalSeconds, setTimerTotalSeconds] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [isCompactTimerVisible, setIsCompactTimerVisible] = useState(false);
  const [isTimerFinished, setIsTimerFinished] = useState(false);
  const timerIntervalRef = useRef<any>(null);

  const formatTimerTime = (totalSeconds: number) => {
    const mins = Math.floor(Math.abs(totalSeconds) / 60);
    const secs = Math.abs(totalSeconds) % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const startTimerSeconds = (seconds: number) => {
    // Unlock audio on this click so the chime can play later.
    getTimerChimeCtx();
    setTimerTotalSeconds(seconds);
    setTimerSeconds(seconds);
    setIsTimerRunning(true);
    setIsTimerFinished(false);
  };

  const toggleTimer = () => {
    if (!isTimerRunning) {
      getTimerChimeCtx();
      if (timerTotalSeconds === 0 && timerSeconds > 0) {
        setTimerTotalSeconds(timerSeconds);
      }
    }
    setIsTimerRunning(!isTimerRunning);
  };
  const resetTimer = () => {
    setIsTimerRunning(false);
    setTimerSeconds(0);
    setTimerTotalSeconds(0);
    setIsTimerFinished(false);
  };

  const timerProgressRatio = timerTotalSeconds > 0
    ? Math.min(1, Math.max(0, (timerTotalSeconds - timerSeconds) / timerTotalSeconds))
    : (isTimerFinished ? 1 : 0);
  const timerProgressPercent = Math.round(timerProgressRatio * 1000) / 10;
  const showTimerProgressBar = settingsTimerProgressEnabled && settingsTimerEnabled && (
    (timerTotalSeconds > 0 && (isTimerRunning || timerSeconds > 0)) || isTimerFinished
  );

  const stopwatch = useStopwatch();

  useEffect(() => {
    if (!settingsTimerEnabled) resetTimer();
  }, [settingsTimerEnabled]);

  useEffect(() => {
    if (!settingsStopwatchEnabled) stopwatch.reset();
  }, [settingsStopwatchEnabled]);

  useEffect(() => {
    if (isTimerRunning && timerSeconds > 0) {
      timerIntervalRef.current = setInterval(() => {
        setTimerSeconds(s => s - 1);
      }, 1000);
    } else if (isTimerRunning && timerSeconds === 0) {
      setIsTimerRunning(false);
      setIsTimerFinished(true);
    }
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [isTimerRunning, timerSeconds === 0]);

  // On finish: chime, and peek the notch.
  const prevTimerFinishedRef = useRef(false);
  useEffect(() => {
    if (isTimerFinished && !prevTimerFinishedRef.current) {
      if (settingsTimerSoundEnabled) playTimerChime();
      if (notchMode === 'peek') triggerEventPeek(6000);
    }
    prevTimerFinishedRef.current = isTimerFinished;
  }, [isTimerFinished, settingsTimerSoundEnabled, notchMode, triggerEventPeek]);

  useEffect(() => {
    if (!isTimerFinished) return;
    const dismiss = setTimeout(resetTimer, 6000);
    return () => clearTimeout(dismiss);
  }, [isTimerFinished]);

  const lastTrackRef = useRef<string | null>(null);
  const lastPlayingRef = useRef<boolean>(false);
  const manualMusicRef = useRef<boolean>(false);

  // Auto-switch to music mode only when a *new* track starts while playing,
  // or when playback transitions from paused to playing.
  useEffect(() => {
    const isNewTrackWhilePlaying = mediaInfo.title !== lastTrackRef.current && isPlaying;
    const justStartedPlaying = isPlaying && !lastPlayingRef.current;

    // Peek notch on media events (play start or track change)
    if (notchMode === 'peek' && (isNewTrackWhilePlaying || justStartedPlaying)) {
      triggerEventPeek(3000);
    }

    if (settingsMusicModeEnabled && settingsMusicCompactNotch && mediaInfo.has_media && isPlaying
        && kiroMode === 'status' && !isHovered && (isNewTrackWhilePlaying || justStartedPlaying)) {
      manualMusicRef.current = false;
      setKiroMode('music');
    }

    lastTrackRef.current = mediaInfo.title;
    lastPlayingRef.current = isPlaying;
  }, [mediaInfo.has_media, isPlaying, mediaInfo.title, settingsMusicModeEnabled, settingsMusicCompactNotch, isHovered, kiroMode, notchMode, triggerEventPeek]);

  // Auto-switch back from music if music stops for 5 seconds
  // Skip if user manually scrolled to music mode
  useEffect(() => {
    let timer: any;
    if (!isPlaying && kiroMode === 'music' && !manualMusicRef.current) {
      timer = setTimeout(() => {
        setKiroMode('status');
      }, 5000);
    }
    return () => clearTimeout(timer);
  }, [isPlaying, kiroMode]);

  useEffect(() => {
    if (!productivityEnabled && kiroMode === 'calendar') {
      setKiroMode('status');
    }
  }, [productivityEnabled, kiroMode]);

  useEffect(() => {
    if (!settingsMusicModeEnabled && kiroMode === 'music') {
      setKiroMode('status');
    }
  }, [settingsMusicModeEnabled, kiroMode]);

  useEffect(() => {
    if (!settingsMusicCompactNotch && kiroMode === 'music' && !isHovered) {
      setKiroMode('status');
    }
  }, [settingsMusicCompactNotch, kiroMode, isHovered]);

  useEffect(() => {
    if (settingsMusicModeEnabled && settingsMusicCompactNotch && mediaInfo.has_media && isPlaying && kiroMode === 'status' && !isHovered) {
      setKiroMode('music');
    }
  }, [settingsMusicModeEnabled, settingsMusicCompactNotch, mediaInfo.has_media, isPlaying, kiroMode, isHovered]);

  // Update time
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      if (settingsDualClockEnabled) {
        setTime(
          now.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: !timeFormat24h,
          })
        );
        setDualTime(formatZoneTime(now, dualClockZone, !timeFormat24h));
        setDualDayShift(zoneDayShift(now, dualClockZone));
      }
    };

    updateTime();
    const interval = setVisibleInterval(updateTime, 1000);

    // Toggle compact timer view every 5 seconds if running
    let timerToggleInterval: any;
    if ((isTimerRunning || stopwatch.running) && kiroMode !== 'calendar') {
      timerToggleInterval = setVisibleInterval(() => {
        setIsCompactTimerVisible(prev => !prev);
      }, 5000);
    } else {
      setIsCompactTimerVisible(false);
    }

    return () => {
      clearInterval(interval);
      if (timerToggleInterval) clearInterval(timerToggleInterval);
    };
  }, [isTimerRunning, stopwatch.running, kiroMode, timeFormat24h, settingsDualClockEnabled, dualClockZone]);

  // Battery API
  useEffect(() => {
    let battery: any = null;

    const initBattery = async () => {
      try {
        battery = await (navigator as any).getBattery();

        const updateBattery = () => {
          setBatteryLevel(Math.round(battery.level * 100));
          setIsCharging(battery.charging);
          const seconds = battery.charging ? battery.chargingTime : battery.dischargingTime;
          setBatterySecondsLeft(Number.isFinite(seconds) ? seconds : null);
        };

        updateBattery();

        battery.addEventListener("levelchange", updateBattery);
        battery.addEventListener("chargingchange", updateBattery);
        battery.addEventListener("chargingtimechange", updateBattery);
        battery.addEventListener("dischargingtimechange", updateBattery);

        return () => {
          battery.removeEventListener("levelchange", updateBattery);
          battery.removeEventListener("chargingchange", updateBattery);
          battery.removeEventListener("chargingtimechange", updateBattery);
          battery.removeEventListener("dischargingtimechange", updateBattery);
        };
      } catch (e) {
        // Battery API not supported
      }
    };

    initBattery();
  }, []);

  // Listen for Volume Changes
  useEffect(() => {
    const unlisten = listen<{ volume: number; is_muted: boolean }>("volume-change", (event) => {
      setVolume(event.payload.volume);
      setIsMuted(event.payload.is_muted);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Wi-Fi has three states (off, on, connected) and the radio state can't tell them apart.
  // Returns false so startup can retry.
  const refreshWifiStatus = useCallback(async (): Promise<boolean> => {
    invoke<{ present: boolean; connected: boolean; name: string }>("get_lan_status").then(setLanStatus).catch(() => {});
    try {
      setWifiStatus(await invoke<WifiStatus>("get_wifi_status"));
      return true;
    } catch {
      return false;
    }
  }, []);

  // Seed the Wi-Fi pill. The first call can fail while the WLAN service is starting, so retry.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const initializeWifiStatus = async (attempt: number) => {
      const loaded = await refreshWifiStatus();
      if (!loaded && !cancelled && attempt < 3) {
        retryTimer = setTimeout(() => void initializeWifiStatus(attempt + 1), (attempt + 1) * 1000);
      }
    };
    void initializeWifiStatus(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [refreshWifiStatus]);

  // Keep Wi-Fi fresh while the command center is open (keyboard toggle, Windows quick settings).
  useEffect(() => {
    if (kiroMode !== 'command-center') return;
    void refreshWifiStatus();
    const interval = setVisibleInterval(() => void refreshWifiStatus(), 5000);
    return () => clearInterval(interval);
  }, [kiroMode, refreshWifiStatus]);

  // Load bluetooth/volume/brightness state on mount
  useEffect(() => {
    invoke<boolean>("get_bluetooth_state").then(setBluetoothEnabled).catch(() => { });
    invoke<boolean>("get_battery_saver_state").then(setBatterySaverEnabled).catch(() => { });
    invoke<boolean>("has_battery").then((present) => {
      setHasBattery(present);
      localStorage.setItem("kiro-has-battery", String(present));
    }).catch(() => { });
    invoke<{ volume: number; is_muted: boolean }>("get_volume_state")
      .then((state) => { setVolume(state.volume); setIsMuted(state.is_muted); })
      .catch(() => { });
    invoke<number>("get_brightness").then(setCurrentBrightness).catch(() => { });

    const interval = setVisibleInterval(() => {
      invoke<boolean>("get_battery_saver_state").then(setBatterySaverEnabled).catch(() => { });
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    interface SystemMetrics {
      cpu: number;
      ram: number;
      disk_free_gb: number;
      net_up: number;
      net_down: number;
    }

    const fetchMetrics = () => {
      invoke<SystemMetrics>("get_system_metrics").then((m) => {
        setCpuUsage(m.cpu);
        setRamUsage(m.ram);
        setDiskSpace(m.disk_free_gb);
        setNetUpSpeed(m.net_up);
        setNetDownSpeed(m.net_down);
      }).catch((e) => console.warn("metrics:", e));
    };
    fetchMetrics();
    const interval = setVisibleInterval(fetchMetrics, 3000);
    return () => clearInterval(interval);
  }, []);

  // Listen for brightness changes
  useEffect(() => {
    const unlisten = listen<{ brightness: number }>("brightness-change", (event) => {
      setCurrentBrightness(event.payload.brightness);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const [mediaSessions, setMediaSessions] = useState<MediaSession[]>([]);
  useEffect(() => {
    const unlisten = listen<typeof mediaSessions>("media-sessions", (event) => setMediaSessions(event.payload ?? []));
    return () => { unlisten.then(fn => fn()); };
  }, []);

  useEffect(() => {
    let clear: ReturnType<typeof setTimeout> | undefined;
    const unlisten = listen<AgentActivity | null>("agent-activity", (event) => {
      clearTimeout(clear);
      const next = event.payload;
      const key = next ? `${next.state}:${next.ask?.id ?? ""}` : "";
      if (windowLabelRef.current === 'main' && next && key !== lastAgentKey.current && (next.state === 'needs_input' || next.state === 'done' || next.state === 'error')) {
        playAgentSound(next.state);
      }
      lastAgentKey.current = key;
      setAgentActivity((prev) => (next && prev?.ask && !next.ask && next.cancelled !== prev.ask.id && (next.state === 'working' || next.state === 'tool') ? prev : next));
      if (next && next.state === "done") clear = setTimeout(() => setAgentActivity(null), 8000);
    });
    return () => {
      clearTimeout(clear);
      unlisten.then((fn) => fn());
    };
  }, []);

  // Native Windows Media Controls - Listen for updates from background worker
  useEffect(() => {
    const applyMedia = (info: MediaInfo | null | undefined) => {
      if (!info) return;

      setMediaInfo(prev => {
        // Find if artwork changed by checking the first element
        const prevArt = prev.artwork?.[0];
        const nextArt = info.artwork?.[0];
        const artChanged = prevArt !== nextArt;

        if (prev.title === info.title &&
          prev.artist === info.artist &&
          prev.is_playing === info.is_playing &&
          prev.has_media === info.has_media &&
          !artChanged &&
          prev.position_ms === info.position_ms &&
          prev.duration_ms === info.duration_ms) {
          return prev;
        }

        // Update playing state separately for the hook triggers
        setIsPlaying(info.is_playing);

        if (info.artwork && info.artwork.length > 0) {
          const newArt = info.artwork[0];
          setAlbumArtUrl(prev => {
            if (prev !== newArt) {
              setAlbumArtKey(k => k + 1);
              return newArt;
            }
            return prev;
          });
        } else if (prev.title !== info.title || prev.artist !== info.artist) {
          setAlbumArtUrl(null);
        }

        return info.artwork && info.artwork.length > 0 ? info : { ...info, artwork: prev.artwork };
      });
    };
    const unlisten = listen<MediaInfo>("media-update", (event) => applyMedia(event.payload));
    invoke<MediaInfo | null>("get_media_info").then(applyMedia).catch(() => { });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  // Media controls via Tauri commands
  /* Unused saveAndBroadcast removed to fix TS build error */
  const togglePlayPause = useCallback(async () => {
    try {
      await invoke("media_play_pause");
      setIsPlaying(!isPlaying);
    } catch (e) {
      console.error("Failed to toggle play/pause:", e);
    }
  }, [isPlaying]);


  const skipNext = useCallback(async () => {
    try {
      await invoke("media_next");
    } catch (e) {
      console.error("Failed to skip next:", e);
    }
  }, []);

  const skipPrevious = useCallback(async () => {
    try {
      await invoke("media_previous");
    } catch (e) {
      console.error("Failed to skip previous:", e);
    }
  }, []);

  // Slide-push animation for prev/next buttons
  const prevFront = useAnimation();
  const prevBack = useAnimation();
  const nextFront = useAnimation();
  const nextBack = useAnimation();

  const animatePrev = useCallback(async () => {
    prevFront.set({ x: 0 });
    prevBack.set({ x: 30 });
    prevFront.start({ x: -30, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
    await prevBack.start({ x: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
    skipPrevious();
  }, [skipPrevious, prevFront, prevBack]);

  const animateNext = useCallback(async () => {
    nextFront.set({ x: 0 });
    nextBack.set({ x: -30 });
    nextFront.start({ x: 30, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
    await nextBack.start({ x: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
    skipNext();
  }, [skipNext, nextFront, nextBack]);

  const sendVolume = useTrailingThrottle((newVol: number) => {
    invoke("set_volume", { volume: newVol }).catch(() => {});
  }, 50);

  const handleVolumeChange = useCallback((newVol: number) => {
    setVolume(newVol);
    // set_volume unmutes for any non-zero level.
    setIsMuted(newVol === 0);
    sendVolume(newVol);
  }, [sendVolume]);


  // Open WiFi settings
  const openWifiSettings = useCallback(async () => {
    try {
      await invoke("open_wifi_settings");
    } catch (e) {
      console.error("Failed to open WiFi settings:", e);
    }
  }, []);

  // WiFi toggle
  const toggleWifi = useCallback(async () => {
    const previous = wifiStatus;
    const newState = !(previous?.enabled ?? false);
    setWifiStatus({ enabled: newState, connected: newState ? (previous?.connected ?? false) : false });
    try {
      await invoke("set_wifi_state", { enabled: newState });
      // The radio and association take a moment to settle.
      setTimeout(() => void refreshWifiStatus(), 800);
    } catch (e) {
      setWifiStatus(previous);
      console.error("Failed to toggle WiFi:", e);
    }
  }, [wifiStatus, refreshWifiStatus]);

  // Bluetooth toggle
  const toggleBluetooth = useCallback(async () => {
    const newState = !bluetoothEnabled;
    setBluetoothEnabled(newState);
    try {
      await invoke("set_bluetooth_state", { enabled: newState });
    } catch (e) {
      setBluetoothEnabled(!newState);
      console.error("Failed to toggle Bluetooth:", e);
    }
  }, [bluetoothEnabled]);

  // Battery Saver - toggles Windows' power saving directly instead of opening
  // the Settings page (the old button just deep-linked to ms-settings).
  const toggleBatterySaver = useCallback(async () => {
    const next = !batterySaverEnabled;
    setBatterySaverEnabled(next); // optimistic, the command takes a moment
    try {
      const actual = await invoke<boolean>("set_battery_saver", { enabled: next });
      setBatterySaverEnabled(!!actual);
    } catch (e) {
      setBatterySaverEnabled(!next);
      console.error("Failed to toggle Battery Saver:", e);
    }
  }, [batterySaverEnabled]);


  // Brightness change with throttling
  const sendBrightness = useTrailingThrottle((newVal: number) => {
    invoke("set_brightness", { brightness: newVal }).catch(() => {});
  }, 50);

  const handleBrightnessChange = useCallback((newVal: number) => {
    setCurrentBrightness(newVal);
    sendBrightness(newVal);
  }, [sendBrightness]);

  const openSettingsWindow = useCallback(async () => {
    try {
      await invoke("open_settings_window");
    } catch (e) {
      console.error("Failed to open settings window:", e);
    }
  }, []);

  const handleWifiRightClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (settingsLegacyMode) openWifiSettings();
    else setCcView('wifi');
  }, [openWifiSettings, settingsLegacyMode]);

  const toggleDockModeSetting = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextMode = dockMode === "fixed" ? "smart" : dockMode === "smart" ? "peek" : "fixed";
    setDockMode(nextMode);
    localStorage.setItem("kiro-dock-mode", nextMode);
    invoke("save_setting", { key: "kiro-dock-mode", value: nextMode }).catch(console.error);
    try {
      await invoke("change_dock_mode", { mode: nextMode });
    } catch (err) {
      console.error("Failed to change dock mode:", err);
    }
  }, [dockMode]);

  const toggleNotchModeSetting = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextMode = notchMode === "fixed" ? "smart" : notchMode === "smart" ? "peek" : "fixed";
    setNotchMode(nextMode);
    try {
      await invoke("set_notch_mode_for_window", { mode: nextMode });
      await invoke("change_notch_mode", { mode: nextMode });
    } catch (err) {
      console.error("Failed to change notch mode:", err);
    }
  }, [notchMode]);

  const handleBluetoothRightClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (settingsLegacyMode) invoke("open_bluetooth_settings");
    else setCcView('bluetooth');
  }, [settingsLegacyMode]);



  const toggleCalendarMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTimerFinished) {
      resetTimer();
      return;
    }
    if (!productivityEnabled) return;

    setKiroMode(prev => {
      if (prev === 'calendar') {
        // Return to music mode if media is present and playing and music mode is enabled, otherwise status
        return (settingsMusicModeEnabled && mediaInfo.has_media && isPlaying) ? 'music' : 'status';
      }
      return 'calendar';
    });
  };

  const toggleControlCenter = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTimerFinished) {
      resetTimer();
      return;
    }
    if (kiroMode === 'tour') return;
    const modes = availableNotchModes();
    if (!modes.includes('command-center')) {
      cycleNotchMode(e);
      return;
    }
    // Click opens the control center, clicking the clock again closes it and
    // falls back to whatever the notch was showing before.
    if (kiroMode === 'command-center') {
      const home = settingsMusicModeEnabled && mediaInfo.has_media && isPlaying ? 'music' : 'status';
      setKiroMode(modes.includes(home) ? home : modes[0]);
    } else {
      setKiroMode('command-center');
    }
  };

  // Status widgets (weather, battery, CPU, ...) are a shortcut to the status
  // panel; the panel order setting only controls scroll order.
  const openStatusPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTimerFinished) {
      resetTimer();
      return;
    }
    if (kiroMode === 'tour') return;
    if (availableNotchModes().includes('status')) setKiroMode('status');
  };

  const cycleNotchMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTimerFinished) {
      resetTimer();
      return;
    }
    if (kiroMode === 'tour') return;
    // Clicking the clock opens the quick-settings panel (Wi-Fi, Bluetooth,
    // volume, brightness). Scrolling still cycles through every panel.
    const allModes = availableNotchModes();
    if (kiroMode === 'agent') { if (allModes[0]) setKiroMode(allModes[0]); return; }
    if (allModes.includes('command-center')) {
      setKiroMode('command-center');
      return;
    }
    const modes = allModes;
    const index = modes.indexOf(kiroMode);
    if (index === -1 || modes.length < 2) return;
    const next = modes[(index + 1) % modes.length];
    manualMusicRef.current = next === 'music';
    setKiroMode(next);
  };

  const conditionLabel = (condition: string) => {
    const key = `weather.condition.${condition.toLowerCase().replace(/ /g, "")}`;
    const label = t(key);
    return label === key ? condition : label;
  };

  const handleVolumeWheel = (e: React.WheelEvent) => {
    if (!settingsScrollVolume) return;
    e.stopPropagation();
    const change = e.deltaY < 0 ? 0.02 : -0.02;
    handleVolumeChange(Math.min(1, Math.max(0, Math.round((displayVolume + change) * 100) / 100)));
  };

  const handleBrightnessWheel = (e: React.WheelEvent) => {
    if (!settingsScrollVolume) return;
    e.stopPropagation();
    handleBrightnessChange(Math.min(100, Math.max(0, Math.round(currentBrightness + (e.deltaY < 0 ? 2 : -2)))));
  };

  const tip = (text: string | undefined) =>
    settingsLegacyMode
      ? { "data-tooltip": text }
      : { onMouseEnter: () => setWidgetTip(text ?? null), onMouseLeave: () => setWidgetTip(null) };

  // Render a status widget by ID
  const renderStatusWidget = (id: string) => {
    switch (id) {
      case "weather":
        if (!settingsWeatherEnabled || temperature === null) return null;
        return (
          <div className="passive-feature" key="weather" {...tip(cityName ? `${conditionLabel(weatherCondition)} — ${cityName}` : conditionLabel(weatherCondition))}>
            <WeatherIcon size={12} strokeWidth={2.2} />
            <span className="label">{temperature}°{tempUnit === "fahrenheit" ? "F" : "C"}</span>
          </div>
        );
      case "battery":
        if (!hasBattery) return null;
        return (
          <div
            className={`passive-feature${batterySaverEnabled ? " saver-on" : ""}`}
            key="battery"
            role="button"
            style={{ cursor: "pointer" }}
            onClick={(e) => { e.stopPropagation(); void toggleBatterySaver(); }}
            {...tip(batteryTooltip(isCharging, batteryLevel, batterySecondsLeft))}
          >
            <BatteryIcon charging={isCharging} level={batteryLevel} threshold={lowBatteryThreshold} />
            <span className="label">{batteryLevel}%</span>
          </div>
        );
      case "cpu":
        return (
          <div className="passive-feature" key="cpu" {...tip(t("widgets.cpu.tip"))}>
            <Cpu size={12} strokeWidth={2} />
            <span className="label">{cpuUsage}%</span>
          </div>
        );
      case "ram":
        return (
          <div className="passive-feature" key="ram" {...tip(t("widgets.ram.tip"))}>
            <MemoryStick size={12} strokeWidth={2} />
            <span className="label">{Math.round(ramUsage)}%</span>
          </div>
        );
      case "disk":
        return (
          <div className="passive-feature" key="disk" {...tip(t("widgets.disk.tip"))}>
            <HardDrive size={12} strokeWidth={2} />
            <span className="label">{diskSpace}GB</span>
          </div>
        );
      case "net":
        return (
          <div className="passive-feature" key="net" {...tip(t("widgets.net.tip"))}>
            <ArrowUpDown size={12} strokeWidth={2} />
            <span className="label">↑{formatBytes(netUpSpeed)} ↓{formatBytes(netDownSpeed)}</span>
          </div>
        );
      default:
        return null;
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  };

  const collapseAfterShelfDrag = () => {
    setIsHovered(false);
    setIsNotchHovered(false);
    setKiroMode(mediaInfo.has_media && isPlaying && settingsMusicCompactNotch ? 'music' : 'status');
  };
  const shelfDrag = useRef({ active: false, until: 0 });
  const shelfCollapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shelfHoldsOpen = () => shelfDrag.current.active || Date.now() < shelfDrag.current.until;
  const deferShelfCollapse = () => {
    clearTimeout(shelfCollapseTimer.current);
    const wait = Math.max(0, shelfDrag.current.until - Date.now());
    shelfCollapseTimer.current = setTimeout(async () => {
      if (shelfHoldsOpen()) return;
      const over = await invoke<boolean>('pointer_over_notch').catch(() => false);
      if (!over) collapseAfterShelfDrag();
    }, wait);
  };
  const shelf = useShelf(windowLabel, isNotchWindow && !settingsLegacyMode && panelShelf, settingsShelfPersist, {
    onDragEnter: () => {
      setIsHovered(true);
      setIsNotchHovered(true);
      setKiroMode('shelf');
    },
    onDragLeave: collapseAfterShelfDrag,
    onDrop: () => setKiroMode('shelf'),
  });

  // Hovering away used to always reopen the quick settings panel, so an item
  // dropped on the shelf looked like it had vanished: the shelf was still one
  // wheel notch away, but nothing pointed at it. Reopen the shelf instead when
  // that was the last panel on screen and it still holds something.
  useEffect(() => {
    if (kiroMode === 'shelf' && shelf.items.length === 0) wasShelfRef.current = false;
  }, [kiroMode, shelf.items.length]);

  useEffect(() => {
    if ((kiroMode === 'command-center' && !panelControlCenter) || (kiroMode === 'shelf' && !panelShelf)) {
      setKiroMode('status');
    }
  }, [kiroMode, panelControlCenter, panelShelf]);

  useEffect(() => {
    if (kiroMode === 'agent' && !agentActivity) setKiroMode('status');
  }, [kiroMode, agentActivity]);

  // Music mode shows any time we have media info (playing or paused) and music mode setting is enabled
  const isMusicMode = mediaInfo.has_media && kiroMode === 'music' && settingsMusicModeEnabled;

  // Second clock beside the time
  const showDualClock = settingsDualClockEnabled && !settingsLegacyMode && dualTime !== "";
  const dualClockSize = useMemo(
    () => (showDualClock ? measureDualClock(time, dualClockLabel, dualTime, dualDayShift) : null),
    [showDualClock, time, dualClockLabel, dualTime, dualDayShift]
  );
  const dualClockExtra = dualClockSize?.extra ?? 0;
  const dualClockTooltip = useMemo(
    () => (showDualClock ? [dualClockLabel, zoneOffsetLabel(dualClockZone), zoneDifferenceLabel(dualClockZone)].filter(Boolean).join(" · ") : ""),
    // dualTime changes every minute, which picks up DST changes in either zone.
    [showDualClock, dualClockLabel, dualClockZone, dualTime]
  );

  // Calculate width dynamically based on enabled features
  const agentNeedsYou = !!agentActivity && isNotchWindow;
  const agentWings = !!agentActivity && isNotchWindow && !isHovered && (kiroMode === 'status' || isMusicMode);

  const getDynamicWidth = () => {
    if (kiroMode === 'tour') return 380;
    if (kiroMode === 'agent') return 340;
    if (kiroMode === 'shelf') return Math.max(300, Math.min(120 + shelf.items.length * 70, 460));
    if (isCalendarMode) return Math.max(settingsCalendarEnabled && showClockColumn ? 480 : settingsCalendarEnabled ? 310 : 270, 140 + dualClockExtra);
    if (kiroMode === 'command-center' && isHovered) {
      const totalWidgets = statusWidgets.left.length + statusWidgets.right.length;
      return Math.max(390, Math.min(200 + totalWidgets * 65, 480)) + dualClockExtra;
    }
    if (kiroMode === 'status' && isHovered) {
      const totalWidgets = statusWidgets.left.length + statusWidgets.right.length;
      return Math.min(200 + totalWidgets * 65, 460) + dualClockExtra;
    }
    if (isMusicMode && isHovered) return mediaLayout === 'compact' ? 300 : 340;
    if ((showPowerPulse || showLowBatteryPulse || showUpdatePulse) && !isHovered) return 200;

    let w = 140 + dualClockExtra + (agentWings ? (isMusicMode ? 24 : 56) : 0);
    if (isMusicMode) {
      if (settingsVisualizerEnabled && isPlaying) w += 30;
      if (settingsAlbumArtEnabled) w += 30;

      if (isHovered) {
        w += 60;
      }
    }

    return w;
  };

  const getDynamicHeight = () => {
    if (!isExpanded || isHidden) {
      return isImpacted ? 28.9 : 44.2;
    }
    if (kiroMode === 'tour') return 210;
    if (kiroMode === 'agent') return agentActivity?.ask ? 184 : agentActivity?.detail ? 160 : 130;
    if (kiroMode === 'shelf') return shelf.items.length === 0 ? 96 : 156;
    if (kiroMode === 'calendar') return settingsCalendarEnabled ? (caldav.connected ? 350 : 310) : 262;
    if (kiroMode === 'command-center') {
      if (!isHovered) return 36;
      const tileRows = Math.ceil(ccResolved.tiles.length / 2);
      const tilesH = tileRows ? tileRows * 42 + (tileRows - 1) * 10 + 14 : 0;
      const buttonsH = ccResolved.buttons.length ? 44 : 0;
      const slidersH = ccResolved.sliders.length ? ccResolved.sliders.length * 22 + (ccResolved.sliders.length - 1) * 12 + 14 : 0;
      return 46 + tilesH + buttonsH + slidersH;
    }
    if (kiroMode === 'status') return 36;
    if (isMusicMode && isHovered) {
      const hasProgressBar = (mediaInfo.duration_ms ?? 0) > 0;
      let h = mediaLayout === 'compact' ? (hasProgressBar ? 132 : 116) : 120;
      if (mediaLayout === 'compact') {
        if (compactVolumeExpanded) h += 36;
      }
      return h;
    }
    return 36;
  };

  const isCalendarMode = kiroMode === 'calendar';
  // Calendar, command center and shelf are big, dense panels; glass styles thicken the fill for them
  const isPanelOpen = isHovered && (isCalendarMode || kiroMode === 'command-center' || kiroMode === 'shelf');

  // Album tints the whole notch, collapsed pill included. The expanded state
  // reads --kiro-bg-expanded and the muted/border vars live on :root, so all
  // of them have to be overridden or the panel loses the tint when hovered.
  const withAlpha = (color: string, alpha: number | string) => {
    const m = /^rgb\((.+)\)$/.exec(color.trim());
    return m ? `rgb(${m[1]} / ${alpha})` : color;
  };
  const musicTint =
    isMusicMode && settingsArtworkTheme && musicTheme.background
      ? ({
          "--kiro-bg": withAlpha(musicTheme.background, "var(--kiro-opacity, 0.8)"),
          "--kiro-bg-expanded": withAlpha(musicTheme.background, "var(--kiro-opacity-expanded, 0.92)"),
          "--kiro-text": musicTheme.text,
          "--kiro-text-muted": withAlpha(musicTheme.text, 0.65),
          "--kiro-border": withAlpha(musicTheme.text, 0.12),
          "--music-accent": musicTheme.accent,
        } as React.CSSProperties)
      : undefined;

  // Close compact media player expansions when notch is unhovered or mode changes
  useEffect(() => {
    if (mediaLayout === 'compact') {
      setCompactVolumeExpanded(false);
    }
  }, [isHovered, mediaLayout, kiroMode]);




  return (
    <div className={`screen${notchBottomRight ? ' notch-bottom-right' : ''}`} style={{ overflow: 'hidden' }}>
      {/* Screen Corners (Top) */}
      <AnimatePresence>
        {isVisible && settingsCornersEnabled && !notchBottomRight && (
          <>
            <motion.div
              className="screen-corner top-left"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(10px)" }}
            />
            <motion.div
              className="screen-corner top-right"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(10px)" }}
            />
          </>
        )}
      </AnimatePresence>

      <div style={{ zoom: scale, width: '100%', display: 'flex', justifyContent: notchBottomRight ? 'flex-end' : 'center', alignItems: notchBottomRight ? 'flex-end' : 'flex-start', height: '100%', paddingRight: notchBottomRight ? '12px' : 0, paddingBottom: notchBottomRight ? '10px' : 0, boxSizing: 'border-box' }}>
        <motion.div
          ref={kiroRef}
          className={`kiro ${isHovered ? 'expanded' : ''} ${isImpacted && !notchBottomRight ? 'is-impacted' : ''} ${isPanelOpen ? 'panel-open' : ''}`}
          onMouseEnter={() => setIsNotchHovered(true)}
        onMouseLeave={() => setIsNotchHovered(false)}
        onWheel={handleWheel}
        initial={{ y: 250, width: 30.6, height: 44.2, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderBottomLeftRadius: 18, borderBottomRightRadius: 18, scaleX: 1, scaleY: 1, opacity: 0 }}
        animate={{
          y: !isReady ? 250 : (isHidden ? (notchBottomRight ? 100 : -100) : 0),
          width: !isReady ? 34 : (isExpanded && !isHidden ? getDynamicWidth() : (isImpacted ? 39.1 : 30.6)),
          height: !isReady ? 34 : getDynamicHeight(),
          opacity: isReady ? 1 : 0,
          scaleX: 1,
          scaleY: 1,
          borderTopLeftRadius: isImpacted && !notchBottomRight ? 0 : 18,
          borderTopRightRadius: isImpacted && !notchBottomRight ? 0 : 18,
          borderBottomLeftRadius: isCalendarMode ? 28 : 18,
          borderBottomRightRadius: isCalendarMode ? 28 : 18,
        }}
        onClick={(e) => {
          e.stopPropagation();
          // Clicking the bar opens the quick settings panel (Wi-Fi,
          // Bluetooth, volume, brightness). Controls inside stop the event
          // themselves so they keep working. Moving away closes it again.
          if (availableNotchModes().includes('command-center')) {
            setKiroMode('command-center');
          }
        }}
        onHoverStart={() => {
          clearTimeout(shelfCollapseTimer.current);
          setIsHovered(true);
          if (kiroMode !== 'tour' && kiroMode !== 'shelf') {
            const modes = availableNotchModes();
            const remembered = settingsRememberMode ? rememberedModeRef.current : null;
            if (wasShelfRef.current && shelf.items.length > 0 && modes.includes('shelf')) {
              // The shelf still holds something and was the last thing on
              // screen: show it again instead of the quick settings.
              setKiroMode('shelf');
            } else if (agentNeedsYou) setKiroMode('agent');
            // Opening the notch shows the quick settings panel (Wi-Fi,
            // Bluetooth, volume, brightness). A playing track wins, and
            // scrolling still reaches every other panel.
            else if (mediaInfo.has_media && isPlaying && settingsMusicModeEnabled && modes.includes('music')) setKiroMode('music');
            else if (modes.includes('command-center')) setKiroMode('command-center');
            else if (remembered && modes.includes(remembered)) setKiroMode(remembered);
            else setKiroMode('status');
          }
        }}
        onHoverEnd={() => {
          wasShelfRef.current = kiroMode === 'shelf';
          if (kiroMode === 'shelf' && shelfHoldsOpen()) {
            deferShelfCollapse();
            return;
          }
          setIsHovered(false);
          if (kiroMode === 'command-center' || kiroMode === 'calendar' || kiroMode === 'shelf') rememberedModeRef.current = kiroMode;
          const targetMode = mediaInfo.has_media && isPlaying && settingsMusicCompactNotch ? 'music' : 'status';
          if (kiroMode === 'music') {
            setKiroMode(targetMode);
          } else if (kiroMode === 'command-center' || kiroMode === 'calendar' || kiroMode === 'status' || kiroMode === 'shelf' || kiroMode === 'agent') {
            setKiroMode(targetMode);
          }
        }}
        style={{ originY: 0, ...musicTint }}
        transition={{
          width: SHELL_SPRING,
          height: SHELL_SPRING,
          y: { type: "spring", stiffness: 550, damping: 45, mass: 0.8, restDelta: 0.001 },
          opacity: { duration: 0.2 },
          borderTopLeftRadius: SHELL_SPRING,
          borderTopRightRadius: SHELL_SPRING,
          borderBottomLeftRadius: SHELL_SPRING,
          borderBottomRightRadius: SHELL_SPRING,
          default: { type: "spring", stiffness: 500, damping: 30, mass: 1 }
        }}
      >
        {widgetTip && isHovered && <div className="widget-tip">{widgetTip}</div>}



        <AnimatePresence>
          {isMusicMode && settingsAmbienceEnabled && !settingsArtworkTheme && albumArtUrl && isHovered && !isCalendarMode && (
            <motion.div
              className="notch-ambient-glow"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <AnimatePresence mode="wait">
                <motion.img
                  key={albumArtUrl}
                  src={albumArtUrl}
                  alt=""
                  draggable={false}
                  initial={{ opacity: 0, scale: 1.1 }}
                  animate={{ opacity: 1, scale: 1.8 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                />
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence mode="wait">
          {isExpanded && (
            <motion.div
              key="kiro-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
              style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', borderRadius: 'inherit' }}
            >
              {/* Faster Waiting Transition Area */}
              <AnimatePresence mode="wait">
                {isHovered && isMusicMode && !isCalendarMode ? (
                  <motion.div
                    key="expanded-music"
                    className="expanded-music-container"
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  >
                    {mediaLayout === 'compact' ? (
                      <CompactMediaPlayer
                        mediaInfo={mediaInfo}
                        albumArtUrl={albumArtUrl}
                        albumArtKey={albumArtKey}
                        isPlaying={isPlaying}
                        volume={displayVolume}
                        volumeExpanded={compactVolumeExpanded}
                        onVolumeExpandedChange={setCompactVolumeExpanded}
                        onTogglePlayPause={togglePlayPause}
                        onVolumeChange={handleVolumeChange}
                        prevFront={prevFront}
                        prevBack={prevBack}
                        nextFront={nextFront}
                        nextBack={nextBack}
                        onAnimatePrev={animatePrev}
                        onAnimateNext={animateNext}
                        sessions={mediaSessions}
                        onNextPanel={cycleNotchMode}
                        onLayoutChange={(layout) => {
                          setMediaLayout(layout);
                          localStorage.setItem("kiro-media-layout", layout);
                          window.dispatchEvent(new CustomEvent("settings-changed", { detail: { key: "media-layout", value: layout } }));
                        }}
                      />
                    ) : (
                    <div className="compact-premium-layout">
                      <div className="album-art-section">
                        <motion.div
                          className="premium-album-art"
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setMediaLayout('compact');
                            localStorage.setItem("kiro-media-layout", "compact");
                            window.dispatchEvent(new CustomEvent("settings-changed", { detail: { key: "media-layout", value: "compact" } }));
                          }}
                          style={{ cursor: 'pointer' }}
                        >
                          <AnimatePresence mode="wait" initial={false}>
                            {albumArtUrl ? (
                              <motion.img
                                key={`art-${albumArtKey}`}
                                src={albumArtUrl}
                                alt={t("media.art")}
                                initial={{ rotateY: 90, opacity: 0 }}
                                animate={{ rotateY: 0, opacity: 1 }}
                                exit={{ rotateY: -90, opacity: 0 }}
                                transition={{ duration: 0.3, ease: "easeInOut" }}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <motion.div
                                key="placeholder"
                                className="art-placeholder-mini"
                                initial={{ rotateY: 90, opacity: 0 }}
                                animate={{ rotateY: 0, opacity: 1 }}
                                exit={{ rotateY: -90, opacity: 0 }}
                                transition={{ duration: 0.3, ease: "easeInOut" }}
                              >
                                <MusicNoteIcon size={32} className="music-placeholder-svg" />
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      </div>

                      <div className="metadata-controls-section-middle">
                        <div className="track-header-row">
                          <div className="track-info-middle">
                            <TitleMarquee title={mediaInfo.title} />
                            <span className="premium-artist">{mediaInfo.artist}</span>
                          </div>
                          <div className="header-visualizer-wrap">
                            <MediaSourceButton sessions={mediaSessions} />
                            <button className="music-calendar-btn" onClick={cycleNotchMode} title={t("music.nextPanel")} aria-label={t("music.nextPanel")}>
                              <ChevronRight size={16} strokeWidth={1.75} />
                            </button>
                            <div className="header-visualizer">
                              <Visualizer isPlaying={isPlaying} bars={5} height={18} />
                            </div>
                          </div>
                        </div>

                        <div className="controls-row-sleek">
                          <motion.button
                            className="sleek-btn previous-btn"
                            onClick={(e) => { e.stopPropagation(); animatePrev(); }}
                            whileHover={{ scale: 1.2 }}
                            whileTap={{ scale: 0.9 }}
                            transition={{ type: "spring", stiffness: 400, damping: 25 }}
                          >
                            <div style={{ position: 'relative', width: 32, height: 16, overflow: 'hidden' }}>
                              <motion.div animate={prevBack} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <SkipBackIcon size={32} />
                              </motion.div>
                              <motion.div animate={prevFront} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <SkipBackIcon size={32} />
                              </motion.div>
                            </div>
                          </motion.button>

                          <motion.button
                            className="sleek-btn play-pause-btn-floating"
                            onClick={(e) => { e.stopPropagation(); togglePlayPause(); }}
                            whileHover={{ scale: 1.2 }}
                            whileTap={{ scale: 0.95 }}
                            transition={{ type: "spring", stiffness: 400, damping: 25 }}
                          >
                            <AnimatePresence mode="wait" initial={false}>
                              <motion.div
                                key={isPlaying ? "pause" : "play"}
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.8 }}
                                transition={{ duration: 0.15 }}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                              >
                                {isPlaying ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
                              </motion.div>
                            </AnimatePresence>
                          </motion.button>

                          <motion.button
                            className="sleek-btn next-btn"
                            onClick={(e) => { e.stopPropagation(); animateNext(); }}
                            whileHover={{ scale: 1.2 }}
                            whileTap={{ scale: 0.9 }}
                            transition={{ type: "spring", stiffness: 400, damping: 25 }}
                          >
                            <div style={{ position: 'relative', width: 32, height: 16, overflow: 'hidden' }}>
                              <motion.div animate={nextBack} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <SkipForwardIcon size={32} />
                              </motion.div>
                              <motion.div animate={nextFront} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <SkipForwardIcon size={32} />
                              </motion.div>
                            </div>
                          </motion.button>
                        </div>

                        <div className="volume-slider-container" onWheel={handleVolumeWheel}>
                          <VolumeLowIcon size={14} style={{ opacity: 0.65 }} />
                          <div className="slider-track-premium">
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.01"
                              value={displayVolume}
                              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => e.stopPropagation()}
                              className="premium-slider"
                            />
                            <div className="slider-progress-fill" style={{ width: `${displayVolume * 100}%` }} />
                          </div>
                          <VolumeHighIcon size={16} style={{ opacity: 0.65 }} />
                        </div>
                      </div>

                    </div>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="standard-view-group"
                    initial={{ opacity: 0, y: -5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5, transition: { duration: 0.1 } }}
                    transition={{ duration: 0.2 }}
                    style={{ width: '100%' }}
                  >
                    <div className="main-row">
                      <AnimatePresence mode="wait">
                        {(showPowerPulse || showLowBatteryPulse || showUpdatePulse) && !isHovered ? (
                          showUpdatePulse ? (
                            <motion.div
                              key="update-pulse-view"
                              initial={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
                              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                              exit={{ opacity: 0, scale: 1.05, filter: "blur(4px)" }}
                              className="power-pulse-content"
                            >
                              <GreenDownArrowIcon />
                              <span className="label" style={{ color: "#32D74B" }}>
                                {t("battery.updateAvailable")}
                              </span>
                            </motion.div>
                          ) : (
                            <motion.div
                              key="pulse-view"
                              initial={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
                              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                              exit={{ opacity: 0, scale: 1.05, filter: "blur(4px)" }}
                              className="power-pulse-content"
                            >
                              {updateAvailable && <GreenDownArrowIcon />}
                              <BatteryIcon charging={isCharging} level={batteryLevel} threshold={lowBatteryThreshold} />
                              <span className="label" style={{ color: showLowBatteryPulse ? "#FF453A" : "inherit" }}>
                                {showLowBatteryPulse ? t("battery.low") : (isCharging ? t("battery.charging") : t("battery.onBatteryTitle"))} • {batteryLevel}%
                              </span>
                            </motion.div>
                          )
                        ) : (
                          <motion.div
                            key="standard-view"
                            className="main-row-inner"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                          >
                            {/* Left: update activity (takes priority), visualizer (music), or weather (command-center, calendar) */}
                            <div className="side-content left">
                              {agentWings && agentActivity ? (
                                <AgentLeft activity={agentActivity} dot={isMusicMode} />
                              ) : updateAvailable && showUpdateIndicator ? (
                                <AnimatePresence>
                                  <motion.div
                                    key="update-activity"
                                    initial={{ scale: 0.8, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    exit={{ scale: 0.8, opacity: 0 }}
                                  >
                                    <UpdateActivity />
                                  </motion.div>
                                </AnimatePresence>
                              ) : isMusicMode && settingsVisualizerEnabled ? (
                                <AnimatePresence>
                                  {settingsVisualizerEnabled && (
                                    <motion.div
                                      key="visualizer"
                                      initial={{ scale: 0.8, opacity: 0 }}
                                      animate={{ scale: 1, opacity: 1 }}
                                      exit={{ scale: 0.8, opacity: 0 }}
                                    >
                                      <Visualizer isPlaying={isPlaying} />
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              ) : (!isMusicMode && isHovered && statusWidgets.left.length > 0) ? (
                                <motion.div
                                  key="left-widgets"
                                  className="passive-features-group"
                                  onClick={openStatusPanel}
                                  {...(settingsLegacyMode ? { "data-tooltip": t("notch.widgetsTooltip") } : {})}
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  exit={{ opacity: 0 }}
                                  transition={{ duration: 0.2 }}
                                >
                                  {statusWidgets.left.map(renderStatusWidget)}
                                </motion.div>
                              ) : null}
                            </div>

                            {/* Center - Time (always visible) */}
                            <div className="time-center">
                              <div
                                className="time-flip-container"
                                onClick={toggleControlCenter}
                                data-tooltip={t("notch.clockTooltip")}
                                style={dualClockSize ? { minWidth: dualClockSize.main } : undefined}
                              >
                                <AnimatePresence initial={false}>
                                  {isCompactTimerVisible || isTimerFinished ? (
                                    <motion.span
                                      key="timer"
                                      className={`time compact-timer ${isTimerFinished ? 'timer-finished' : ''}`}
                                      initial={{ rotateX: -90, opacity: 0 }}
                                      animate={{ rotateX: 0, opacity: 1 }}
                                      exit={{ rotateX: 90, opacity: 0 }}
                                      transition={{ type: "spring", stiffness: 600, damping: 30 }}
                                    >
                                      {isTimerRunning || isTimerFinished
                                        ? formatTimerTime(timerSeconds)
                                        : <StopwatchReadout base={stopwatch.base} startedAt={stopwatch.startedAt} precise={false} />}
                                    </motion.span>
                                  ) : (
                                    <motion.span
                                      key="clock"
                                      className="time"
                                      initial={{ rotateX: -90, opacity: 0 }}
                                      animate={{ rotateX: 0, opacity: 1 }}
                                      exit={{ rotateX: 90, opacity: 0 }}
                                      transition={{ type: "spring", stiffness: 600, damping: 30 }}
                                    >
                                      <TimeDisplay hour12={!timeFormat24h} />
                                    </motion.span>
                                  )}
                                </AnimatePresence>
                              </div>
                              {notchBottomRight && isHovered && !isCompactTimerVisible && !isTimerFinished && (
                                <div
                                  className="time-date"
                                  onClick={toggleCalendarMode}
                                  data-tooltip={t("notch.dateTooltip")}
                                >
                                  {todayDate.toLocaleDateString(dateLocale(), { day: "numeric", month: "short" })}
                                </div>
                              )}
                              {showDualClock && (
                                <div className="time-secondary" onClick={toggleCalendarMode} data-tooltip={dualClockTooltip}>
                                  <span className="time-secondary-label">{dualClockLabel}</span>
                                  <span className="time-secondary-value">{dualTime}</span>
                                  {dualDayShift !== 0 && <span className="time-secondary-shift">{dayShiftLabel(dualDayShift)}</span>}
                                </div>
                              )}
                            </div>

                            {/* Right: album art (music) or battery (command-center, calendar) */}
                            <div className="side-content right">
                              {agentWings && !isMusicMode && agentActivity ? (
                                <AgentDot activity={agentActivity} />
                              ) : isMusicMode && settingsAlbumArtEnabled ? (
                                <AnimatePresence mode="wait">
                                  <motion.div
                                    key="album-art"
                                    className="album-art-glow-wrapper"
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, y: -20, scale: 0.8, filter: "blur(8px)" }}
                                    transition={{ duration: 0.12 }}
                                  >
                                    {albumArtUrl && settingsCompactGlowEnabled && (
                                      <img
                                        src={albumArtUrl}
                                        alt=""
                                        className="album-art-glow-bg"
                                        draggable={false}
                                      />
                                    )}
                                    <button
                                      className={`album-art${isHovered ? ' album-art-large' : ''}${!isPlaying ? ' paused' : ''}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        togglePlayPause();
                                      }}
                                      onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        skipNext();
                                      }}
                                      onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        skipPrevious();
                                      }}
                                    >
                                      <div className="album-art-inner">
                                        <AnimatePresence mode="wait" initial={false}>
                                          {albumArtUrl ? (
                                            <motion.img
                                              key={`compact-art-${albumArtKey}`}
                                              src={albumArtUrl}
                                              alt={t("media.art")}
                                              draggable={false}
                                              initial={{ rotateY: 90, opacity: 0 }}
                                              animate={{ rotateY: 0, opacity: 1 }}
                                              exit={{ rotateY: -90, opacity: 0 }}
                                              transition={{ duration: 0.25, ease: "easeInOut" }}
                                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                            />
                                          ) : (
                                            <motion.div
                                              key="compact-placeholder"
                                              className="album-art-placeholder"
                                              initial={{ rotateY: 90, opacity: 0 }}
                                              animate={{ rotateY: 0, opacity: 1 }}
                                              exit={{ rotateY: -90, opacity: 0 }}
                                              transition={{ duration: 0.25, ease: "easeInOut" }}
                                            >
                                              <MusicNoteIcon className="music-placeholder-svg-small" />
                                          </motion.div>
                                        )}
                                      </AnimatePresence>
                                      <div className="album-art-overlay">
                                        <div className="control-icon-small">
                                          {isPlaying ? <PauseIcon /> : <PlayIcon />}
                                        </div>
                                      </div>
                                    </div>
                                  </button>
                                  </motion.div>
                                </AnimatePresence>
                              ) : (!isMusicMode && isHovered && statusWidgets.right.length > 0) ? (
                                <motion.div
                                  key="right-widgets"
                                  className="passive-features-group"
                                  onClick={openStatusPanel}
                                  {...(settingsLegacyMode ? { "data-tooltip": t("notch.widgetsTooltip") } : {})}
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  exit={{ opacity: 0 }}
                                  transition={{ duration: 0.2 }}
                                >
                                  {statusWidgets.right.map(renderStatusWidget)}
                                </motion.div>
                              ) : null}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Command Center Panel */}
              <AnimatePresence>
                {kiroMode === 'command-center' && (
                  <motion.div
                    className="command-center-content-minimal"
                    onClick={e => e.stopPropagation()}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.1 } }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  >
                    {showConnections && (
                      <ConnectionsView
                        kind={ccView}
                        onBack={() => setCcView('main')}
                        onOpenWindowsSettings={() => { invoke(ccView === 'wifi' ? 'open_wifi_settings' : ccView === 'audio' ? 'open_sound_settings' : 'open_bluetooth_settings'); }}
                      />
                    )}

                    <div style={{ display: showConnections ? 'none' : 'contents' }}>
                    {/* Pills Grid */}
                    <div className="cc-pills-grid" style={ccResolved.tiles.length ? undefined : { display: 'none' }}>
                      {/* Wi-Fi Pill */}
                      <div
                        className={`cc-pill-tile ${showLan || wifiEnabled ? 'active' : ''}`}
                        style={ccStyle("tiles", "network")}
                        onClick={(e) => { e.stopPropagation(); if (showLan) invoke('open_ethernet_settings'); else toggleWifi(); }}
                        onContextMenu={handleWifiRightClick}
                      >
                        <div className="cc-pill-icon-wrapper">
                          {showLan ? <EthernetIcon /> : <WifiIcon enabled={wifiEnabled} connected={wifiConnected} />}
                        </div>
                        <div className="cc-pill-info">
                          <span className="cc-pill-title">{showLan ? t('cc.ethernet') : t('cc.wifi')}</span>
                          <span className="cc-pill-status">{showLan ? t('connections.connected') : wifiStatus === null ? '…' : !wifiEnabled ? t('common.off') : wifiConnected ? t('connections.connected') : t('cc.notConnected')}</span>
                        </div>
                        {!settingsLegacyMode && !showLan && (
                          <span className="cc-pill-more" title={t("cc.networks")} onClick={(e) => { e.stopPropagation(); setCcView('wifi'); }}>›</span>
                        )}
                      </div>

                      {/* Dock Mode Pill */}
                      <div
                        className={`cc-pill-tile ${dockMode === 'fixed' ? 'active' : ''}`}
                        style={ccStyle("tiles", "dock-mode")}
                        onClick={toggleDockModeSetting}
                      >
                        <div className="cc-pill-icon-wrapper">
                          <DockIcon />
                        </div>
                        <div className="cc-pill-info">
                          <span className="cc-pill-title">{t("cc.dockMode")}</span>
                          <span className="cc-pill-status">{dockMode === 'fixed' ? t('common.fixed') : dockMode === 'smart' ? t('common.smart') : t('common.peek')}</span>
                        </div>
                      </div>

                      {/* Bluetooth Pill */}
                      <div
                        className={`cc-pill-tile ${bluetoothEnabled ? 'active' : ''}`}
                        style={ccStyle("tiles", "bluetooth")}
                        onClick={(e) => { e.stopPropagation(); toggleBluetooth(); }}
                        onContextMenu={handleBluetoothRightClick}
                      >
                        <div className="cc-pill-icon-wrapper">
                          <BluetoothIcon />
                        </div>
                        <div className="cc-pill-info">
                          <span className="cc-pill-title">{t("cc.bluetooth")}</span>
                          <span className="cc-pill-status">{bluetoothEnabled ? t('common.on') : t('common.off')}</span>
                        </div>
                        {!settingsLegacyMode && (
                          <span className="cc-pill-more" title={t("cc.devices")} onClick={(e) => { e.stopPropagation(); setCcView('bluetooth'); }}>›</span>
                        )}
                      </div>

                      {/* Notch Mode Pill */}
                      <div
                        className={`cc-pill-tile ${notchMode === 'fixed' ? 'active' : ''}`}
                        style={ccStyle("tiles", "notch-mode")}
                        onClick={toggleNotchModeSetting}
                      >
                        <div className="cc-pill-icon-wrapper">
                          <NotchIcon />
                        </div>
                        <div className="cc-pill-info">
                          <span className="cc-pill-title">{t("cc.notchMode")}</span>
                          <span className="cc-pill-status">{notchMode === 'fixed' ? t('common.fixed') : notchMode === 'smart' ? t('common.smart') : t('common.peek')}</span>
                        </div>
                      </div>
                    </div>

                    {/* Circular Actions Row */}
                    <div className="cc-circular-actions-row" style={ccResolved.buttons.length ? undefined : { display: 'none' }}>
                      <button
                        className={`cc-circular-btn ${dndActive ? 'active' : ''}`}
                        style={ccStyle("buttons", "dnd")}
                        {...tip(t("cc.dnd"))}
                        onClick={(e) => { e.stopPropagation(); setDndActive(prev => !prev); }}
                      >
                        <MoonIcon />
                      </button>
                      <button
                        className={`cc-circular-btn ${batterySaverEnabled ? 'active' : ''}`}
                        style={ccStyle("buttons", "battery-saver")}
                        {...tip(t("cc.batterySaver"))}
                        onClick={(e) => { e.stopPropagation(); void toggleBatterySaver(); }}
                      >
                        <BatterySaverIcon />
                      </button>
                      <button
                        className="cc-circular-btn"
                        style={ccStyle("buttons", "tray")}
                        {...tip(t("cc.tray"))}
                        onClick={(e) => { e.stopPropagation(); invoke("open_tray_window"); }}
                      >
                        <TrayIcon />
                      </button>
                      <button
                        className="cc-circular-btn"
                        style={ccStyle("buttons", "notifications")}
                        {...tip(t("cc.notifications"))}
                        onClick={(e) => { e.stopPropagation(); invoke("open_notification_center"); }}
                      >
                        <BellIcon />
                      </button>
                      <button
                        className="cc-circular-btn"
                        style={ccStyle("buttons", "settings")}
                        {...tip(t("cc.settings"))}
                        onClick={(e) => { e.stopPropagation(); openSettingsWindow(); }}
                      >
                        <SettingsIcon />
                      </button>
                      <button
                        className="cc-circular-btn"
                        style={ccStyle("buttons", "restart")}
                        {...tip(t("general.restart"))}
                        onClick={(e) => { e.stopPropagation(); invoke("restart_kiro"); }}
                      >
                        <ReloadIcon />
                      </button>
                    </div>

                    {/* Classic Sliders Area */}
                    <div className="cc-classic-sliders-area" style={ccResolved.sliders.length ? undefined : { display: 'none' }}>
                      {/* Volume Slider */}
                      <div className="cc-classic-slider-row" style={ccStyle("sliders", "volume")} onWheel={handleVolumeWheel}>
                        <div
                          className={`cc-classic-slider-label${settingsLegacyMode ? '' : ' clickable'}`}
                          title={settingsLegacyMode ? undefined : t('cc.outputDevice')}
                          onClick={settingsLegacyMode ? undefined : (e) => { e.stopPropagation(); setCcView('audio'); }}
                        >
                          <VolumeLowIcon style={{ opacity: 0.5 }} />
                          <span>{t("cc.volume")}</span>
                          {!settingsLegacyMode && <span className="cc-label-more">›</span>}
                        </div>
                        <div className="cc-classic-slider-track">
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={displayVolume}
                            onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            className="cc-classic-input"
                          />
                          <div className="cc-classic-fill" style={{ width: `${displayVolume * 100}%` }} />
                        </div>
                        <span className="cc-classic-percentage">{Math.round(displayVolume * 100)}%</span>
                      </div>

                      {/* Brightness Slider */}
                      <div className="cc-classic-slider-row" style={ccStyle("sliders", "brightness")} onWheel={handleBrightnessWheel}>
                        <div className="cc-classic-slider-label">
                          <BrightnessLowIcon />
                          <span>{t("cc.brightness")}</span>
                        </div>
                        <div className="cc-classic-slider-track">
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={currentBrightness}
                            onChange={(e) => handleBrightnessChange(parseInt(e.target.value))}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            className="cc-classic-input"
                          />
                          <div className="cc-classic-fill" style={{ width: `${currentBrightness}%` }} />
                        </div>
                        <span className="cc-classic-percentage">{currentBrightness}%</span>
                      </div>
                    </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {kiroMode === 'shelf' && (
                  <motion.div
                    key="shelf"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.1 } }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  >
                    <NotchShelf
                      items={shelf.items}
                      dropActive={shelf.dropActive}
                      onReorder={shelf.reorder}
                      onRemove={shelf.remove}
                      onClear={shelf.clear}
                      onDragOutStart={() => {
                        clearTimeout(shelfCollapseTimer.current);
                        shelfDrag.current.active = true;
                      }}
                      onDragOutEnd={() => {
                        shelfDrag.current = { active: false, until: Date.now() + 2500 };
                        deferShelfCollapse();
                      }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {kiroMode === 'tour' && (
                  <motion.div
                    key="tour"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.1 } }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  >
                    <NotchTour
                      step={tourStep}
                      onStep={setTourStep}
                      onClose={closeTour}
                      onAction={(id) => {
                        closeTour();
                        if (id === 'control-center') setKiroMode('command-center');
                        else openSettingsWindow();
                      }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {kiroMode === 'agent' && agentActivity && (
                  <motion.div
                    key="agent-panel"
                    className="agent-panel"
                    onClick={e => e.stopPropagation()}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.1 } }}
                    transition={{ duration: 0.18, delay: 0.22 }}
                  >
                    <AgentPanel
                      activity={agentActivity}
                      onOpen={() => { if (agentActivity.window) invoke('focus_agent_window', { window: agentActivity.window }).catch(() => { }); }}
                      onDismiss={() => { setAgentActivity(null); setKiroMode('status'); }}
                      onAnswer={(allow) => {
                        if (agentActivity.ask) invoke('agent_answer', { id: agentActivity.ask.id, allow }).catch(() => { });
                        setAgentActivity({ ...agentActivity, state: 'working', ask: undefined });
                        setKiroMode('status');
                      }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Calendar & Timer Split View */}
              <AnimatePresence>
                {productivityEnabled && isCalendarMode && (
                  <motion.div
                    className="calendar-timer-content split-view"
                    onClick={e => e.stopPropagation()} /* Block mode switches when clicking inside */
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.1 } }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  >
                    {settingsCalendarEnabled && (
                      <div className="calendar-column">
                        <NotchCalendar caldav={caldav} hour12={!timeFormat24h} />
                      </div>
                    )}

                    {showClockColumn && (
                      <NotchClock
                        timerEnabled={settingsTimerEnabled}
                        stopwatchEnabled={settingsStopwatchEnabled}
                        solo={!settingsCalendarEnabled}
                        timerSeconds={timerSeconds}
                        isTimerRunning={isTimerRunning}
                        formatTimerTime={formatTimerTime}
                        onStartTimer={startTimerSeconds}
                        onToggleTimer={toggleTimer}
                        onResetTimer={resetTimer}
                        stopwatch={stopwatch}
                      />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

            </motion.div>
          )}
        </AnimatePresence>

        <SurfaceShape
          edge={notchBottomRight ? "bottom" : "top"}
          flare={notchBottomRight ? 0 : (isImpacted ? 13 : 0)}
          radius={isCalendarMode ? 28 : 18}
          edgeRadius={18}
        />

        {showTimerProgressBar && (
          <NotchProgressBorder
            progress={timerProgressPercent}
            topRadius={isImpacted && !notchBottomRight ? 0 : 18}
            flare={notchBottomRight ? 0 : (isImpacted ? 13 : 0)}
            bottomRadius={isCalendarMode ? 28 : 18}
            paused={!isTimerRunning}
            finished={isTimerFinished}
            title={`${formatTimerTime(timerSeconds)} (${Math.round(timerProgressRatio * 100)}%)`}
          />
        )}

      </motion.div>
    </div>

    </div>
  );
}

function BluetoothIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.9 }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function BrightnessLowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
      <circle cx="12" cy="12" r="5" fill="currentColor" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function DockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="18" x2="6.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
      <line x1="10" y1="18" x2="10.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
      <line x1="14" y1="18" x2="14.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
      <line x1="18" y1="18" x2="18.01" y2="18" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

function NotchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 3h16a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M9 9v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V9" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9z" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function ReloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
    </svg>
  );
}

function BatterySaverIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="16" height="10" rx="2" />
      <path d="M22 11v2" />
      <path d="M6 12h4l2-3v6l-2-3H6" />
    </svg>
  );
}

export default App;

