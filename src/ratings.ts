/**
 * Fire Danger Rating and Total Fire Ban for today and tomorrow, merged by date across every rating
 * source. The merge only moves towards alarm: the highest rating wins, any YES declares a ban, and a
 * stale source may raise an alarm but never lower one. A stale alarm is kept for up to 6 h and says
 * so ("LAST KNOWN 14:05"). Missing data is its own state, never "No Rating" or "No TFB".
 */
import { districtName } from "./districts.js";
import { fmtTime, fmtWeekdayTime } from "./time.js";
import type { BomFdr, BomFdrDay, Day, DistrictKey, LocalDate, RatingsFeed, SourceResult } from "./types.js";

export type RatingWord = "NO RATING" | "MODERATE" | "HIGH" | "EXTREME" | "CATASTROPHIC";
export type RatingLevel = -1 | 0 | 1 | 2 | 3 | 4;

/** Official AFDRS action statements, verbatim. */
export const AFDRS_ACTION: Record<RatingWord, string> = {
  "NO RATING": "No rating – fires can still start",
  MODERATE: "Plan and prepare",
  HIGH: "Be ready to act",
  EXTREME: "Take action now to protect life and property",
  CATASTROPHIC: "For your survival, leave bushfire risk areas",
};

export const RATING_UNAVAILABLE = "RATING UNAVAILABLE";
export const TFB_UNAVAILABLE = "TFB status unavailable";
/** Where to look instead, when a rating can't be given. */
export const CHECK = "Check emergency.vic.gov.au or VicEmergency app";
const NOT_ISSUED = "NO RATING ISSUED";
const NO_DISTRICT = "District unknown – set it in plugin settings";
const WORD_MAX = 18;
/** The day columns are 188 px wide: about 29 characters of TRMNL12 before the runtime clamps. */
const ISSUED_MAX = 29;
/** types.ts budget for `neighbours`: longer lines must shorten here, before the payload clips them. */
const NEIGHBOUR_MAX = 38;
const TFB_MAX = 31;

/** Stale alarms (TFB YES, Extreme or above, a warning over the house) are shown for this long, labelled. */
export const ALARM_KEEP_MS = 6 * 3600_000;

const LEVEL: Record<string, RatingLevel> = {
  "NO FORECAST": 0,
  "NO RATING": 0,
  MODERATE: 1,
  HIGH: 2,
  EXTREME: 3,
  CATASTROPHIC: 4,
};

/**
 * Normalises any source's rating text. VicEmergency's "NO FORECAST" matched BoM's "No Rating" in
 * every district-day checked, so it maps to NO RATING here; buildRatings still says "NO RATING
 * ISSUED" when nothing independent confirms it. Unknown vocabulary is shown raw and ranked at least
 * High (higher when it names a higher level), because a renamed top rating must never look calm.
 * `recognised` means the text is one of the AFDRS words (or NO FORECAST).
 */
export function normRating(raw: string | null | undefined): { level: RatingLevel; word: string; recognised: boolean } {
  const s = typeof raw === "string" ? raw.toUpperCase().replace(/[\s_]+/g, " ").trim() : "";
  if (!s) return { level: -1, word: RATING_UNAVAILABLE, recognised: false };
  const level = LEVEL[s];
  if (level !== undefined) return { level, word: level === 0 ? "NO RATING" : s, recognised: true };
  const named = /\bCATASTROPHIC\b/.test(s) ? 4 : /\bEXTREME\b/.test(s) ? 3 : 2;
  return { level: named, word: s, recognised: false };
}

export interface RatingInputs {
  /** Today and tomorrow, Melbourne calendar dates. */
  dates: [LocalDate, LocalDate];
  now: number;
  district: DistrictKey | null;
  osom: SourceResult<RatingsFeed>;
  /** The events feed's dated conditions, via ratingsFromConditions(). */
  conditions: SourceResult<RatingsFeed>;
  cfa: SourceResult<RatingsFeed>;
  bomFdr: SourceResult<BomFdr>;
  /** Statuses of area-product features containing home, e.g. "CATASTROPHIC", "TOTAL FIRE BAN IN FORCE". They describe today. */
  areaStatuses?: string[];
}

type DayRatings = { fdr: Day["fdr"]; tfb: Day["tfb"] };

