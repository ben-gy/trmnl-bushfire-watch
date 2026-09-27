/**
 * How each upstream is fetched, cached and aged. Ages come from the source's own timestamp where it
 * has one (feed lastUpdated, BoM issue time), so a frozen feed served fresh by a CDN still goes stale.
 */
import { ALARM_KEEP_MS } from "../ratings.js";
import type { SourceSpec } from "../store.js";
import { localDate } from "../time.js";
import type { BomFdr, BomFw, EventsFeed, Home, RatingsFeed, Weather } from "../types.js";
import { IDV18555_URL, mergeBomFdr, parseIdv18555 } from "./bom-fdr.js";
import { IDV18560_URL, mergeBomFw, parseIdv18560 } from "./bom-fw.js";
import { CFA_URL, parseCfaRss } from "./cfa-rss.js";
import { OSOM_URL, parseOsom } from "./fdrtfb.js";
import { openMeteoUrl, parseOpenMeteo } from "./openmeteo.js";
import { EVENTS_URL, parseEvents } from "./vicemergency.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * The normalised models' version, in every cache key. Bump it whenever a model in types.ts changes
 * shape, so a deploy never reads what the previous one stored (the `valid` guards are the backstop).
 */
const MODEL = "v1";

function json<T>(parse: (x: unknown) => T | undefined) {
  return (body: string): T | undefined => {
    try {
      return parse(JSON.parse(body));
    } catch {
      return undefined;
    }
  };
}

/** S3 stamps each republish; Last-Modified is the fallback. */
function headerTime(res: Response | null): number | null {
  if (!res) return null;
  const t = Date.parse(res.headers.get("x-amz-meta-lastupdated") ?? res.headers.get("last-modified") ?? "");
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------------------------------------
// Model guards: the shapes the payload code relies on, checked on every copy read back from the cache.

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const timeOrNull = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x));
const values = (o: Obj, ok: (x: unknown) => boolean) => Object.values(o).every(ok);

const FEATURE_STRINGS = ["id", "kind", "agency", "feed", "cat1", "cat2", "status", "location", "event", "action", "levelRaw"] as const;

function isFeature(f: unknown): boolean {
  if (!isObj(f) || !isObj(f.geo)) return false;
  const g = f.geo;
  return (
    FEATURE_STRINGS.every((k) => typeof f[k] === "string") &&
    (f.level === null || typeof f.level === "number") &&
    typeof f.statewide === "boolean" &&
    timeOrNull(f.created) &&
    timeOrNull(f.updated) &&
    Array.isArray(g.points) &&
    Array.isArray(g.polygons) &&
    (g.bbox === null || Array.isArray(g.bbox))
  );
}

const isDayConditions = (c: unknown) => isObj(c) && typeof c.date === "string" && isObj(c.fdr) && isObj(c.tfb);

export function isEventsFeed(d: unknown): d is EventsFeed {
  return isObj(d) && timeOrNull(d.lastUpdated) && Array.isArray(d.features) && Array.isArray(d.conditions) && d.features.every(isFeature) && d.conditions.every(isDayConditions);
}

export function isRatingsFeed(d: unknown): d is RatingsFeed {
  return (
    isObj(d) &&
    isObj(d.fdr) &&
    values(d.fdr, isObj) &&
    isObj(d.tfb) &&
    values(d.tfb, isObj) &&
    isObj(d.declaration) &&
    isObj(d.issued) &&
    Array.isArray(d.notYet)
  );
}

export function isBomFdr(d: unknown): d is BomFdr {
  return isObj(d) && timeOrNull(d.issued) && timeOrNull(d.nextIssue) && isObj(d.days) && values(d.days, (byDate) => isObj(byDate) && values(byDate, isObj));
}

export function isBomFw(d: unknown): d is BomFw {
  const lists = (o: unknown) => isObj(o) && values(o, (l) => Array.isArray(l) && l.every(isObj));
  return isObj(d) && timeOrNull(d.issued) && lists(d.district) && lists(d.subarea);
}

export function isWeather(d: unknown): d is Weather {
  const hour = (h: unknown) => isObj(h) && typeof h.t === "number";
  return isObj(d) && timeOrNull(d.currentAt) && (d.current === null || hour(d.current)) && Array.isArray(d.hours) && d.hours.every(hour);
}

// ---------------------------------------------------------------------------------------------

