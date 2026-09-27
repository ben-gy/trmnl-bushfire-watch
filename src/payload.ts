/**
 * Builds the merge variables TRMNL renders. All judgement lives here, in one tested place, and the
 * template only maps states to ink:
 *  - a warning over the house outranks everything, and the rating is never hidden;
 *  - a source that can't be read is UNAVAILABLE, never 0 or "No Rating";
 *  - stale alarms may be shown ("LAST KNOWN"), stale all-clears may not;
 *  - every string is cut to the template's measured budget.
 */
import { clean } from "./classify.js";
import { districtName } from "./districts.js";
import type { Gathered } from "./gather.js";
import { compass16 } from "./geo.js";
import { buildNear, type FireCluster, type NearItem, type NearSummary } from "./near.js";
import { ALARM_KEEP_MS, buildRatings, CHECK, neighbourLine, RATING_UNAVAILABLE, type RatingInputs, TFB_UNAVAILABLE } from "./ratings.js";
import { ratingsFromConditions } from "./sources/fdrtfb.js";
import { addDays, fmtDay, fmtTime, fmtWeekdayTime, localDate } from "./time.js";
import type { Count, Day, FireWx, House, Incidents, LocalDate, NormFeature, PayloadV1, RatingsFeed, Row, SourceResult } from "./types.js";
import { dayWeather, isUpwind, rainHistory, upwindFrom, wxStrings } from "./weather.js";

export const DISCLAIMER =
  "Not an official warning service. Use the VicEmergency app, emergency.vic.gov.au or Hotline 1800 226 226. If you see fire, call 000.";
const SOURCES = "Source: State of Victoria (CC BY 3.0 AU) · BoM · Open-Meteo (CC BY 4.0) · VicEmergency data received";

const MAX_ROWS = 5;
export const BUDGET_BYTES = 6144;

const LEVEL_WORD = ["COMMUNITY UPDATE", "ADVICE", "WATCH AND ACT", "EMERGENCY WARNING"] as const;

// ---------------------------------------------------------------------------------------------
// String helpers

/** Cuts at a word boundary and ends with "…" when longer than max. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s·,;:–-]+$/, "") + "…";
}

/** "Castella, Kinglake, Toolangi" → "Castella, Kinglake +1" within max. */
export function placeList(location: string, max: number): string {
  const parts = location
    .split(/\s*,\s*|\s+and\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return clip(location, max);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const rest = parts.length - i - 1;
    const next = out ? `${out}, ${parts[i]}` : parts[i]!;
    const suffix = rest > 0 ? ` +${rest}` : "";
    if ((next + suffix).length > max) {
      if (!out) return clip(parts[0]!, max - ` +${parts.length - 1}`.length) + ` +${parts.length - 1}`;
      return `${out} +${parts.length - i}`;
    }
    out = next;
  }
  return out;
}

/** "Not Yet Under Control" → "Not yet under control". */
function sentence(s: string): string {
  const t = s.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1).toLowerCase() : t;
}

/** The first candidate within max, else the last one clipped. */
function fitFirst(max: number, ...candidates: string[]): string {
  return candidates.find((c) => c.length <= max) ?? clip(candidates[candidates.length - 1]!, max);
}

/**
 * "What · where" in max characters without mangling either: drop optional parts before squeezing
 * the place list below a readable width.
 */
function describe(parts: string[], place: string, max: number): string {
  const MIN_PLACE = 14;
  const kept = parts.filter(Boolean);
  for (let n = kept.length; n >= 1; n--) {
    const head = `${kept.slice(0, n).join(" · ")} · `;
    if (max - head.length >= MIN_PLACE) return head + placeList(place, max - head.length);
  }
  const first = kept[0];
  if (!first) return placeList(place, max);
  const head = `${clip(first, max - MIN_PLACE - 3)} · `;
  return head + placeList(place, max - head.length);
}

/** Fire categories that say nothing on their own. */
const VAGUE = /^(other|fire|incident|unknown)?$/i;

function kmText(km: number, approx = false): string {
  const v = km < 10 ? km.toFixed(1) : String(Math.round(km));
  return `${approx ? "~" : ""}${v} km`;
}

function where(km: number, bearing: number | null, approx = false): string {
  return bearing === null ? kmText(km, approx) : `${kmText(km, approx)} ${compass16(bearing)}`;
}

const nstr = (n: number): string => (n > 99 ? "99+" : String(n));

function levelWord(item: NearItem): string {
  return featureLevelWord(item.f);
}