export function buildRatings(i: RatingInputs): [DayRatings, DayRatings] {
  const area = i.areaStatuses ?? [];
  const day = (n: 0 | 1): DayRatings => {
    const statuses = n === 0 ? area : [];
    return { fdr: rateDay(i.district, i.dates[n], i, statuses), tfb: tfbDay(i.district, i.dates[n], n === 1, i, statuses) };
  };
  return [day(0), day(1)];
}

/** Shorter names for a neighbour line that also carries a time. */
const COMPACT: Partial<Record<DistrictKey, string>> = {
  north_central: "N Central",
  northern_country: "N Country",
  east_gippsland: "E Gippsland",
  west_and_south_gippsland: "W&S Gippsland",
};

/** "14:05" when the rating or the ban shown comes only from a stale copy (LAST KNOWN / as of), else null. */
function staleTime(fdr: Day["fdr"], tfb: Day["tfb"]): string | null {
  const m = /^LAST KNOWN (\S+)/.exec(fdr.issued) ?? / as of (\S+)$/.exec(tfb.text);
  return m ? m[1]! : null;
}

/**
 * "North Central: MODERATE · No TFB" for a neighbouring district, or "" when nothing is known about it.
 * An alarm from a stale copy carries its time, before the ban: "N Central: CATASTROPHIC · 14:05 · TFB".
 * The template's nb_alarm finds an alarm by ": EXTREME" / ": CATASTROPHIC", or by a ban as the last
 * " · " part, so an Extreme+ word is only shortened when the ban is there to say so.
 */
export function neighbourLine(key: DistrictKey, date: LocalDate, i: RatingInputs): string {
  const fdr = rateDay(key, date, i, []);
  const tfb = tfbDay(key, date, date === i.dates[1], i, []);
  if (fdr.level < 0 && tfb.state === "unknown" && tfb.text === TFB_UNAVAILABLE) return "";
  const word = fdr.level < 0 ? "RATING N/A" : fdr.word;
  const declared = tfb.state === "declared";
  const ban = declared
    ? "TOTAL FIRE BAN"
    : tfb.state === "none"
      ? "No TFB"
      : tfb.state === "pending"
        ? "No TFB yet"
        : tfb.text === TFB_UNAVAILABLE
          ? "TFB n/a"
          : "TFB unclear";
  const name = districtName(key);
  const abbr = name.replace("West and South", "W&S");
  const fit = (candidates: string[]) => candidates.find((c) => c.length <= NEIGHBOUR_MAX);

  const t = staleTime(fdr, tfb);
  if (t !== null) {
    const names = [...new Set([name, abbr, COMPACT[key] ?? abbr])];
    const words = declared ? [word, SHORT[word] ?? word] : [word];
    // "" drops a ban that isn't one; a declared ban is never dropped.
    const bans = declared ? ["TFB"] : [ban, ""];
    // Preference: the whole word, then the ban, then the full name, then "as of".
    const all: string[] = [];
    for (const w of words)
      for (const b of bans)
        for (const n of names)
          for (const at of [`as of ${t}`, t]) all.push(`${n}: ${w} · ${at}${b ? ` · ${b}` : ""}`);
    const found = fit(all);
    if (found) return found;
    const head = `${names[names.length - 1]}: `;
    const tail = ` · ${t}${declared ? " · TFB" : ""}`;
    return `${head}${clip(words[words.length - 1]!, NEIGHBOUR_MAX - head.length - tail.length)}${tail}`;
  }

  const short = declared ? "TFB" : ban;
  const line = (n: string, b: string) => `${n}: ${word} · ${b}`;
  const found = fit([line(name, ban), line(name, short), line(abbr, short), ...(declared ? [] : [`${abbr}: ${word}`])]);
  if (found) return found;
  // Still too long: a declared ban is kept whole and the rating word gives way; anything else is cut.
  if (!declared) return clip(`${abbr}: ${word}`, NEIGHBOUR_MAX);
  const head = `${abbr}: `;
  return `${head}${clip(word, NEIGHBOUR_MAX - head.length - " · TFB".length)} · TFB`;
}

// ---------------------------------------------------------------------------------------------

interface Vote {
  src: string;
  level: RatingLevel;
  word: string;
  recognised: boolean;
  /** Said "No Rating" outright, as opposed to VicEmergency's ambiguous "NO FORECAST". */
  explicitNone: boolean;
  /** From a stale source: an alarm kept, shown as LAST KNOWN. */
  stale: boolean;
  /** The source's own time, for the LAST KNOWN label. */
  asOf: number | null;
}

