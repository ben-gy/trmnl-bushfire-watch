/**
 * BoM IDV18555, the district fire danger forecast: the Fire Behaviour Index plus an independent copy
 * of the rating. Periods are dated by their start-time-local, never by index: the 16:00 issue starts
 * at tomorrow, so "first period = today" would show tomorrow's rating as today's every evening.
 */
import { clean } from "../classify.js";
import { districtKey } from "../districts.js";
import { parseTime } from "../time.js";
import { all, docRoot, first, parseXml, typed } from "../xml.js";
import type { BomFdr, BomFdrDay, LocalDate } from "../types.js";

export const IDV18555_URL = "https://reg.bom.gov.au/fwo/IDV18555.xml";

export function parseIdv18555(xml: string): BomFdr | undefined {
  if (typeof xml !== "string") return undefined;
  // A body cut short would read as fewer or clipped ratings ("Catastr"), so only a closed <product>.
  const root = docRoot(parseXml(xml), "product");
  const amoc = root && first(root, "amoc");
  if (!root || !amoc || first(amoc, "identifier")?.text.trim() !== "IDV18555") return undefined;
  const issued = parseTime(first(amoc, "issue-time-utc")?.text.trim());
  const nextIssue = parseTime(first(amoc, "next-routine-issue-time-utc")?.text.trim());
  const days: BomFdr["days"] = {};
  let n = 0;
  for (const area of all(root, "area")) {
    if (area.attrs.type !== "fire-district") continue;
    const key = districtKey(area.attrs.aac);
    if (!key) continue;
    for (const fp of area.children) {
      if (fp.name !== "forecast-period") continue;
      const date = periodDate(fp.attrs["start-time-local"]);
      const rating = clean(typed(fp, "text", "fire_danger") || typed(fp, "element", "fire_danger"), 60);
      if (!date || !rating) continue;
      const day: BomFdrDay = { rating, fbi: num(typed(fp, "element", "fire_behaviour_index")), issued };
      (days[key] ??= {})[date] = day;
      n++;
    }
  }
  return n ? { issued, nextIssue, days } : undefined;
}

/**
 * Date-keyed union of two issues, preferring the newer issue, dropping dates before `keepFrom`. BoM's
 * afternoon issue omits today, so today's morning values survive until midnight.
 */
export function mergeBomFdr(prev: BomFdr | null, next: BomFdr, keepFrom: LocalDate): BomFdr {
  const newer = prev && prev.issued !== null && next.issued !== null && prev.issued > next.issued ? prev : next;
  const days: BomFdr["days"] = {};
  for (const src of newer === next ? [prev, next] : [next, prev]) {
    for (const [k, byDate] of Object.entries(src?.days ?? {})) {
      for (const [date, v] of Object.entries(byDate ?? {})) {
        if (date >= keepFrom) (days[k as keyof BomFdr["days"]] ??= {})[date] = v;
      }
    }
  }
  return { issued: newer.issued, nextIssue: newer.nextIssue, days };
}

/** "2026-09-28T00:00:00+10:00" → "2026-09-28": the local date as BoM wrote it. */
export function periodDate(s: string | undefined): LocalDate | null {
  return /^(\d{4}-\d{2}-\d{2})T/.exec(s ?? "")?.[1] ?? null;
}

/** A numeric element's value; absent or blank is null, never 0. */
export function num(s: string | undefined): number | null {
  if (s === undefined || !s.trim()) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