function featureLevelWord(f: NormFeature): string {
  const w = f.levelRaw ? f.levelRaw.toUpperCase() : LEVEL_WORD[f.level ?? 1];
  return clip(w, 17);
}

const featureRank = (f: NormFeature): number => (f.levelRaw ? Math.max(f.level ?? 2, 2.5) : (f.level ?? 1));
const rankOf = (item: NearItem): number => featureRank(item.f);

/** A throw in one section of the screen costs only that section. */
function attempt<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------
// Pieces

function usableAt(s: SourceResult<unknown>, now: number, keepMs: number): boolean {
  if (!s.data) return false;
  if (s.state !== "unavailable") return true;
  return s.asOf !== null && now - s.asOf <= keepMs;
}

/**
 * The events feed's conditions as a ratings source. A copy the store calls unavailable but that is
 * still inside the alarm window counts as stale, like the house warning from the same copy: its
 * Extreme+ ratings and bans stay, labelled, and nothing calmer is taken from it.
 */
function conditionsResult(g: Gathered): SourceResult<RatingsFeed> {
  const e = g.events;
  const state = e.state === "unavailable" && usableAt(e, g.now, ALARM_KEEP_MS) ? "stale" : e.state;
  return { id: "events", state, data: e.data ? ratingsFromConditions(e.data.conditions) : null, asOf: e.asOf, fetchedAt: e.fetchedAt, error: e.error };
}

function house(near: NearSummary | null, alarmOnly: boolean, eventsAsOf: number | null): House {
  if (!near) return { status: "unknown" };
  const hw = near.houseWarnings;
  if (!hw.length) {
    // A Watch and Act or worse that can't be placed could be over the house: never call that clear.
    if (alarmOnly || near.unlocatedWarningList.some((f) => featureRank(f) >= 2)) return { status: "unknown" };
    return { status: "clear" };
  }
  const w = hw[0]!;
  const f = w.f;
  const event = clean(f.event || f.cat2 || "Warning", 40).toUpperCase();
  const kicker = f.statewide
    ? clip(`STATEWIDE WARNING · ${event}`, 36)
    : fitFirst(36, `YOU ARE IN A WARNING AREA · ${event}`, `IN A WARNING AREA · ${event}`, `IN WARNING AREA · ${event}`);
  const action = clean(f.action, 60).toUpperCase();
  const place = f.statewide ? "Victoria" : clean(f.location, 200);
  const t = f.updated ?? f.created;
  const issued = alarmOnly
    ? `LAST KNOWN ${eventsAsOf !== null ? fmtTime(eventsAsOf) : "—"}`
    : `${t !== null ? `Issued ${fmtTime(t)}` : "Issued —"}${hw.length > 1 ? ` · +${hw.length - 1} more` : ""}`;
  return {
    status: "in_warning",
    rank: f.levelRaw ? 3 : ((f.level ?? 2) as 0 | 1 | 2 | 3),
    kicker,
    level: levelWord(w),
    // The official action is the instruction; it is kept whole even when that leaves no room for places.
    action: action && action.length + 3 + 14 > 48 ? clip(action, 48) : describe([action], place, 48),
    issued: clip(issued, 24),
  };
}

interface Candidate {
  order: number;
  row: Row;
}

function warningRow(w: NearItem, windFrom: number[]): Candidate {
  const lvl = levelWord(w);
  const up = !w.inArea && isUpwind(w.bearing, windFrom);
  const line1 = w.inArea ? `IN AREA · ${lvl}` : `${where(w.km, w.bearing, w.approx)} · ${lvl}`;
  const f = w.f;
  const line2 = describe([f.action ? sentence(clean(f.action, 48)) : "", clean(f.event || f.cat2, 30)], f.statewide ? "Victoria" : clean(f.location, 200), 56);
  const rank = rankOf(w);
  const sev: Row["sev"] = w.inArea || rank >= 2 ? 3 : 2;
  const order = w.inArea ? 0 : rank >= 2 ? 1 : 3;
  return {
    order: order * 1000 + (w.inArea ? 0 : w.km),
    row: { kind: "warning", sev, line1: clip(line1, up ? 32 : 38), line2, upwind: up },
  };
}