function usable<T>(s: SourceResult<T> | undefined): T | null {
  return s && s.state !== "unavailable" && s.data ? s.data : null;
}

/**
 * How a source may be used now: fresh, stale (alarms only, labelled), or not at all. A stale copy
 * older than 6 h is dropped whatever the store's own stale window for that source. BoM is aged from
 * the issue that should have replaced it, since a good copy is routinely 13 h old.
 */
function freshness(s: SourceResult<unknown>, now: number, nextIssue: number | null = null): { stale: boolean; asOf: number | null } | null {
  if (!usable(s)) return null;
  const asOf = s.asOf ?? s.fetchedAt;
  if (s.state !== "stale") return { stale: false, asOf };
  const ref = nextIssue ?? asOf;
  // Unknown age: the store's own state still says stale, so keep the alarm, labelled.
  if (ref !== null && now - ref > ALARM_KEEP_MS) return null;
  return { stale: true, asOf };
}

function vote(src: string, raw: unknown, f: { stale: boolean; asOf: number | null }): Vote | null {
  if (typeof raw !== "string") return null;
  const n = normRating(raw);
  if (n.level < 0) return null;
  if (f.stale && n.level < 3) return null;
  return { src, ...n, explicitNone: n.level === 0 && !/FORECAST/i.test(raw), stale: f.stale, asOf: f.asOf };
}

function votesFor(key: DistrictKey, date: LocalDate, i: RatingInputs): { votes: Vote[]; bom: BomFdrDay | null } {
  const votes: Vote[] = [];
  const feeds: [string, SourceResult<RatingsFeed>][] = [
    ["EMV", i.osom],
    ["EMV", i.conditions],
    ["CFA", i.cfa],
  ];
  for (const [src, s] of feeds) {
    const f = freshness(s, i.now);
    const d = usable(s);
    if (!f || !d || d.notYet?.includes(date)) continue;
    const v = vote(src, d.fdr?.[date]?.[key], f);
    if (v) votes.push(v);
  }
  const bd = usable(i.bomFdr);
  const f = freshness(i.bomFdr, i.now, typeof bd?.nextIssue === "number" ? bd.nextIssue : null);
  const b = f ? (bd?.days?.[key]?.[date] ?? null) : null;
  const v = f ? vote("BoM", b?.rating, f) : null;
  if (v) votes.push(v);
  return { votes, bom: v && !v.stale ? b : null };
}

/** "LAST KNOWN 14:05": the newest time any of these stale sources confirmed it. */
function lastKnown(votes: { asOf: number | null }[]): string {
  const t = votes.reduce<number | null>((m, v) => (v.asOf !== null && (m === null || v.asOf > m) ? v.asOf : m), null);
  try {
    return t !== null ? fmtTime(t) : "—";
  } catch {
    return "—"; // a time outside Date's range must not cost the rating itself
  }
}

function rateDay(key: DistrictKey | null, date: LocalDate, i: RatingInputs, area: string[]): Day["fdr"] {
  const { votes, bom } = key ? votesFor(key, date, i) : { votes: [], bom: null };
  let best: Vote | undefined;
  // On a tie, a fresh source's word is the one shown.
  for (const v of votes) if (!best || v.level > best.level || (v.level === best.level && best.stale && !v.stale)) best = v;

  // An area product is a cross-check that can only raise the rating (R-C9), never supply an all-clear.
  let top: Vote | undefined;
  for (const s of area) {
    const n = normRating(s);
    if (n.recognised && n.level >= 1 && (!top || n.level > top.level)) top = { src: "CFA area", ...n, explicitNone: false, stale: false, asOf: null };
  }
  // A fresh area product that matches a stale-only rating makes it current again.
  if (top && (top.level > (best?.level ?? -1) || (best?.stale && top.level === best.level))) {
    return { level: top.level, word: top.word, action: actionFor(top), issued: note([top, ...votes]) };
  }

  if (!best) return { level: -1, word: RATING_UNAVAILABLE, action: key ? CHECK : NO_DISTRICT, issued: "" };

  const b = best;
  const word = b.level === 0 ? (votes.some((v) => v.level === 0 && v.explicitNone) ? "NO RATING" : NOT_ISSUED) : clip(b.word, WORD_MAX);
  if (b.stale) {
    // Only stale sources say this (a fresh one would have won the tie): an old alarm must never pass for a current one.
    const label = `LAST KNOWN ${lastKnown(votes.filter((v) => v.level === b.level))}`;
    const fresh = votes.filter((v) => !v.stale);
    const withNote = fresh.length ? `${label} · ${note(fresh)}` : label;
    return { level: b.level, word, action: actionFor(b), issued: withNote.length <= ISSUED_MAX ? withNote : label };
  }
  const disagree = new Set(votes.map((v) => v.word)).size > 1;
  const bomFbi = bom && bom.fbi !== null && Number.isFinite(bom.fbi) && normRating(bom.rating).word === best.word ? bom.fbi : null;
  let issued = "";
  if (disagree) {
    issued = note(votes);
    if (bomFbi !== null && `${issued} · FBI ${bomFbi}`.length <= ISSUED_MAX) issued += ` · FBI ${bomFbi}`;
  } else if (bomFbi !== null) {
    const at = bom?.issued ?? usable(i.bomFdr)?.issued ?? null;
    issued = clip(at !== null ? `FBI ${bomFbi} · BoM ${fmtWeekdayTime(at)}` : `FBI ${bomFbi} · BoM`, ISSUED_MAX);
  }
  return { level: best.level, word, action: actionFor(best), issued };
}

