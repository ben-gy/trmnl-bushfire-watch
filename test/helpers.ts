/**
 * Shared pieces for the integration tests (payload.test.ts, worker.test.ts): the real 27 Sep
 * snapshots served by URL through a fake fetch, an in-memory KV, a log collector, the template
 * rendered with LiquidJS, and the Worker's character budgets. Suburb-level coordinates only.
 */
import { readFileSync } from "node:fs";
import { Liquid } from "liquidjs";
import template from "../plugin/src/full.liquid";
import { IDV18555_URL } from "../src/sources/bom-fdr.js";
import { IDV18560_URL } from "../src/sources/bom-fw.js";
import { CFA_URL } from "../src/sources/cfa-rss.js";
import { OSOM_URL } from "../src/sources/fdrtfb.js";
import { EVENTS_URL } from "../src/sources/vicemergency.js";
import type { Home, PayloadV1 } from "../src/types.js";

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** 17:00 AEST on Sun 27 Sep 2026: four minutes after the live snapshots were captured. */
export const T_QUIET = Date.parse("2026-09-27T07:00:00Z");

/** The suburb-level test point, never a real house. */
export const SUBURB: Home = { lat: -37.73, lon: 145.22 };

export const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

export const FX = {
  events: fixture("events-2026-09-27T1656.json"),
  eventsJan: fixture("events-2026-01-09.json"),
  osom: fixture("osom-fdrtfb-2026-09-27T1656.json"),
  cfa: fixture("cfa-tfbfdr-2026-09-27T1656.xml"),
  /** Synthetic, in the shape of the BoM products (which are personal-use only). */
  idv18555: fixture("IDV18555-sample.xml"),
  idv18560: fixture("IDV18560-sample.xml"),
  openMeteo: fixture("open-meteo-2026-09-27T1656.json"),
  vicmapDistrict: fixture("vicmap-district-2026-09-27T1656.json"),
  vicmapLga: fixture("vicmap-lga-2026-09-27T1656.json"),
  /** DWITHIN 30 km of the suburb: Central, and North Central from about 23 km. */
  vicmapNeighbours: JSON.stringify({
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: "cfa_tfb_district.6", geometry: null, properties: { tfb_district: "CENTRAL" } },
      { type: "Feature", id: "cfa_tfb_district.7", geometry: null, properties: { tfb_district: "NORTH CENTRAL" } },
    ],
  }),
};

// ---------------------------------------------------------------------------------------------
// Upstreams

export type SourceKey = "events" | "osom" | "cfa" | "bom_fdr" | "bom_fw" | "weather" | "vicmap";
export const SOURCE_KEYS: SourceKey[] = ["events", "osom", "cfa", "bom_fdr", "bom_fw", "weather", "vicmap"];
/** The `src` each source logs under. */
export const LOG_ID: Record<SourceKey, string> = {
  events: "events",
  osom: "osom",
  cfa: "cfa",
  bom_fdr: "bom_fdr",
  bom_fw: "bom_fw",
  weather: "weather",
  vicmap: "district",
};
export const XML_SOURCES = new Set<SourceKey>(["cfa", "bom_fdr", "bom_fw"]);

export function sourceOf(url: string): SourceKey | null {
  if (url.startsWith(EVENTS_URL)) return "events";
  if (url.startsWith(OSOM_URL)) return "osom";
  if (url.startsWith(CFA_URL)) return "cfa";
  if (url.startsWith(IDV18555_URL)) return "bom_fdr";
  if (url.startsWith(IDV18560_URL)) return "bom_fw";
  if (url.startsWith("https://api.open-meteo.com/")) return "weather";
  if (url.startsWith("https://opendata.maps.vic.gov.au/")) return "vicmap";
  return null;
}

export type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

export const ok = (body: string, headers: Record<string, string> = {}, contentType = "application/json") =>
  new Response(body, { status: 200, headers: { "content-type": contentType, ...headers } });

/** The body each source serves when healthy (the 27 Sep snapshots). */
export function goodBody(src: SourceKey, url = ""): string {
  switch (src) {
    case "events":
      return FX.events;
    case "osom":
      return FX.osom;
    case "cfa":
      return FX.cfa;
    case "bom_fdr":
      return FX.idv18555;
    case "bom_fw":
      return FX.idv18560;
    case "weather":
      return FX.openMeteo;
    case "vicmap":
      return url.includes("vmlite_lga") ? FX.vicmapLga : url.includes("DWITHIN") ? FX.vicmapNeighbours : FX.vicmapDistrict;
  }
}