export interface Specs {
  events: SourceSpec<EventsFeed>;
  osom: SourceSpec<RatingsFeed>;
  cfa: SourceSpec<RatingsFeed>;
  bomFdr: SourceSpec<BomFdr>;
  bomFw: SourceSpec<BomFw>;
  weather: SourceSpec<Weather>;
}

/**
 * `prefix` keeps fixture runs out of the production cache. `weatherKey` is a hash of the location
 * rounded to 2 dp: not the location itself, though a reader of the KV could reverse it.
 */
export function specs(home: Home, weatherKey: string, prefix = ""): Specs {
  const key = (id: string) => `${prefix}src:${MODEL}:${id}`;
  return {
    // Republished every ~20 s. Warnings older than 45 min are withheld as all-clears (alarms stay, labelled).
    events: {
      id: "events",
      key: key("events"),
      url: EVENTS_URL,
      refreshMs: MIN,
      okAgeMs: 10 * MIN,
      staleAgeMs: 45 * MIN,
      timeoutMs: 4000,
      validator: "etag",
      accept: "application/json",
      parse: json(parseEvents),
      asOf: (d, res) => d.lastUpdated ?? headerTime(res),
      valid: isEventsFeed,
    },
    // Ratings are date-keyed, so an hour-old copy is still right for its dates; a TFB can be declared in
    // the afternoon, which is why it is not trusted as an all-clear beyond an hour. A 304 renews asOf
    // from the S3 stamp. Past 6 h not even an alarm from it is shown.
    osom: {
      id: "osom",
      key: key("osom"),
      url: OSOM_URL,
      refreshMs: 5 * MIN,
      okAgeMs: HOUR,
      staleAgeMs: ALARM_KEEP_MS,
      timeoutMs: 4000,
      validator: "etag",
      accept: "application/json",
      parse: json(parseOsom),
      asOf: (_d, res) => headerTime(res),
      valid: isRatingsFeed,
    },
    cfa: {
      id: "cfa",
      key: key("cfa"),
      url: CFA_URL,
      refreshMs: 10 * MIN,
      okAgeMs: HOUR,
      staleAgeMs: ALARM_KEEP_MS,
      timeoutMs: 4000,
      validator: "etag",
      accept: "application/rss+xml, application/xml, text/xml",
      parse: (body) => parseCfaRss(body),
      asOf: (_d, res) => headerTime(res),
      valid: isRatingsFeed,
    },
    // Issued ~05:30 and ~16:00 local, so a good copy can be 13 h old. reg.bom.gov.au ignores ETags.
    // The product names its next routine issue: an hour past that our copy is behind (stale), and 6 h
    // past it gone. 18 h / 24 h bound a copy that doesn't say.
    bomFdr: {
      id: "bom_fdr",
      key: key("bom_fdr"),
      url: IDV18555_URL,
      refreshMs: 15 * MIN,
      okAgeMs: 18 * HOUR,
      staleAgeMs: 24 * HOUR,
      timeoutMs: 4000,
      validator: "last-modified",
      accept: "application/xml, text/xml",
      parse: (body) => parseIdv18555(body),
      asOf: (d) => d.issued,
      merge: (prev, next, now) => mergeBomFdr(prev, next, localDate(now)),
      valid: isBomFdr,
      until: (d) => (d.nextIssue !== null ? { ok: d.nextIssue + HOUR, stale: d.nextIssue + ALARM_KEEP_MS } : null),
    },
    // Its model keeps no next-issue time, so only the age limits apply (the same issue times as IDV18555).
    bomFw: {
      id: "bom_fw",
      key: key("bom_fw"),
      url: IDV18560_URL,
      refreshMs: 30 * MIN,
      okAgeMs: 18 * HOUR,
      staleAgeMs: 24 * HOUR,
      timeoutMs: 4000,
      validator: "last-modified",
      accept: "application/xml, text/xml",
      parse: (body) => parseIdv18560(body),
      asOf: (d) => d.issued,
      merge: (prev, next, now) => mergeBomFw(prev, next, localDate(now)),
      valid: isBomFw,
    },
    weather: {
      id: "weather",
      key: key(`weather:${weatherKey}`),
      url: openMeteoUrl(home),
      refreshMs: 15 * MIN,
      okAgeMs: 90 * MIN,
      staleAgeMs: 6 * HOUR,
      timeoutMs: 4000,
      validator: "none",
      accept: "application/json",
      parse: json(parseOpenMeteo),
      valid: isWeather,
    },
  };
}