function actionFor(v: Vote): string {
  if (!v.recognised) return CHECK;
  return AFDRS_ACTION[(v.level === 0 ? "NO RATING" : v.word) as RatingWord] ?? CHECK;
}

const SHORT: Record<string, string> = { MODERATE: "MOD", EXTREME: "EXT", CATASTROPHIC: "CAT" };

/** "BoM: HIGH · EMV/CFA: MOD": highest first, sources grouped by what they said, ≤ ISSUED_MAX (29) chars. */
function note(votes: Vote[]): string {
  const groups: { word: string; srcs: string[] }[] = [];
  for (const v of [...votes].sort((a, b) => b.level - a.level)) {
    let g = groups.find((x) => x.word === v.word);
    if (!g) groups.push((g = { word: v.word, srcs: [] }));
    if (!g.srcs.includes(v.src)) g.srcs.push(v.src);
  }
  const parts = groups.map((g) => `${g.srcs.join("/")}: ${SHORT[g.word] ?? clip(g.word, 10)}`);
  let out = parts[0] ?? "";
  for (const p of parts.slice(1)) {
    if (`${out} · ${p}`.length > ISSUED_MAX) break;
    out += ` · ${p}`;
  }
  return clip(out, ISSUED_MAX);
}

const YES = /^YES/i;
const AREA_BAN = /^(YES\b|TOTAL FIRE BAN( IN FORCE)?$)/i;

function tfbDay(key: DistrictKey | null, date: LocalDate, tomorrow: boolean, i: RatingInputs, area: string[]): Day["tfb"] {
  const vals: string[] = [];
  const yes: { stale: boolean; asOf: number | null }[] = [];
  if (key) {
    for (const s of [i.osom, i.conditions, i.cfa]) {
      const f = freshness(s, i.now);
      const raw = usable(s)?.tfb?.[date]?.[key];
      if (!f || typeof raw !== "string" || !raw.trim()) continue;
      const v = raw.trim().toUpperCase();
      if (f.stale && !YES.test(v)) continue;
      vals.push(v);
      if (YES.test(v)) yes.push(f);
    }
  }
  if (yes.some((y) => !y.stale) || area.some((s) => AREA_BAN.test(s.trim()))) {
    return { state: "declared", text: "TOTAL FIRE BAN" };
  }
  if (yes.length) {
    // Every YES is from a stale copy: still a ban, but say how old.
    const text = `TOTAL FIRE BAN · as of ${lastKnown(yes)}`;
    return { state: "declared", text: text.length <= TFB_MAX ? text : "TOTAL FIRE BAN" };
  }
  const first = vals[0];
  if (first === undefined) return { state: "unknown", text: TFB_UNAVAILABLE };
  if (/^NO\b/.test(first)) {
    // Bans are usually declared the afternoon before, so tomorrow's NO is not an all-clear.
    return tomorrow ? { state: "pending", text: "No TFB declared yet" } : { state: "none", text: "No TFB · restrictions may apply" };
  }
  return { state: "unknown", text: "TFB status unclear" };
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  const atWord = s[n - 1] === " " || sp <= n / 2;
  return `${(atWord ? cut : cut.slice(0, sp)).trimEnd()}…`;
}
