/**
 * Australia/Melbourne dates and times. The Worker runs in UTC wherever Cloudflare places it, and
 * Victoria changes offset twice a year, so every calendar date comes from Intl — never from an array
 * index, toISOString() or a fixed +10 h. Names come from our own tables (en-AU Intl says "Sept").
 */
import type { LocalDate } from "./types.js";

export const TZ = "Australia/Melbourne";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

export function localParts(ms: number): LocalParts {
  const p = fmt.formatToParts(new Date(ms));
  const v = (t: Intl.DateTimeFormatPartTypes) => Number(p.find((x) => x.type === t)?.value ?? NaN);
  return { y: v("year"), m: v("month"), d: v("day"), hh: v("hour") % 24, mm: v("minute") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The Melbourne calendar date of an instant: "2026-09-27". */
export function localDate(ms: number): LocalDate {
  const p = localParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Calendar arithmetic on a local date (no time zone involved). */
export function addDays(date: LocalDate, n: number): LocalDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** "27/09/2026" → "2026-09-27"; anything else → null. */
export function fromDMY(s: unknown): LocalDate | null {
  if (typeof s !== "string") return null;
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(s);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** "Sunday, 27 September 2026" (CFA RSS item titles) → "2026-09-27"; anything else → null. */
export function fromLongDate(s: unknown): LocalDate | null {
  if (typeof s !== "string") return null;
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(s);
  if (!m) return null;
  const mo = MON.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase());
  if (mo < 0) return null;
  return `${m[3]}-${pad(mo + 1)}-${pad(Number(m[1]))}`;
}

// Beyond Date's ±8.64e15 ms, formatting throws; outside 2000–2100 a feed time is an error (or
// seconds read as ms), and one bad field must not take the whole screen down.
const DATE_MAX_MS = 8.64e15;
const T_MIN = Date.UTC(2000, 0, 1);
const T_MAX = Date.UTC(2101, 0, 1);
const plausible = (t: number): boolean => Number.isFinite(t) && Math.abs(t) <= DATE_MAX_MS && t >= T_MIN && t < T_MAX;

/**
 * Parses the timestamp formats the feeds use: "…Z", "…+10:00", "…-00:00", 7-digit fractions,
 * and BoM's "2026-09-27T05:44:00+10:00". Returns epoch ms, or null for anything unparseable or
 * outside the years 2000–2100.
 */
export function parseTime(s: unknown): number | null {
  if (typeof s === "number") return plausible(s) ? s : null;
  if (typeof s !== "string" || !s.trim()) return null;
  // V8 accepts up to 3 fractional digits reliably; trim longer fractions.
  const norm = s.trim().replace(/(\.\d{3})\d+/, "$1");
  const t = Date.parse(norm);
  return plausible(t) ? t : null;
}

/** "16:05" */
export function fmtTime(ms: number): string {
  const p = localParts(ms);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

function dow(date: LocalDate): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/** "Sun 27 Sep" */
export function fmtDay(date: LocalDate): string {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${dow(date)} ${d} ${MON[m - 1]}`;
}

/** "Sun 16:05" — the weekday makes a screen frozen since yesterday obvious. */
export function fmtWeekdayTime(ms: number): string {
  return `${dow(localDate(ms))} ${fmtTime(ms)}`;
}

/** Weekday of a local date, "Sun". */
export function fmtDow(date: LocalDate): string {
  return dow(date);
}

/** "3 min", "2 h", "3 d". */
export function ageText(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
