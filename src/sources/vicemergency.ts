/**
 * VicEmergency's public events feed: warnings, incidents, planned burns, and dated FDR/TFB
 * "conditions". Each feature is normalised at parse time into a PII-free model: only the fields
 * below are copied, so cap.contact (a named officer's email), webBody, text, url, resources and
 * incidentFeatures never reach the cache, the logs or the payload.
 */
import { agencyOf, clean, kindOf, warningLevel } from "../classify.js";
import { districtKey } from "../districts.js";
import { extractGeo } from "../geo.js";
import { localDate, parseTime } from "../time.js";
import type { DayConditions, EventsFeed, NormFeature } from "../types.js";

export const EVENTS_URL = "https://emergency.vic.gov.au/public/events-geojson.json";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** undefined unless the document is a FeatureCollection with a features array. */
export function parseEvents(json: unknown): EventsFeed | undefined {
  if (!isObj(json) || json.type !== "FeatureCollection" || !Array.isArray(json.features)) return undefined;
  const props = isObj(json.properties) ? json.properties : {};
  const features: NormFeature[] = [];
  json.features.forEach((raw: unknown, i: number) => {
    const f = normFeature(raw, i);
    if (f.kind !== "earthquake") features.push(f);
  });
  return { lastUpdated: parseTime(props.lastUpdated), features, conditions: parseConditions(props.conditions) };
}

/** A feature with no properties is kept (as unclassified) so it is counted, never silently dropped. */
function normFeature(raw: unknown, index: number): NormFeature {
  const feat = isObj(raw) ? raw : {};
  const p = isObj(feat.properties) ? feat.properties : {};
  const cap = isObj(p.cap) ? p.cap : {};
  const geo = extractGeo(feat.geometry);
  const kind = kindOf(p, geo);
  const cat1 = clean(p.category1), cat2 = clean(p.category2), action = clean(p.action);
  const lvl = kind === "warning" ? warningLevel(cat1, action) : null;
  const sourceOrg = clean(p.sourceOrg), feed = clean(p.sourceFeed).toLowerCase();
  return {
    id: clean(p.id ?? p.sourceId ?? String(index), 200) || String(index),
    kind,
    agency: agencyOf(sourceOrg, feed),
    feed,
    cat1,
    cat2,
    status: clean(p.status),
    location: clean(p.location, 120),
    // BoM features carry no CAP block; their name says what the warning is ("Severe Weather Warning for DAMAGING WINDS").
    event: clean(cap.event) || (kind === "met_warning" ? clean(p.name, 80) : "") || cat2,
    action,
    level: lvl ? lvl.level : null,
    levelRaw: lvl ? lvl.raw : "",
    statewide: typeof p.statewide === "string" && p.statewide.trim().toUpperCase() === "Y",
    created: parseTime(p.created),
    updated: parseTime(p.updated),
    geo,
  };
}

/**
 * properties.conditions.forecasts[]: each `date` is local midnight as a UTC instant
 * ("2026-09-26T14:00:00.000Z" is 27 Sep), so it goes through Intl, never a fixed +10 h.
 * The undated conditions.fdr/tfb are ignored: they say nothing about which day they mean.
 */
function parseConditions(c: unknown): DayConditions[] {
  if (!isObj(c) || !Array.isArray(c.forecasts)) return [];
  const out: DayConditions[] = [];
  for (const fc of c.forecasts) {
    if (!isObj(fc)) continue;
    const t = parseTime(fc.date);
    if (t === null) continue;
    out.push({ date: localDate(t), fdr: byDistrict(fc.fdr), tfb: byDistrict(fc.tfb) });
  }
  return out;
}

function byDistrict(o: unknown): DayConditions["fdr"] {
  const out: DayConditions["fdr"] = {};
  if (!isObj(o)) return out;
  for (const [name, v] of Object.entries(o)) {
    const key = districtKey(name);
    const s = typeof v === "string" ? clean(v, 60) : "";
    if (key && s) out[key] = s;
  }
  return out;
}