function fireRow(c: FireCluster, windFrom: number[], radiusKm: number): Candidate {
  const ctrl = c.bucket === "controlled";
  const up = !ctrl && c.km <= radiusKm && isUpwind(c.bearing, windFrom);
  const cat2 = clean(c.lead.cat2, 30);
  const what = VAGUE.test(cat2) ? (c.veg ? "Vegetation fire" : "Fire call") : sentence(cat2);
  const count = c.count > 1 ? ` ×${c.count}` : "";
  const line1 = `${where(c.km, c.bearing)} · ${what}${count}`;
  const agencies = c.agencies.length > 1 ? ` (${c.agencies.join("+")})` : "";
  const line2 = `${sentence(c.status || "Status unknown")} · ${clean(c.lead.location, 120)}${agencies}`;
  const sev: Row["sev"] = ctrl ? 1 : c.rank >= 3 ? 3 : 2;
  // As near.fires: going first, then vegetation, then distance; all below 2900 (nearest beyond) and 3000 (met, Advice).
  const order = ctrl ? 4000 + (c.veg ? 0 : 500) + Math.min(c.km, 499) : 2000 + (c.rank >= 3 ? 0 : 400) + (c.veg ? 0 : 200) + Math.min(c.km, 199);
  return { order, row: { kind: ctrl ? "fire_ctrl" : "fire", sev, line1: clip(line1, up ? 32 : 38), line2: clip(line2, 56), upwind: up } };
}

function burnRow(b: NearItem): Candidate {
  const line2 = `${sentence(b.f.status || "Status unknown")} · ${clean(b.f.location, 120)}`;
  return { order: 5000 + b.km, row: { kind: "burn", sev: 1, line1: clip(`${where(b.km, b.bearing)} · Planned burn`, 38), line2: clip(line2, 56), upwind: false } };
}

/** Warnings with no usable location, as one row near the top: the most severe, and how many. */
function unlocatedRow(list: NormFeature[]): Candidate | null {
  const f = list[0];
  if (!f) return null;
  const lvl = featureLevelWord(f);
  const n = list.length - 1;
  const line1 = n > 0 ? fitFirst(38, `${lvl} · location unknown +${n}`, `${lvl} · no location +${n}`) : `${lvl} · location unknown`;
  const line2 = describe([f.action ? sentence(clean(f.action, 48)) : "", clean(f.event || f.cat2, 30)], clean(f.location, 200), 56);
  return { order: 500, row: { kind: "warning", sev: featureRank(f) >= 2 ? 3 : 2, line1: clip(line1, 38), line2, upwind: false } };
}

/**
 * The panel when the feed can't be used. `near` is the alarm-only copy's summary, if any: a Watch and
 * Act or worse in it that can't be placed may be over the house, so it is named rather than dropped.
 */
function incidentsUnavailable(g: Gathered, near: NearSummary | null = null): Incidents {
  const heading = `WITHIN ${g.radiusKm} KM`;
  const asOf = g.events.asOf;
  const since = asOf !== null ? attempt(() => ` since ${fmtWeekdayTime(asOf)}`, "") : "";
  const f = near?.unlocatedWarningList[0];
  const at = asOf !== null ? attempt(() => fmtTime(asOf), "—") : "—";
  const lastKnown =
    f && featureRank(f) >= 2
      ? attempt(() => {
          const head = `Last known ${at}: ${featureLevelWord(f)} · location unknown`;
          const place = clean(f.location, 200);
          return place ? describe([head], place, 80) : clip(head, 80);
        }, "")
      : "";
  return {
    ok: false,
    stale: false,
    heading,
    as_at: asOf !== null ? attempt(() => clip(`last received ${fmtTime(asOf)}`, 24), "") : "",
    error_text: lastKnown || clip(`The VicEmergency feed could not be read${since}.`, 80),
  };
}

