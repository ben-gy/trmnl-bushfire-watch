/**
 * House → fire district, LGA and neighbouring districts, from Vicmap's public WFS (State of Victoria,
 * CC BY 4.0). Points are POINT(lon lat) with SRID=4283: the other axis order silently returns nothing.
 * Coordinates go out at 3 dp (~100 m) because Kinglake sits 0.7 km from the Central border. Only a
 * complete answer is cached (30 days, per radius); until then every poll asks again. Logs never hold
 * the location; the KV key is an unsalted SHA-256 of the rounded point, which a reader of the KV
 * could reverse by brute force.
 *
 * DWITHIN honours metres (verified live 27 Sep 2026): from the suburb, North Central first appears
 * between 22 and 23 km; from Kinglake, Central appears between 0.5 and 1 km. "degrees" is rejected.
 */
import { districtKey, normKey } from "../districts.js";
import { budget, fetchText, readRecord, type WaitUntil, writeRecord } from "../store.js";
import type { Deps, DistrictKey, DistrictLookup, Home, SourceState } from "../types.js";

const WFS = "https://opendata.maps.vic.gov.au/geoserver/wfs";
const TIMEOUT_MS = 4000;
const FRESH_MS = 30 * 24 * 3600_000;
/** Boundaries almost never move, so an old lookup outlives a Vicmap outage. */
const KEEP_S = 90 * 24 * 3600;

function wfsUrl(layer: string, property: string, filter: string): string {
  return (
    `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=open-data-platform:${layer}` +
    `&outputFormat=application/json&propertyName=${property}&cql_filter=${encodeURIComponent(filter)}`
  );
}

const point = (h: Home) => `SRID=4283;POINT(${h.lon.toFixed(3)} ${h.lat.toFixed(3)})`;

export function districtUrl(home: Home): string {
  return wfsUrl("cfa_tfb_district", "tfb_district", `INTERSECTS(geom,${point(home)})`);
}

export function lgaUrl(home: Home): string {
  return wfsUrl("vmlite_lga", "lga_name", `INTERSECTS(geom,${point(home)})`);
}

export function neighboursUrl(home: Home, radiusKm: number): string {
  return wfsUrl("cfa_tfb_district", "tfb_district", `DWITHIN(geom,${point(home)},${Math.round(radiusKm * 1000)},meters)`);
}

/** Each feature's properties; undefined when this isn't a GeoJSON FeatureCollection. */
function properties(json: unknown): Record<string, unknown>[] | undefined {
  if (!json || typeof json !== "object") return undefined;
  const fc = json as { type?: unknown; features?: unknown };
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const f of fc.features) {
    const p = (f as { properties?: unknown } | null)?.properties;
    if (!p || typeof p !== "object") return undefined;
    out.push(p as Record<string, unknown>);
  }
  return out;
}

/** undefined = bad document or an unknown district name; null = no single district (none, or on a border). */
export function parseDistrict(json: unknown): DistrictKey | null | undefined {
  const ps = properties(json);
  if (!ps) return undefined;
  const keys = new Set<DistrictKey>();
  for (const p of ps) {
    const k = districtKey(p.tfb_district);
    if (!k) return undefined;
    keys.add(k);
  }
  return keys.size === 1 ? [...keys][0]! : null;
}

/** normKey(lga_name), e.g. "nillumbik". null = none (unincorporated areas) or ambiguous. */
export function parseLga(json: unknown): string | null | undefined {
  const ps = properties(json);
  if (!ps) return undefined;
  const names = new Set<string>();
  for (const p of ps) {
    if (typeof p.lga_name !== "string") return undefined;
    const n = normKey(p.lga_name);
    if (!n) return undefined;
    names.add(n);
  }
  return names.size === 1 ? [...names][0]! : null;
}

