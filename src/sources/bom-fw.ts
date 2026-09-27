/**
 * BoM IDV18560, the official fire weather forecast: per district and per LGA fire sub-area, including
 * the wind-change danger flag. The 16:00 issue carries tomorrow only, so periods are dated by their
 * start-time-local and merged per date across issues.
 */
import { clean } from "../classify.js";
import { districtKey, normKey } from "../districts.js";
import { parseTime } from "../time.js";
import { all, docRoot, first, parseXml, typed, type XEl } from "../xml.js";
import type { BomFw, FireWx, LocalDate } from "../types.js";
import { num, periodDate } from "./bom-fdr.js";

export const IDV18560_URL = "https://reg.bom.gov.au/fwo/IDV18560.xml";

export function parseIdv18560(xml: string): BomFw | undefined {
  if (typeof xml !== "string") return undefined;
  // A body cut short would drop districts and periods silently, so only a closed <product>.
  const root = docRoot(parseXml(xml), "product");
  const amoc = root && first(root, "amoc");
  if (!root || !amoc || first(amoc, "identifier")?.text.trim() !== "IDV18560") return undefined;
  const out: BomFw = { issued: parseTime(first(amoc, "issue-time-utc")?.text.trim()), district: {}, subarea: {} };
  let n = 0;
  for (const area of all(root, "area")) {
    let list: FireWx[];
    if (area.attrs.type === "fire-district") {
      const key = districtKey(area.attrs.aac);
      if (!key) continue;
      list = out.district[key] ??= [];
    } else if (area.attrs.type === "fire-sub-area") {
      const key = normKey(area.attrs.description ?? "");
      if (!key) continue;
      list = out.subarea[key] ??= [];
    } else continue;
    for (const fp of area.children) {
      if (fp.name !== "forecast-period") continue;
      const wx = fireWx(fp);
      if (!wx) continue;
      upsert(list, wx);
      n++;
    }
  }
  if (!n || !Object.keys(out.district).length) return undefined;
  return out;
}

function fireWx(fp: XEl): FireWx | null {
  const date = periodDate(fp.attrs["start-time-local"]);
  if (!date) return null;
  const el = (t: string) => typed(fp, "element", t) || typed(fp, "text", t) || undefined;
  const flag = el("wind_change_danger_flag")?.toLowerCase();
  return {
    date,
    fdr: clean(el("fire_danger_rating"), 60) || null,
    fbi: num(el("fire_behaviour_index")),
    haines: num(el("haines_index")),
    lightning: num(el("lightning_activity_level")),
    wcdi: num(el("wind_change_danger_index")),
    wcdFlag: flag === "yes" ? true : flag === "no" ? false : null,
    tmax50: num(el("air_temperature_maximum_50_percentile")),
    rhmin50: num(el("relative_humidity_minimum_50_percentile")),
    windDir: clean(el("wind_direction_at_elevation_1"), 16) || null,
    gust90: num(el("wind_gust_at_elevation_1_90_percentile")),
  };
}

function upsert(list: FireWx[], wx: FireWx): void {
  const i = list.findIndex((x) => x.date === wx.date);
  if (i >= 0) list[i] = wx;
  else list.push(wx);
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Per key and date union of two issues, preferring the newer issue, dropping dates before `keepFrom`. */
export function mergeBomFw(prev: BomFw | null, next: BomFw, keepFrom: LocalDate): BomFw {
  const newer = prev && prev.issued !== null && next.issued !== null && prev.issued > next.issued ? prev : next;
  const out: BomFw = { issued: newer.issued, district: {}, subarea: {} };
  for (const src of newer === next ? [prev, next] : [next, prev]) {
    if (!src) continue;
    for (const [k, list] of Object.entries(src.district ?? {})) {
      for (const wx of list ?? []) if (wx.date >= keepFrom) upsert((out.district[k as keyof BomFw["district"]] ??= []), wx);
    }
    for (const [k, list] of Object.entries(src.subarea ?? {})) {
      for (const wx of list ?? []) if (wx.date >= keepFrom) upsert((out.subarea[k] ??= []), wx);
    }
  }
  return out;
}
