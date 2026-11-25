import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CaldavState, CalEvent } from "../hooks/useCaldav";
import { dateLocale, useT, weekHeader, weekStartsOn } from "../i18n";
import { dayOfYear, daysInYear, holidayOn, isoWeek } from "../holidays";
import { openSettingsAt } from "../settingsNav";

type View = "day" | "week" | "month" | "agenda";

const VIEWS: { id: View; labelKey: string }[] = [
  { id: "day", labelKey: "calendar.view.day" },
  { id: "week", labelKey: "calendar.view.week" },
  { id: "month", labelKey: "calendar.view.month" },
  { id: "agenda", labelKey: "calendar.view.agenda" },
];

const VIEW_KEY = "kiro-calendar-view";
const AGENDA_DAYS = 14;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function eventsOn(events: CalEvent[], day: Date): CalEvent[] {
  const from = day.getTime();
  const to = addDays(day, 1).getTime();
  return events
    .filter((e) => e.start < to && e.end > from)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function readView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "day" || saved === "week" || saved === "month" || saved === "agenda") return saved;
  } catch {
    return "month";
  }
  return "month";
}

function colorVar(e: CalEvent): React.CSSProperties {
  return { ["--c" as string]: e.color ?? "var(--kiro-text, #fff)" };
}

interface Props {
  caldav: CaldavState;
  hour12: boolean;
}