/** Healthy responses with the headers each upstream really sends, timed relative to `now`. */
export function healthy(now: number, bodies: Partial<Record<SourceKey, string>> = {}): Record<SourceKey, Responder> {
  const lm = (ago: number) => new Date(now - ago).toUTCString();
  return {
    events: () => ok(bodies.events ?? FX.events, { etag: '"ev1"' }),
    osom: () => ok(bodies.osom ?? FX.osom, { etag: '"os1"', "x-amz-meta-lastupdated": new Date(now - MIN).toISOString() }),
    cfa: () => ok(bodies.cfa ?? FX.cfa, { etag: '"cf1"', "last-modified": lm(5 * MIN) }, "application/rss+xml"),
    bom_fdr: () => ok(bodies.bom_fdr ?? FX.idv18555, { "last-modified": lm(HOUR) }, "application/xml"),
    bom_fw: () => ok(bodies.bom_fw ?? FX.idv18560, { "last-modified": lm(HOUR) }, "application/xml"),
    weather: () => ok(bodies.weather ?? FX.openMeteo),
    vicmap: (url) => ok(goodBody("vicmap", url)),
  };
}

export interface Call {
  url: string;
  init?: RequestInit;
}

export interface Upstream {
  fetch: typeof fetch;
  calls: Call[];
  /** Calls whose URL matched no known upstream (they were answered 404). */
  unknown: string[];
}

/** A fetch that routes each URL to its source's responder; `over` replaces some of them. */
export function upstream(now: number, over: Partial<Record<SourceKey, Responder>> = {}, bodies: Partial<Record<SourceKey, string>> = {}): Upstream {
  const routes = { ...healthy(now, bodies), ...over };
  const calls: Call[] = [];
  const unknown: string[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const src = sourceOf(url);
    if (!src) {
      unknown.push(url);
      return new Response("not found", { status: 404 });
    }
    return routes[src](url, init);
  };
  return { fetch: f as typeof fetch, calls, unknown };
}

/** A fetch that never answers: it rejects only when its AbortSignal fires, like a hung upstream. */
export const hang: Responder = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const s = init?.signal;
    if (!s) return;
    if (s.aborted) reject(s.reason);
    else s.addEventListener("abort", () => reject(s.reason));
  });

// ---------------------------------------------------------------------------------------------
// KV and logs

export interface FakeKv {
  kv: KVNamespace;
  data: Map<string, string>;
  puts: { key: string; value: string }[];
  gets: string[];
}

export function fakeKv(): FakeKv {
  const data = new Map<string, string>();
  const puts: FakeKv["puts"] = [];
  const gets: string[] = [];
  const kv = {
    async get(key: string, type?: string) {
      gets.push(key);
      const v = data.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      data.set(key, value);
      puts.push({ key, value });
    },
  };
  return { kv: kv as unknown as KVNamespace, data, puts, gets };
}

export type LogLine = Record<string, unknown>;

