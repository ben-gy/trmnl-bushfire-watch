/**
 * VicEmergency's osom-fdrtfb.json: FDR and TFB per district for today to +3 days. Entries are told
 * apart by shape (TFB entries carry `declaration`, FDR entries `issueAt`), never by their position in
 * results[], and each is dated by its own `issueFor`.
 */
import { clean } from "../classify.js";
import { districtKey } from "../districts.js";
import { normRating } from "../ratings.js";
import { fromDMY } from "../time.js";
import type { DayConditions, LocalDate, RatingsFeed } from "../types.js";

export const OSOM_URL = "https://emergency.vic.gov.au/public/osom-fdrtfb.json";

export function emptyRatings(): RatingsFeed {
  return { fdr: {}, tfb: {}, declaration: {}, notYet: [], issued: {} };
}

type ByDate = RatingsFeed["fdr"];

/**
 * Records a value; when a source repeats a district-day, the more alarming value is kept. Values are
 * cleaned here, the one door every rating source goes through, so no markup, address or bidi control
 * reaches the payload.
 */
export function putRating(m: ByDate, which: "fdr" | "tfb", date: LocalDate, district: unknown, raw: unknown): boolean {
  const key = districtKey(district);
  const v = typeof raw === "string" ? clean(raw, 60).toUpperCase() : "";
  if (!key || !v) return false;
  const day = (m[date] ??= {});
  const prev = day[key];
  if (prev === undefined || rank(which, v) > rank(which, prev)) day[key] = v;
  return true;
}

function rank(which: "fdr" | "tfb", v: string): number {
  return which === "fdr" ? normRating(v).level : /^YES/.test(v) ? 1 : 0;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function parseOsom(json: unknown): RatingsFeed | undefined {
  if (!isObj(json) || !Array.isArray(json.results)) return undefined;
  const out = emptyRatings();
  let n = 0;
  for (const e of json.results) {
    if (!isObj(e) || !Array.isArray(e.declareList)) continue;
    const date = fromDMY(e.issueFor);
    if (!date) continue;
    const which = "declaration" in e ? "tfb" : "issueAt" in e ? "fdr" : null;
    if (!which) continue;
    for (const d of e.declareList) {
      if (isObj(d) && putRating(out[which], which, date, d.name, d.status)) n++;
    }
    const decl = which === "tfb" && typeof e.declaration === "string" ? clean(e.declaration, 160) : "";
    if (decl) out.declaration[date] = decl;
  }
  return n ? out : undefined;
}

/** The events feed's dated conditions in the same shape, so ratings.ts treats every source alike. */
export function ratingsFromConditions(c: DayConditions[]): RatingsFeed {
  const out = emptyRatings();
  for (const day of Array.isArray(c) ? c : []) {
    if (!day || typeof day.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    for (const [k, v] of Object.entries(day.fdr ?? {})) putRating(out.fdr, "fdr", day.date, k, v);
    for (const [k, v] of Object.entries(day.tfb ?? {})) putRating(out.tfb, "tfb", day.date, k, v);
  }
  return out;
}