/** Every district within the radius, the home district included, in the order Vicmap lists them. */
export function parseNeighbours(json: unknown): DistrictKey[] | undefined {
  const ps = properties(json);
  if (!ps) return undefined;
  const out: DistrictKey[] = [];
  for (const p of ps) {
    const k = districtKey(p.tfb_district);
    if (!k) return undefined;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

interface Cached {
  v: 1;
  at: number;
  lookup: DistrictLookup;
}

function isCached(x: unknown): x is Cached {
  if (!x || typeof x !== "object") return false;
  const c = x as { v?: unknown; at?: unknown; lookup?: Partial<DistrictLookup> | null };
  const l = c.lookup;
  return (
    c.v === 1 &&
    typeof c.at === "number" &&
    Number.isFinite(c.at) &&
    !!l &&
    typeof l.key === "string" &&
    districtKey(l.key) === l.key &&
    (l.lga === null || typeof l.lga === "string") &&
    Array.isArray(l.neighbours) &&
    l.neighbours.every((k) => typeof k === "string" && districtKey(k) === k)
  );
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function query<T>(
  url: string,
  parse: (json: unknown) => T | undefined,
  deps: Deps,
  deadline: number | undefined,
): Promise<{ http: number; value: T | undefined; error: string | null }> {
  const r = await fetchText(url, deps, { timeoutMs: budget(TIMEOUT_MS, deadline), headers: { Accept: "application/json" }, maxBytes: 1024 * 1024 });
  if (r.body === null) return { http: r.status, value: undefined, error: r.error ?? `http ${r.status}` };
  let json: unknown;
  try {
    json = JSON.parse(r.body);
  } catch {
    return { http: r.status, value: undefined, error: "bad document" };
  }
  const value = parse(json);
  return { http: r.status, value, error: value === undefined ? "bad document" : null };
}

type Lookup = { lookup: DistrictLookup; state: SourceState; source: "vicmap" | "none" };

const NONE: DistrictLookup = { key: null, lga: null, neighbours: [] };

/**
 * The house's district from Vicmap, cached 30 days (a district picked in the settings is applied by
 * gather's resolveDistrict). A failed refresh falls back to an older lookup ('stale'), and with none
 * the district is unknown — never guessed.
 * Bounded by `deadline` (wall clock): the KV read and queries are cut to fit, and the cache write goes
 * to waitUntil or is waited for no longer than the time left.
 */
export async function lookupDistrict(
  home: Home,
  radiusKm: number,
  deps: Deps,
  opts: { deadline?: number; waitUntil?: WaitUntil } = {},
): Promise<Lookup> {
  const t0 = Date.now();
  let out: Lookup = { lookup: NONE, state: "unavailable", source: "none" };
  let http: number | null = null;
  let error: string | null = null;
  let hit = false;
  try {
    const now = deps.now();
    const key = "district:" + (await sha256Hex(`${home.lat.toFixed(3)},${home.lon.toFixed(3)},${radiusKm}`));
    const cached = await readRecord(key, deps, isCached, { deadline: opts.deadline });
    if (cached && cached.at <= now && now - cached.at < FRESH_MS) {
      hit = true;
      out = { lookup: cached.lookup, state: "ok", source: "vicmap" };
    } else {
      const [d, l, n] = await Promise.all([
        query(districtUrl(home), parseDistrict, deps, opts.deadline),
        query(lgaUrl(home), parseLga, deps, opts.deadline),
        query(neighboursUrl(home, radiusKm), parseNeighbours, deps, opts.deadline),
      ]);
      http = d.http;
      error = d.error ?? l.error ?? n.error;
      if (d.value) {
        const lookup: DistrictLookup = {
          key: d.value,
          lga: l.value ?? null,
          neighbours: (n.value ?? []).filter((k) => k !== d.value),
        };
        out = { lookup, state: "ok", source: "vicmap" };
        // Only a complete answer is kept for 30 days; a partial one is retried next poll.
        if (l.value !== undefined && n.value !== undefined) {
          await writeRecord(key, { v: 1, at: now, lookup } satisfies Cached, deps, KEEP_S, { deadline: opts.deadline, waitUntil: opts.waitUntil });
        }
      } else {
        error ??= "no district";
        if (cached) out = { lookup: cached.lookup, state: "stale", source: "vicmap" };
      }
    }
  } catch {
    error = "internal error";
  }
  try {
    deps.log({ src: "district", http, ms: Date.now() - t0, state: out.state, error, ...(hit ? { hit } : {}) });
  } catch {
    /* logging must not break a poll */
  }
  return out;
}