function incidents(g: Gathered, near: NearSummary | null, alarmOnly: boolean, upwind: number[]): Incidents {
  const heading = `WITHIN ${g.radiusKm} KM`;
  const e = g.events;
  if (!near || alarmOnly) return incidentsUnavailable(g, near);
  const stale = e.state === "stale";
  // Every warning listed counts: a statewide one over the house (Watch and Act or above) and one that
  // can't be placed (it may be within the radius), so the cell never says 0 beside it.
  const warnings = near.houseWarnings.length + near.nearbyWarnings.length + near.unlocatedWarningList.length;
  const going = near.fires.filter((c) => c.bucket === "active").length;
  const controlled = near.fires.filter((c) => c.bucket === "controlled").length;
  const counts: [Count, Count, Count, Count, Count] = [
    { n: nstr(warnings), label: "warnings", short: "warn", hot: warnings > 0 },
    { n: nstr(going), label: "going", short: "going", hot: going > 0 },
    { n: nstr(controlled), label: "controlled", short: "ctrl" },
    { n: nstr(near.burns.length), label: "burns", short: "burns" },
    { n: nstr(near.otherCfa), label: "other CFA", short: "other" },
  ];

  const cands: Candidate[] = [
    ...near.houseWarnings.map((w) => warningRow(w, upwind)),
    ...near.nearbyWarnings.map((w) => warningRow(w, upwind)),
    ...near.met.map((m) => ({
      order: 3000,
      row: { kind: "warning", sev: 2, line1: "IN AREA · BOM WARNING", line2: clip(clean(m.f.event || m.f.cat2 || "Weather warning", 80), 56), upwind: false } as Row,
    })),
    ...near.fires.map((c) => fireRow(c, upwind, g.radiusKm)),
    ...near.burns.map(burnRow),
  ];
  const unplaced = unlocatedRow(near.unlocatedWarningList);
  if (unplaced) cands.push(unplaced);
  const lost = near.unlocated + near.unclassified;
  if (lost > 0) {
    cands.push({
      order: 1500,
      row: { kind: "other", sev: 2, line1: clip(`${lost} item${lost === 1 ? "" : "s"} not placed on the map`, 38), line2: "Check the VicEmergency map for anything near you", upwind: false },
    });
  }
  // "0 going" must not read as nothing around: the nearest active fire beyond the radius gets a row
  // whenever anything else is listed (alone, it goes in the empty text below).
  const n = near.nearestActiveBeyond;
  if (going === 0 && n && (cands.length > 0 || stale)) {
    cands.push({
      order: 2900,
      row: {
        kind: "fire",
        sev: 2,
        line1: clip(`${where(n.km, n.bearing)} · nearest active fire`, 38),
        line2: clip(`${sentence(n.status || "Status unknown")} · ${clean(n.where, 120)}`, 56),
        upwind: false,
      },
    });
  }
  cands.sort((a, b) => a.order - b.order);
  const rows = cands.slice(0, MAX_ROWS).map((c) => c.row);
  const more = Math.max(0, cands.length - rows.length);
  const as_at = asAtText(stale, e.asOf, more, near.safeFires);

  const out: Incidents = { ok: true, stale, heading, as_at, counts, rows, more };
  if (!rows.length && !stale) {
    const beyond = n ? ` · nearest active fire ${where(n.km, n.bearing)}` : "";
    out.empty_text = clip(`No warnings, fires or burns within ${g.radiusKm} km${beyond}`, 80);
  }
  return out;
}

/**
 * "as at 16:59 · +2 more · +3 safe" or "OLD DATA · 16:40 · +2 more", within 24. Hidden rows matter
 * more than safe fires, so "+N safe" is the first thing to go and "+N more" always stays.
 */
function asAtText(stale: boolean, asOf: number | null, more: number, safe: number): string {
  const t = asOf !== null ? fmtTime(asOf) : "—";
  const morePart = more ? ` · +${more} more` : "";
  const safePart = safe ? ` · +${safe} safe` : "";
  if (stale) {
    const old = `OLD DATA · ${t}`;
    return more
      ? fitFirst(24, `${old}${morePart}${safePart}`, `${old}${morePart}`, `OLD DATA ${t} +${more} more`)
      : fitFirst(24, `${old}${safePart}`, `${old} +${safe} safe`, old);
  }
  if (!safe) return clip(`as at ${t}${morePart}`, 24);
  return more
    ? fitFirst(24, `as at ${t}${morePart}${safePart}`, `${t}${morePart}${safePart}`, `${t} · +${more} more +${safe} safe`, `as at ${t}${morePart}`)
    : fitFirst(24, `as at ${t}${safePart}`, `${t}${safePart}`, `as at ${t}`);
}

function officialFor(g: Gathered, date: LocalDate): FireWx | null {
  const fw = g.bomFw.state !== "unavailable" ? g.bomFw.data : null;
  if (!fw) return null;
  const lga = g.district.lookup.lga;
  const key = g.district.lookup.key;
  const pick = (list: FireWx[] | undefined) => list?.find((x) => x.date === date) ?? null;
  return (lga ? pick(fw.subarea[lga]) : null) ?? (key ? pick(fw.district[key]) : null);
}

/**
 * The one neighbour worth the line: an alarm (Extreme or above, or a ban) before anything else, then
 * the higher rating, and on a tie the one under a ban. Earlier in Vicmap's order wins a full tie.
 */