export function NotchCalendar({ caldav, hour12 }: Props) {
  const t = useT();
  const connected = caldav.connected;
  const today = startOfDay(new Date());
  const [view, setViewState] = useState<View>(readView);
  const [anchor, setAnchor] = useState<Date>(today);
  const [picking, setPicking] = useState(false);
  const [pickerYear, setPickerYear] = useState(today.getFullYear());
  const lastWheel = useRef(0);

  const time = (ms: number) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit", hour12 });

  const setView = (next: View) => {
    setViewState(next);
    remember(VIEW_KEY, next);
    invoke("save_setting", { key: VIEW_KEY, value: next }).catch(() => {});
  };

  const shift = (dir: number) => {
    const current = connected ? view : "month";
    if (current === "month") {
      const next = new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
      setAnchor(next.getFullYear() === today.getFullYear() && next.getMonth() === today.getMonth() ? today : next);
    } else if (current === "week") {
      setAnchor(addDays(anchor, 7 * dir));
    } else {
      setAnchor(addDays(anchor, dir));
    }
  };

  const openDay = (day: Date) => {
    setAnchor(day);
    setView("day");
  };

  const activeView: View = connected ? view : "month";

  let title: string;
  if (activeView === "week") {
    const start = weekStartsOn();
    const first = addDays(anchor, -((anchor.getDay() - start + 7) % 7));
    const last = addDays(first, 6);
    const fmt = (d: Date) => d.toLocaleDateString(dateLocale(), { month: "short", day: "numeric" });
    title = `${fmt(first)} – ${first.getMonth() === last.getMonth() ? last.getDate() : fmt(last)}`;
  } else if (activeView === "day") {
    title = anchor.toLocaleDateString(dateLocale(), { weekday: "short", month: "short", day: "numeric" });
  } else if (activeView === "agenda") {
    title = t("calendar.upcoming");
  } else {
    title = anchor.toLocaleDateString(dateLocale(), { month: "long", year: "numeric" });
  }

  const showToday = activeView !== "agenda" && !sameDay(anchor, today);
  const lang = dateLocale();
  const anchorHoliday = activeView === "month" || activeView === "day" ? holidayOn(anchor, lang) : null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const key = e.key;
    const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    if (step !== 0) {
      e.preventDefault();
      setAnchor((d) => addDays(d, step));
      return;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      e.preventDefault();
      setAnchor((d) => addDays(d, key === "ArrowUp" ? -7 : 7));
      return;
    }
    if (key === "PageUp" || key === "PageDown") {
      e.preventDefault();
      setAnchor((d) => addMonths(d, key === "PageUp" ? -1 : 1));
      return;
    }
    if (key === "Home" || key === "t" || key === "T") {
      e.preventDefault();
      setAnchor(today);
    }
  };

  // The notch never scrolls, so the wheel is free to page the month without
  // stealing the scroll from anything. Debounced: one gesture is one month.
  const onWheel = (e: React.WheelEvent) => {
    if (activeView !== "month" || picking || Math.abs(e.deltaY) < 4) return;
    const now = Date.now();
    if (now - lastWheel.current < 180) return;
    lastWheel.current = now;
    shift(e.deltaY > 0 ? 1 : -1);
  };

  return (
    <div
      className={`calendar-container${connected ? " with-agenda" : ""}`}
      tabIndex={0}
      role="group"
      aria-label={t("calendar.title")}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
    >
      <div className="cal-head">
        <button
          className={`cal-title${picking ? " open" : ""}`}
          onClick={() => {
            setPickerYear(anchor.getFullYear());
            setPicking((p) => !p);
          }}
          aria-expanded={picking}
          aria-label={t("calendar.pickMonth")}
          title={t("calendar.pickMonth")}
        >
          <span className="cal-title-month">
            {activeView === "month"
              ? anchor.toLocaleDateString(dateLocale(), { month: "long" })
              : title}
          </span>
          {activeView === "month" && <span className="cal-title-year">{anchor.getFullYear()}</span>}
        </button>
        <span className="cal-actions">
          <button
            className="cal-today-dot"
            onClick={() => setAnchor(today)}
            title={t("calendar.today")}
            aria-label={t("calendar.today")}
            style={{ display: showToday ? undefined : "none" }}
          />
          {activeView !== "agenda" && (
            <>
              <button className="cal-nav" onClick={() => shift(-1)} aria-label={t("calendar.previous")}>
                &#8249;
              </button>
              <button className="cal-nav" onClick={() => shift(1)} aria-label={t("calendar.next")}>
                &#8250;
              </button>
            </>
          )}
        </span>
      </div>

      {connected && (
        <div className="cal-views" role="tablist">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              className={view === v.id ? "active" : ""}
              onClick={() => {
                setPicking(false);
                setView(v.id);
              }}
            >
              {t(v.labelKey)}
            </button>
          ))}
        </div>
      )}

      {picking ? (
        <MonthPicker
          year={pickerYear}
          selected={anchor}
          onYear={setPickerYear}
          onPick={(month) => {
            const next = new Date(pickerYear, month, 1);
            setAnchor(next.getFullYear() === today.getFullYear() && next.getMonth() === today.getMonth() ? today : next);
            setPicking(false);
          }}
        />
      ) : (
        <>
          {activeView === "month" && (
            <>
              <MonthGrid anchor={anchor} today={today} events={caldav.events} connected={connected} onPick={setAnchor} />
              {connected ? (
                <SelectedDay day={anchor} events={caldav.events} time={time} onOpen={() => openDay(anchor)} />
              ) : (
                <button className="cal-connect" onClick={() => void openSettingsAt("calendar-sync")}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="4" width="18" height="17" rx="3" />
                    <path d="M8 2v4M16 2v4M3 10h18M12 14v4M10 16h4" />
                  </svg>
                  <span>{t("calendar.connect")}</span>
                  <span className="cal-connect-hint">{t("calendar.connectHint")}</span>
                </button>
              )}
            </>
          )}
          {connected && activeView === "week" && (
            <WeekList anchor={anchor} today={today} events={caldav.events} time={time} onOpen={openDay} />
          )}
          {connected && activeView === "day" && <DayList day={anchor} events={caldav.events} time={time} />}
          {connected && activeView === "agenda" && (
            <AgendaList today={today} events={caldav.events} time={time} onOpen={openDay} />
          )}
        </>
      )}

      <div className="cal-foot">
        <span className="cal-foot-text">
          {anchorHoliday ? (
            <>
              <span className="cal-foot-main">
                {anchor.toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              </span>
              <span className="cal-foot-holiday">{anchorHoliday}</span>
            </>
          ) : (
            <>
              {t("calendar.week", { week: isoWeek(anchor) })}
              <span className="cal-dot-sep" />
              {t("calendar.dayOfYear", { day: dayOfYear(anchor), total: daysInYear(anchor.getFullYear()) })}
            </>
          )}
        </span>
        <button
          className="cal-open"
          onClick={() => invoke("open_calendar_window").catch(() => {})}
          title={t("calendar.openFull")}
          aria-label={t("calendar.openFull")}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" />
            <path d="M10 14L21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

interface MonthProps {
  anchor: Date;
  today: Date;
  events: CalEvent[];
  connected: boolean;
  onPick: (day: Date) => void;
}

const WEEKDAYS_PER_MONTH = 42;

function MonthGrid({ anchor, today, events, connected, onPick }: MonthProps) {
  const lang = dateLocale();
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const offset = (new Date(year, month, 1).getDay() - weekStartsOn() + 7) % 7;
  const gridStart = addDays(new Date(year, month, 1), -offset);
  const days = useMemo(
    () => Array.from({ length: WEEKDAYS_PER_MONTH }, (_, i) => addDays(gridStart, i)),
    // gridStart is fully described by year/month/offset.
    [year, month, offset]
  );

  const byDay = useMemo(
    () => days.map((day) => (connected ? eventsOn(events, day) : [])),
    [days, events, connected]
  );

  return (
    <div className={`cal-grid${weekStartsOn() === 1 ? " monday-first" : ""}`}>
      <div className="cal-dow">
        <span className="cal-weekno-head" aria-hidden />
        {weekHeader("short").map((d, i) => (
          <span key={`${d}-${i}`}>{d}</span>
        ))}
      </div>
      <div className="cal-days">
        {Array.from({ length: WEEKDAYS_PER_MONTH / 7 }, (_, row) => (
          <div key={`week-${row}`} className="cal-week">
            <span className="cal-weekno" aria-hidden>
              {isoWeek(days[row * 7])}
            </span>
            {days.slice(row * 7, row * 7 + 7).map((day, col) => {
              const index = row * 7 + col;
              const list = byDay[index] ?? [];
              const outside = day.getMonth() !== month;
              const weekend = day.getDay() === 0 || day.getDay() === 6;
              const holiday = holidayOn(day, lang);
              const classes = ["cal-day"];
              if (outside) classes.push("outside");
              if (weekend) classes.push("weekend");
              if (holiday && !outside) classes.push("holiday");
              if (sameDay(day, today)) classes.push("today");
              if (sameDay(day, anchor)) classes.push("selected");
              const colors = Array.from(new Set(list.map((e) => e.color ?? "currentColor"))).slice(0, 3);
              return (
                <button
                  key={index}
                  type="button"
                  className={classes.join(" ")}
                  onClick={() => onPick(day)}
                  title={holiday ?? undefined}
                  aria-current={sameDay(day, today) ? "date" : undefined}
                >
                  <span className="cal-num">{day.getDate()}</span>
                  {colors.length > 0 && !outside && (
                    <span className="event-dots">
                      {colors.map((c) => (
                        <span key={c} className="event-dot" style={{ background: c }} />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthPicker({
  year,
  selected,
  onYear,
  onPick,
}: {
  year: number;
  selected: Date;
  onYear: (year: number) => void;
  onPick: (month: number) => void;
}) {
  const t = useT();
  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(year, i, 1).toLocaleDateString(dateLocale(), { month: "short" })
  );
  return (
    <div className="cal-picker">
      <div className="cal-picker-months" role="listbox" aria-label={t("calendar.pickMonth")}>
        {months.map((label, i) => (
          <button
            key={label + i}
            type="button"
            role="option"
            aria-selected={selected.getFullYear() === year && selected.getMonth() === i}
            className={selected.getFullYear() === year && selected.getMonth() === i ? "active" : ""}
            onClick={() => onPick(i)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="cal-picker-year">
        <button type="button" onClick={() => onYear(year - 1)} aria-label={t("calendar.previous")}>
          &#8249;
        </button>
        <span>{year}</span>
        <button type="button" onClick={() => onYear(year + 1)} aria-label={t("calendar.next")}>
          &#8250;
        </button>
      </div>
    </div>
  );
}

interface TimeProps {
  time: (ms: number) => string;
}

function SelectedDay({ day, events, time, onOpen }: TimeProps & { day: Date; events: CalEvent[]; onOpen: () => void }) {
  const t = useT();
  const list = eventsOn(events, day);
  const label = day.toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric" });
  return (
    <div className="calendar-agenda">
      <button className="agenda-title" onClick={onOpen}>
        {label}
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2.5 1l3 3-3 3" />
        </svg>
      </button>
      {list.length === 0 && <div className="agenda-empty">{t("calendar.noEvents")}</div>}
      {list.slice(0, 3).map((e, i) => (
        <div key={`${e.uid}-${e.start}-${i}`} className="agenda-item" style={colorVar(e)} title={e.location ? `${e.title} · ${e.location}` : e.title}>
          <span className="agenda-dot" />
          <span className="agenda-time">{e.allDay ? t("calendar.allDay") : time(e.start)}</span>
          <span className="agenda-name">{e.title}</span>
        </div>
      ))}
      {list.length > 3 && (
        <button className="agenda-more" onClick={onOpen}>
          {t("calendar.more", { count: list.length - 3 })}
        </button>
      )}
    </div>
  );
}

function Chip({ event, time }: TimeProps & { event: CalEvent }) {
  const t = useT();
  return (
    <span className="cal-chip" style={colorVar(event)} title={event.location ? `${event.title} · ${event.location}` : event.title}>
      <i>{event.allDay ? t("calendar.allDay") : time(event.start)}</i>
      <span>{event.title}</span>
    </span>
  );
}

function WeekList({ anchor, today, events, time, onOpen }: TimeProps & { anchor: Date; today: Date; events: CalEvent[]; onOpen: (d: Date) => void }) {
  const t = useT();
  const first = addDays(anchor, -((anchor.getDay() - weekStartsOn() + 7) % 7));
  return (
    <div className="cal-scroll">
      {Array.from({ length: 7 }, (_, i) => {
        const day = addDays(first, i);
        const list = eventsOn(events, day);
        return (
          <button key={i} className={`cal-week-row${sameDay(day, today) ? " today" : ""}`} onClick={() => onOpen(day)}>
            <span className="cal-week-label">
              <em>{day.toLocaleDateString(dateLocale(), { weekday: "short" })}</em>
              <b>{day.getDate()}</b>
            </span>
            <span className="cal-week-events">
              {list.length === 0 && <span className="cal-none">{t("calendar.free")}</span>}
              {list.slice(0, 2).map((e, k) => (
                <Chip key={`${e.uid}-${e.start}-${k}`} event={e} time={time} />
              ))}
              {list.length > 2 && <span className="cal-more">{t("calendar.more", { count: list.length - 2 })}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DayList({ day, events, time }: TimeProps & { day: Date; events: CalEvent[] }) {
  const t = useT();
  const list = eventsOn(events, day);
  const [nowMs] = useState(() => Date.now());
  if (list.length === 0) {
    return <div className="cal-empty">{t("calendar.nothingPlanned")}</div>;
  }
  return (
    <div className="cal-scroll">
      {list.map((e, i) => {
        const live = !e.allDay && e.start <= nowMs && e.end > nowMs;
        return (
          <div key={`${e.uid}-${e.start}-${i}`} className="cal-day-event" style={colorVar(e)}>
            <span className="cal-day-time">
              {e.allDay ? (
                <b>{t("calendar.allDay")}</b>
              ) : (
                <>
                  <b>{time(e.start)}</b>
                  <span>{time(e.end)}</span>
                </>
              )}
            </span>
            <span className="cal-day-body">
              <span className="cal-day-title">
                {e.title}
                {live && <em>{t("calendar.now")}</em>}
              </span>
              <span className="cal-day-meta">{[e.location, e.calendar].filter(Boolean).join(" · ")}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function AgendaList({ today, events, time, onOpen }: TimeProps & { today: Date; events: CalEvent[]; onOpen: (d: Date) => void }) {
  const t = useT();
  const groups = Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(today, i))
    .map((day) => ({ day, list: eventsOn(events, day) }))
    .filter((g) => g.list.length > 0);

  if (groups.length === 0) {
    return <div className="cal-empty">{t("calendar.agenda.empty", { days: AGENDA_DAYS })}</div>;
  }

  const heading = (day: Date) => {
    const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
    if (diff === 0) return t("calendar.today");
    if (diff === 1) return t("calendar.tomorrow");
    return day.toLocaleDateString(dateLocale(), { weekday: "short", month: "short", day: "numeric" });
  };

  return (
    <div className="cal-scroll">
      {groups.map(({ day, list }) => (
        <div key={day.getTime()} className="cal-agenda-group">
          <button className="cal-agenda-heading" onClick={() => onOpen(day)}>
            {heading(day)}
          </button>
          {list.map((e, i) => (
            <Chip key={`${e.uid}-${e.start}-${i}`} event={e} time={time} />
          ))}
        </div>
      ))}
    </div>
  );
}
