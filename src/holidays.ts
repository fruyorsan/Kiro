import { t } from "./i18n";

/**
 * Days the notch calendar marks as holidays.
 *
 * Turkish civil holidays are fixed dates; the two religious feasts follow the
 * lunar year, so they come from a table instead of a calculation (the table is
 * easier to audit and needs no moon arithmetic at runtime). Other languages get
 * the one holiday every calendar agrees on, New Year's Day.
 */

const TR_FIXED: Record<string, string> = {
  "01-01": "Yeni Yıl",
  "04-23": "Ulusal Egemenlik ve Çocuk Bayramı",
  "05-01": "Emek ve Dayanışma Günü",
  "05-19": "Atatürk'ü Anma, Gençlik ve Spor Bayramı",
  "07-15": "Demokrasi ve Millî Birlik Günü",
  "08-30": "Zafer Bayramı",
  "10-29": "Cumhuriyet Bayramı",
};

// [Ramazan Bayramı (first day, days), Kurban Bayramı (first day, days)]
const TR_ISLAMIC: Record<number, { ramazan: [string, number]; kurban: [string, number] }> = {
  2024: { ramazan: ["04-10", 3], kurban: ["06-16", 4] },
  2025: { ramazan: ["03-30", 3], kurban: ["06-06", 4] },
  2026: { ramazan: ["03-20", 3], kurban: ["05-27", 4] },
  2027: { ramazan: ["03-09", 3], kurban: ["05-16", 4] },
  2028: { ramazan: ["02-26", 3], kurban: ["05-05", 4] },
  2029: { ramazan: ["02-14", 3], kurban: ["04-24", 4] },
  2030: { ramazan: ["02-04", 3], kurban: ["04-13", 4] },
};

const pad = (n: number) => String(n).padStart(2, "0");

function within(startMd: string, days: number, month: number, date: number): boolean {
  const [m, d] = startMd.split("-").map(Number);
  // Only compare inside one year: the feasts never straddle December/January.
  const start = m * 31 + d;
  const day = month * 31 + date;
  return day >= start && day < start + days;
}

/** Holiday name for a day, or null. `lang` is the UI language code. */
export function holidayOn(day: Date, lang: string): string | null {
  const month = day.getMonth() + 1;
  const date = day.getDate();
  const md = `${pad(month)}-${pad(date)}`;

  if (lang === "tr") {
    const fixed = TR_FIXED[md];
    if (fixed) return fixed;
    const feasts = TR_ISLAMIC[day.getFullYear()];
    if (feasts) {
      if (within(feasts.ramazan[0], feasts.ramazan[1], month, date)) return "Ramazan Bayramı";
      if (within(feasts.kurban[0], feasts.kurban[1], month, date)) return "Kurban Bayramı";
    }
    return null;
  }

  if (md === "01-01") return t("calendar.holiday.newYear");
  return null;
}

/** ISO-8601 week number (weeks start on Monday, week 1 holds January 4th). */
export function isoWeek(day: Date): number {
  const d = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** How many days of the year have passed, counting `day` itself. */
export function dayOfYear(day: Date): number {
  const start = Date.UTC(day.getFullYear(), 0, 1);
  const current = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
  return Math.round((current - start) / 86_400_000) + 1;
}

export function daysInYear(year: number): number {
  return new Date(year, 1, 29).getMonth() === 1 ? 366 : 365;
}