function neighboursText(g: Gathered, i: RatingInputs): string {
  let best = "";
  let bestScore = -Infinity;
  for (const k of g.district.lookup.neighbours) {
    const [d] = buildRatings({ ...i, district: k, areaStatuses: [] });
    const ban = d.tfb.state === "declared";
    const score = (d.fdr.level >= 3 || ban ? 100 : 0) + d.fdr.level * 2 + (ban ? 1 : 0);
    const line = neighbourLine(k, i.dates[0], i);
    if (line && score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return best;
}

function statewideText(near: NearSummary | null): string {
  if (!near) return "";
  const listed = near.statewide.filter((w) => rankOf(w) < 2);
  if (!listed.length) return "";
  const names = listed.map((w) => `${clean(w.f.event || w.f.cat2 || "Warning", 30)} (${sentence(levelWord(w))})`);
  let out = `Statewide: ${names[0]}`;
  for (let i = 1; i < names.length; i++) {
    const next = `${out} · ${names[i]}`;
    const suffix = i < names.length - 1 ? ` +${names.length - i - 1}` : "";
    if ((next + suffix).length > 56) return clip(`${out} +${names.length - i}`, 56);
    out = next;
  }
  return clip(out, 56);
}

// ---------------------------------------------------------------------------------------------

const UNRATED: { fdr: Day["fdr"]; tfb: Day["tfb"] } = {
  fdr: { level: -1, word: RATING_UNAVAILABLE, action: CHECK, issued: "" },
  tfb: { state: "unknown", text: TFB_UNAVAILABLE },
};
const NO_WX: Day["wx"] = { ok: false };

function isToday(f: NormFeature, today: LocalDate): boolean {
  const t = f.created ?? f.updated;
  return t !== null && localDate(t) === today;
}

export interface BuildOptions {
  sample?: boolean;
  /** Byte budget (default BUDGET_BYTES), for tests. */
  budgetBytes?: number;
}

export function buildPayload(g: Gathered, opts: BuildOptions = {}): PayloadV1 {
  const now = g.now;
  const today = localDate(now);
  const tomorrow = addDays(today, 1);

  // Each section below is contained: a bad cached copy or an odd value costs only its own part of
  // the screen, never the ratings, and never looks like good news.
  const eventsOk = g.events.state !== "unavailable" && g.events.data !== null;
  const alarmOnly = !eventsOk && usableAt(g.events, now, ALARM_KEEP_MS);
  let near = attempt(() => (g.events.data && (eventsOk || alarmOnly) ? buildNear(g.events.data, g.home, g.radiusKm, now) : null), null);

  const ratingInputs: RatingInputs = {
    dates: [today, tomorrow],
    now,
    district: g.district.lookup.key,
    osom: g.osom,
    conditions: attempt(() => conditionsResult(g), { ...g.events, data: null }),
    cfa: g.cfa,
    bomFdr: g.bomFdr,
    // Area products describe the day they were issued for, and an alarm-only copy may be yesterday's.
    areaStatuses: attempt(() => (near && eventsOk ? near.areaProducts.filter((a) => isToday(a.f, today)).map((a) => a.f.status) : []), []),
  };
  const unrated = () => ({ fdr: { ...UNRATED.fdr }, tfb: { ...UNRATED.tfb } });
  const ratings = attempt<ReturnType<typeof buildRatings>>(() => buildRatings(ratingInputs), [unrated(), unrated()]);

  const wxDays = attempt(
    () => {
      const wx = g.weather.state !== "unavailable" ? g.weather.data : null;
      const wxToday = wx ? dayWeather(wx, today) : null;
      const wxTomorrow = wx ? dayWeather(wx, tomorrow) : null;
      return {
        upwind: upwindFrom(wxToday),
        today: wxStrings(wxToday, { isToday: true, now, official: officialFor(g, today), rain: wx ? rainHistory(wx, today) : undefined }),
        tomorrow: wxStrings(wxTomorrow, { isToday: false, now, official: officialFor(g, tomorrow) }),
      };
    },
    { upwind: [] as number[], today: NO_WX, tomorrow: NO_WX },
  );

  const label = (n: 0 | 1, date: LocalDate) => {
    const d = fmtDay(date).toUpperCase(); // "SUN 27 SEP"
    return n === 0 ? `TODAY · ${d}` : `TOMORROW · ${d.replace(/ [A-Z]{3}$/, "")}`;
  };
  const days: [Day, Day] = [
    { label: label(0, today), fdr: ratings[0].fdr, tfb: ratings[0].tfb, wx: wxDays.today },
    { label: label(1, tomorrow), fdr: ratings[1].fdr, tfb: ratings[1].tfb, wx: wxDays.tomorrow },
  ];

  let h: House;
  let inc: Incidents;
  let statewide: string;
  try {
    h = house(near, alarmOnly, g.events.asOf);
    inc = incidents(g, near, alarmOnly, wxDays.upwind);
    statewide = statewideText(near);
  } catch {
    near = null;
    h = { status: "unknown" };
    inc = incidentsUnavailable(g);
    statewide = "";
  }
  const eventsAsOf = g.events.asOf;
  const received = eventsAsOf !== null ? attempt(() => fmtWeekdayTime(eventsAsOf), "unknown") : "unknown";
  const key = g.district.lookup.key;

  const p: PayloadV1 = {
    v: 1,
    ok: true,
    ...(opts.sample ? { sample: true } : {}),
    generated_epoch: Math.floor(now / 60_000) * 60,
    checked_local: fmtWeekdayTime(now),
    feed_received_local: received,
    district: key ? districtName(key) : "District unknown",
    radius_km: g.radiusKm,
    neighbours: attempt(() => neighboursText(g, ratingInputs), ""),
    statewide,
    house: h,
    days,
    incidents: inc,
    attribution: `${SOURCES} ${received}`,
    disclaimer: DISCLAIMER,
  };

  // Nothing usable and nothing alarming known: say so across the whole screen rather than show a
  // hollow dashboard. A known ban, tomorrow's Extreme, a warning over the house or one that can't be
  // placed (named in the panel) keeps the normal layout, whose UNAVAILABLE marks say what is missing.
  const unplacedAlarm = alarmOnly && near !== null && near.unlocatedWarningList.some((f) => featureRank(f) >= 2);
  const alarm =
    days[0].tfb.state === "declared" || days[1].fdr.level >= 3 || days[1].tfb.state === "declared" || h.status === "in_warning" || unplacedAlarm;
  if (days[0].fdr.level < 0 && !inc.ok && !alarm) {
    return downPayload(now, {
      title: "DATA UNAVAILABLE",
      reason: "Fire danger ratings and warnings could not be loaded.",
      lastGood: g.events.asOf,
      sample: opts.sample,
      received,
    });
  }
  const safe = near?.safeFires ?? 0;
  return fitBudget(p, (more) => asAtText(inc.stale, g.events.asOf, more, safe), opts.budgetBytes ?? BUDGET_BYTES);
}

/**
 * A backstop: strings and rows are capped, so only a feed of long non-ASCII text could reach the
 * byte budget. Drops the least important rows first, and as_at says how many are hidden.
 */
function fitBudget(p: PayloadV1, asAt: (more: number) => string, budget: number): PayloadV1 {
  const size = () => new TextEncoder().encode(JSON.stringify(p)).byteLength;
  const inc = p.incidents;
  const rows = inc.rows;
  while (rows && rows.length > 1 && size() > budget) {
    rows.pop();
    inc.more = (inc.more ?? 0) + 1;
    inc.as_at = asAt(inc.more);
  }
  return p;
}

/** A full-screen state: configuration error, nothing loaded, or an internal failure. */
export function downPayload(
  now: number,
  o: { title: string; reason: string; lastGood?: number | null; sample?: boolean; received?: string },
): PayloadV1 {
  const unavailable: Day = { label: "", fdr: { ...UNRATED.fdr }, tfb: { ...UNRATED.tfb }, wx: { ...NO_WX } };
  const received = o.received ?? "unknown";
  return {
    v: 1,
    ok: false,
    ...(o.sample ? { sample: true } : {}),
    generated_epoch: Math.floor(now / 60_000) * 60,
    checked_local: fmtWeekdayTime(now),
    feed_received_local: received,
    down_title: clip(o.title, 24),
    down_reason: clip(o.reason, 100),
    ...(o.lastGood ? attempt<{ last_good_local?: string }>(() => ({ last_good_local: fmtWeekdayTime(o.lastGood!) }), {}) : {}),
    district: "",
    radius_km: 0,
    neighbours: "",
    statewide: "",
    house: { status: "unknown" },
    days: [unavailable, { ...unavailable }],
    incidents: { ok: false, stale: false, heading: "", as_at: "" },
    attribution: `${SOURCES} ${received}`,
    disclaimer: DISCLAIMER,
  };
}