/** The last state each source logged, by its `src`. */
export function statesFrom(logs: LogLine[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of logs) if (typeof l.src === "string" && typeof l.state === "string") out[l.src] = l.state;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Events feed editing

type FeedJson = { type: string; properties: Record<string, unknown>; features: unknown[] };

/** The 27 Sep feed (or another), with a new lastUpdated and optionally other features. */
export function eventsBody(o: { lastUpdated?: number | null; features?: unknown[]; base?: string } = {}): string {
  const j = JSON.parse(o.base ?? FX.events) as FeedJson;
  if (o.lastUpdated === null) delete j.properties.lastUpdated;
  else if (o.lastUpdated !== undefined) j.properties.lastUpdated = new Date(o.lastUpdated).toISOString();
  if (o.features) j.features = o.features;
  return JSON.stringify(j);
}

export function baseFeatures(base = FX.events): unknown[] {
  return (JSON.parse(base) as FeedJson).features;
}

/** A point `north` / `east` km from home, [lon, lat]. */
export const at = (h: Home, north: number, east = 0): [number, number] => [
  h.lon + east / (111.32 * Math.cos((h.lat * Math.PI) / 180)),
  h.lat + north / 111.0,
];

/** A square polygon `half` km either side of a point `north` / `east` km from home. */
export function square(h: Home, north: number, east: number, half: number) {
  const ring = [at(h, north - half, east - half), at(h, north - half, east + half), at(h, north + half, east + half), at(h, north + half, east - half), at(h, north - half, east - half)];
  return { type: "Polygon", coordinates: [ring] };
}

// ---------------------------------------------------------------------------------------------
// Template

/** strictFilters, as template.test.ts: TRMNL's Ruby Liquid and LiquidJS must agree. */
const engine = new Liquid({ strictFilters: true });
const parsed = engine.parse(template);

/** TRMNL puts the polling JSON at the root beside its own `trmnl` object; rendered a minute after the payload was made. */
export function render(payload: unknown, ageS = 60): string {
  const p = (payload ?? {}) as Partial<PayloadV1>;
  const trmnl = {
    system: { timestamp_utc: (p.generated_epoch ?? 0) + ageS },
    plugin_settings: { instance_name: "North Warrandyte" },
    user: { time_zone_iana: "Australia/Melbourne" },
  };
  return engine.renderSync(parsed, { ...p, trmnl }) as string;
}

/** Visible text only. */
export const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** A count of zero said about fires, warnings or going fires: never allowed from a source that failed. */
export const ZERO_CLAIM = /\b0 (fires?|warnings?|going)\b/i;
export const RENDER_ERROR = /Liquid error|undefined|\[object Object\]|NaN/;
export const EMAIL = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;

/** The top band, before the mid row. */
export const band = (html: string) => html.slice(html.indexOf('class="fw-band'), html.indexOf('fw-mid">'));

// ---------------------------------------------------------------------------------------------
// Budgets (src/types.ts), for payloads the Worker actually built

export const BUDGET_BYTES = 6144;
export const bytes = (x: unknown) => new TextEncoder().encode(typeof x === "string" ? x : JSON.stringify(x)).byteLength;

/** Every string over its character budget, as "field (n > max): value". */
export function budgetViolations(p: PayloadV1): string[] {
  const out: string[] = [];
  const max = (s: string | undefined, n: number, what: string) => {
    if (s !== undefined && s.length > n) out.push(`${what} (${s.length} > ${n}): ${s}`);
  };
  max(p.checked_local, 12, "checked_local");
  max(p.feed_received_local, 16, "feed_received_local");
  max(p.down_title, 24, "down_title");
  max(p.down_reason, 100, "down_reason");
  max(p.district, 24, "district");
  max(p.neighbours, 38, "neighbours");
  max(p.statewide, 56, "statewide");
  max(p.house.kicker, 36, "kicker");
  max(p.house.level, 17, "level");
  max(p.house.action, 48, "house.action");
  max(p.house.issued, 24, "issued");
  for (const d of p.days) {
    max(d.label, 18, "label");
    max(d.fdr.word, 18, "fdr.word");
    max(d.fdr.action, 46, "fdr.action");
    // ratings.ts ISSUED_MAX: what one line of the 188 px day column holds.
    max(d.fdr.issued, 29, "fdr.issued");
    max(d.tfb.text, 31, "tfb.text");
    max(d.wx.temps, 11, "temps");
    for (const k of ["rh", "wind", "change", "rain"] as const) max(d.wx[k], 18, k);
    max(d.wx.text, 28, "wx.text");
    max(d.wx.src, 28, "wx.src");
    max(d.wx.src_short, 23, "wx.src_short");
  }
  max(p.incidents.heading, 14, "heading");
  max(p.incidents.as_at, 24, "as_at");
  max(p.incidents.empty_text, 80, "empty_text");
  max(p.incidents.error_text, 80, "error_text");
  for (const c of p.incidents.counts ?? []) {
    max(c.n, 3, "n");
    max(c.label, 11, "count label");
    max(c.short, 5, "count short");
  }
  if ((p.incidents.rows?.length ?? 0) > 5) out.push(`rows (${p.incidents.rows!.length} > 5)`);
  for (const r of p.incidents.rows ?? []) {
    max(r.line1, r.upwind ? 32 : 38, "line1");
    max(r.line2, 56, "line2");
  }
  return out;
}
