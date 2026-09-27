/**
 * Hourly model weather → the Today / Tomorrow columns: per-day aggregates, two model indicators
 * (wind change, hot/dry/windy) and recent rain. Hours are grouped by Melbourne calendar date via
 * Intl, never by Open-Meteo's own days, whose single fixed offset puts the wrong hours into 4 Oct.
 *
 * A day's aggregate is only as good as its worst hour: if any hour lacks a value the aggregate is
 * null, because a max over the morning alone would understate the afternoon (a reassuring error).
 * Nothing here turns missing data into 0.
 */
import { angDiff, compass16 } from "./geo.js";
import { addDays, fmtDow, fmtTime, localDate, localParts } from "./time.js";
import type { Day, FireWx, LocalDate, Weather, WxHour } from "./types.js";

export interface WxDay {
  date: LocalDate;
  /** Hours of data for that Melbourne date (23 or 25 on DST change days). */
  hours: number;
  /** First local hour covered: 0 when the day starts at midnight. */
  fromHour: number | null;
  /** Last local hour covered: 23 when the day runs to midnight. */
  toHour: number | null;
  tmax: number | null;
  tmin: number | null;
  rhMin: number | null;
  /** epoch ms of the RH minimum */
  rhMinAt: number | null;
  wspdMax: number | null;
  gustMax: number | null;
  /** Wind-FROM direction (deg) at the hour of the highest mean wind speed. */
  dirAtPeak: number | null;
  popMax: number | null;
  precipSum: number | null;
  /** Model wind-change indicator; `toDeg` is the post-change wind-FROM direction. */
  change: { at: number; fromDir: string; toDir: string; speed: number; toDeg: number } | null;
  /** Some hour with temp ≥ 30 °C, RH ≤ 30 % and wind ≥ 30 km/h (model indicator). */
  hotDryWindy: boolean;
}

const HOUR = 3_600_000;

type NumKey = Exclude<keyof WxHour, "t">;

/** Grouping calls Intl per hour, so it is done once per hours array (parsed Weather is never mutated). */
const grouped = new WeakMap<WxHour[], { n: number; by: Map<LocalDate, WxHour[]> }>();

function byDate(hours: WxHour[]): Map<LocalDate, WxHour[]> {
  const hit = grouped.get(hours);
  if (hit && hit.n === hours.length) return hit.by;
  const by = new Map<LocalDate, WxHour[]>();
  for (const h of hours) {
    if (!Number.isFinite(h.t)) continue;
    const d = localDate(h.t);
    const list = by.get(d);
    if (list) list.push(h);
    else by.set(d, [h]);
  }
  for (const list of by.values()) list.sort((a, b) => a.t - b.t);
  grouped.set(hours, { n: hours.length, by });
  return by;
}

/** The first hour holding the largest (dir 1) or smallest (dir -1) value, or null if any hour lacks one. */
function peak(hours: WxHour[], k: NumKey, dir: 1 | -1): WxHour | null {
  let best: WxHour | null = null;
  for (const h of hours) {
    const v = h[k];
    if (v === null) return null;
    if (best === null || (v - (best[k] as number)) * dir > 0) best = h;
  }
  return best;
}

function sum(hours: WxHour[], k: NumKey): number | null {
  let s = 0;
  for (const h of hours) {
    const v = h[k];
    if (v === null) return null;
    s += v;
  }
  return hours.length ? s : null;
}

export function dayWeather(w: Weather, date: LocalDate): WxDay | null {
  const hs = byDate(w.hours).get(date);
  if (!hs?.length) return null;
  const first = hs[0]!, last = hs[hs.length - 1]!;
  const tmax = peak(hs, "temp", 1), tmin = peak(hs, "temp", -1);
  const rh = peak(hs, "rh", -1), wind = peak(hs, "wspd", 1);
  const gust = peak(hs, "gust", 1), pop = peak(hs, "pop", 1);
  // Up to 3 h of the previous evening, so a change just after midnight still sees its pre-change wind.
  const context = w.hours.filter((h) => h.t >= first.t - 3 * HOUR && h.t <= last.t);
  return {
    date,
    hours: hs.length,
    fromHour: localParts(first.t).hh,
    toHour: localParts(last.t).hh,
    tmax: tmax?.temp ?? null,
    tmin: tmin?.temp ?? null,
    rhMin: rh?.rh ?? null,
    rhMinAt: rh?.t ?? null,
    wspdMax: wind?.wspd ?? null,
    gustMax: gust?.gust ?? null,
    dirAtPeak: wind?.wdir ?? null,
    popMax: pop?.pop ?? null,
    precipSum: sum(hs, "precip"),
    change: findChange(context, first.t),
    hotDryWindy: hs.some(
      (h) => h.temp !== null && h.rh !== null && h.wspd !== null && h.temp >= 30 && h.rh <= 30 && h.wspd >= 30,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Wind change (model). The dangerous Victorian pattern is a hot N–NW wind swinging to a strong
// W–SW–S change, which turns a fire's long flank into its head. Directions are wind-FROM.

/** N through W, NW and W included, with a half-sector margin either side. */
const PRE = (d: number) => d >= 247.5 || d < 22.5;
/** WSW through SSE. */
const POST = (d: number) => d >= 146.25 && d < 258.75;
const CHANGE_KMH = 15;
const CHANGE_DEG = 45;
const LOOKBACK = 3 * HOUR;

function findChange(hours: WxHour[], from: number): WxDay["change"] {
  const hs = hours.filter((h) => h.wdir !== null && Number.isFinite(h.t)).sort((a, b) => a.t - b.t);
  for (const b of hs) {
    const bd = b.wdir!;
    if (b.t < from || b.wspd === null || b.wspd < CHANGE_KMH || !POST(bd)) continue;
    let pre: WxHour | null = null;
    for (const a of hs) {
      if (a.t >= b.t) break;
      if (a.t >= b.t - LOOKBACK && PRE(a.wdir!) && angDiff(a.wdir!, bd) >= CHANGE_DEG) pre = a;
    }
    if (pre) return { at: b.t, fromDir: compass16(pre.wdir!), toDir: compass16(bd), speed: b.wspd, toDeg: bd };
  }
  return null;
}

/**
 * The first hour b blowing from WSW–SSE at ≥ 15 km/h that follows, within 3 h, an hour blowing from
 * N–W at least 45° away. The 45° test is what separates a NW→SW change from a W→WSW drift.
 */
export function windChange(hours: WxHour[]): WxDay["change"] {
  return findChange(hours, -Infinity);
}

// ---------------------------------------------------------------------------------------------
// Rain history

/** A day counts only with (nearly) all its hours; 23 allows the DST day and Open-Meteo's fixed-offset edges. */
function dayRain(w: Weather, date: LocalDate): number | null {
  const hs = byDate(w.hours).get(date);
  if (!hs || hs.length < 23) return null;
  return sum(hs, "precip");
}

/**
 * Rain over the 7 Melbourne days before `today`. sum7d is null if any of those days is incomplete;
 * lastWet is the most recent of them with ≥ 5 mm, scanning back only through complete days.
 */
export function rainHistory(w: Weather, today: LocalDate): { sum7d: number | null; lastWet: LocalDate | null } {
  let total: number | null = 0;
  let lastWet: LocalDate | null = null;
  let known = true;
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i);
    const mm = dayRain(w, d);
    if (mm === null) {
      total = null;
      known = false;
      continue;
    }
    if (total !== null) total += mm;
    if (known && lastWet === null && mm >= 5) lastWet = d;
  }
  return { sum7d: total, lastWet };
}

// ---------------------------------------------------------------------------------------------
// Upwind

/** Wind-FROM bearings that make an incident upwind: the peak-wind direction and any post-change direction. */
export function upwindFrom(day: WxDay | null): number[] {
  if (!day) return [];
  const out: number[] = [];
  if (day.dirAtPeak !== null) out.push(day.dirAtPeak);
  if (day.change) out.push(day.change.toDeg);
  return out;
}

/** An incident whose bearing from the house is within ±45° of a wind-from direction. */
export function isUpwind(bearingToIncident: number | null, from: number[]): boolean {
  if (bearingToIncident === null || !Number.isFinite(bearingToIncident)) return false;
  return from.some((d) => Number.isFinite(d) && angDiff(bearingToIncident, d) <= 45);
}

// ---------------------------------------------------------------------------------------------
// Strings for the payload (budgets from types.ts: temps 11, rh/wind/change/rain 18, text/src 28, src_short 23)

const DASH = "—";
const pad = (n: number) => String(n).padStart(2, "0");
const deg = (v: number) => `${Math.round(v)}°`;
/** 1 dp under 10 mm, whole mm above, so the rain line fits 18 characters. */
const mm = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));

/** First candidate within the budget; the last candidate is the short form that always fits. */
function fit(max: number, ...candidates: string[]): string {
  return candidates.find((c) => c.length <= max) ?? candidates[candidates.length - 1]!;
}

function tempsText(d: WxDay): string {
  if (d.tmax === null && d.tmin === null) return `Temp ${DASH}`;
  return fit(11, `${d.tmax === null ? DASH : deg(d.tmax)} / ${d.tmin === null ? DASH : deg(d.tmin)}`, d.tmax === null ? `Temp ${DASH}` : `${deg(d.tmax)} max`);
}

function rhText(d: WxDay): string {
  if (d.rhMin === null) return `RH min ${DASH}`;
  const base = `RH min ${Math.round(d.rhMin)}%`;
  return d.rhMinAt === null ? base : fit(18, `${base} @${fmtTime(d.rhMinAt)}`, base);
}

function windText(d: WxDay): string {
  if (d.wspdMax === null && d.gustMax === null) return `Wind ${DASH}`;
  const dir = d.dirAtPeak === null ? "Wind" : compass16(d.dirAtPeak);
  const spd = d.wspdMax === null ? DASH : String(Math.round(d.wspdMax));
  const gust = d.gustMax === null ? "" : ` G${Math.round(d.gustMax)}`;
  return fit(18, `${dir} ${spd}${gust} km/h`, `${dir} ${spd}${gust}`);
}

function rainText(d: WxDay): string {
  if (d.popMax === null && d.precipSum === null) return `Rain ${DASH}`;
  const pop = d.popMax === null ? DASH : `${Math.round(d.popMax)}%`;
  const amt = d.precipSum === null ? `${DASH} mm` : `${mm(d.precipSum)} mm`;
  return fit(18, `Rain ${pop} · ${amt}`, `Rain ${amt}`);
}

function rainHistoryText(r: { sum7d: number | null; lastWet: LocalDate | null }): string {
  if (r.sum7d === null) return "";
  const base = `7 days: ${mm(r.sum7d)} mm`;
  if (!r.lastWet) return base;
  const dom = Number(r.lastWet.slice(8, 10));
  return fit(28, `${base} · wet ${fmtDow(r.lastWet)} ${dom}`, base);
}

/** "from 15:00", "to 12:00" or "06:00–12:00" when the model covers only part of the day. */
function windowText(d: WxDay): string {
  const from = d.fromHour ?? 0, to = d.toHour ?? 23;
  if (from === 0 && to === 23) return "";
  if (to === 23) return `from ${pad(from)}:00`;
  if (from === 0) return `to ${pad(to)}:00`;
  return `${pad(from)}:00–${pad(to)}:00`;
}

/**
 * The model source line: the full form, and the short form a column shows under a rating note.
 * Both keep the coverage window and " · BoM"; neither ever loses the word "model".
 */
function srcText(d: WxDay, official: boolean): { src: string; src_short: string } {
  const win = windowText(d);
  const bom = official ? " · BoM" : "";
  const short = `Model${win ? ` ${win}` : ""}${bom}`;
  return { src: fit(28, `Open-Meteo model${win ? ` ${win}` : ""}${bom}`, short, `Model${bom}`), src_short: fit(23, short, `Model${bom}`) };
}

/**
 * The weather column for one day. The official IDV18560 wind-change danger flag (for this date)
 * outranks the model indicator; indicators appear only when positive, never as "no change". On
 * today's column a model change more than an hour past stays as text but loses its filled chip.
 */
export function wxStrings(
  day: WxDay | null,
  opts: {
    isToday: boolean;
    now: number;
    official?: FireWx | null;
    rain?: { sum7d: number | null; lastWet: LocalDate | null };
  },
): Day["wx"] {
  if (!day) return { ok: false };
  const agg = [day.tmax, day.tmin, day.rhMin, day.wspdMax, day.gustMax, day.popMax, day.precipSum];
  if (agg.every((v) => v === null)) return { ok: false };

  const official = opts.official && opts.official.date === day.date ? opts.official : null;
  let change = "";
  let change_flag = false;
  if (official?.wcdFlag === true) {
    change = "Wind change danger";
    change_flag = true;
  } else if (day.change) {
    change = fit(18, `${day.change.toDir} change ~${fmtTime(day.change.at)}`, `Change ~${fmtTime(day.change.at)}`);
    change_flag = !(opts.isToday && day.change.at < opts.now - HOUR);
  }

  const text = day.hotDryWindy ? "Hot, dry & windy (model)" : opts.rain ? rainHistoryText(opts.rain) : "";

  return {
    ok: true,
    temps: tempsText(day),
    rh: rhText(day),
    wind: windText(day),
    change,
    change_flag,
    rain: rainText(day),
    text,
    ...srcText(day, official !== null),
  };
}
