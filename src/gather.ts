/**
 * Fetches every upstream for one house in parallel, within one wall-clock deadline. Nothing here
 * throws: each source comes back with its own state, and the payload decides what a missing one means.
 */
import { getSource, lastKnown, type SourceSpec, type WaitUntil, withTimeout } from "./store.js";
import { specs } from "./sources/specs.js";
import { lookupDistrict } from "./sources/vicmap.js";
import type { BomFdr, BomFw, Deps, DistrictKey, DistrictLookup, EventsFeed, Home, RatingsFeed, SourceResult, SourceState, Weather } from "./types.js";

/** The plan allows 7 s per poll; this leaves room to build and send the payload. */
export const BUDGET_MS = 6500;
/** How long past the deadline gather waits for a step that ignored it before answering without it. */
const LATE_MS = 250;

export interface DistrictResult {
  lookup: DistrictLookup;
  state: SourceState;
  source: "override" | "vicmap" | "none";
}

export interface Gathered {
  now: number;
  home: Home;
  radiusKm: number;
  district: DistrictResult;
  events: SourceResult<EventsFeed>;
  osom: SourceResult<RatingsFeed>;
  cfa: SourceResult<RatingsFeed>;
  bomFdr: SourceResult<BomFdr>;
  bomFw: SourceResult<BomFw>;
  weather: SourceResult<Weather>;
}

async function sha256Hex(s: string, n = 16): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d.slice(0, n), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the district is without Vicmap: the one picked in the settings, or unknown (never guessed). */
function withoutVicmap(override: DistrictKey | null): DistrictResult {
  return override
    ? { lookup: { key: override, lga: null, neighbours: [] }, state: "ok", source: "override" }
    : { lookup: { key: null, lga: null, neighbours: [] }, state: "unavailable", source: "none" };
}

/** `p`, or `fallback()` once the deadline (plus a little) has passed, or if `p` rejects. */
async function by<V>(p: Promise<V>, deadline: number, fallback: () => V): Promise<V> {
  const safe = p.catch((): undefined => undefined);
  return (await withTimeout(safe, Math.max(0, deadline - Date.now()) + LATE_MS)) ?? fallback();
}

/**
 * The house's district. A district picked in the plugin settings wins, but Vicmap is still asked for
 * the council (BoM's per-council fire weather) and the neighbouring districts inside the radius; if
 * Vicmap puts the house in a different district from the one picked, that one becomes a neighbour.
 */
export async function resolveDistrict(
  home: Home,
  radiusKm: number,
  override: DistrictKey | null,
  deps: Deps,
  opts: { deadline?: number; waitUntil?: WaitUntil } = {},
): Promise<DistrictResult> {
  const found = await lookupDistrict(home, radiusKm, deps, opts);
  if (!override) return found;
  const others = [found.lookup.key, ...found.lookup.neighbours].filter((k): k is DistrictKey => k !== null && k !== override);
  return { lookup: { key: override, lga: found.lookup.lga, neighbours: [...new Set(others)] }, state: "ok", source: "override" };
}

export async function gather(
  cfg: { home: Home; district: DistrictKey | null; radiusKm: number },
  deps: Deps,
  /** `budgetMs` (default BUDGET_MS) is for tests. */
  opts: { waitUntil?: WaitUntil; prefix?: string; district?: DistrictResult; budgetMs?: number } = {},
): Promise<Gathered> {
  // Wall clock: deps.now() is the data clock, which fixtures and tests freeze.
  const deadline = Date.now() + (opts.budgetMs ?? BUDGET_MS);
  const now = deps.now();
  const weatherKey = await sha256Hex(`${cfg.home.lat.toFixed(2)},${cfg.home.lon.toFixed(2)}`);
  const s = specs(cfg.home, weatherKey, opts.prefix);
  const o = { waitUntil: opts.waitUntil, deadline };
  // Each source is bounded by the deadline itself; `by` answers for one that isn't, from memory only.
  const get = <T>(spec: SourceSpec<T>) => by(getSource(spec, deps, o), deadline, () => lastKnown(spec, now, "timeout"));
  const [district, events, osom, cfa, bomFdr, bomFw, weather] = await Promise.all([
    opts.district ? Promise.resolve(opts.district) : by(resolveDistrict(cfg.home, cfg.radiusKm, cfg.district, deps, o), deadline, () => withoutVicmap(cfg.district)),
    get(s.events),
    get(s.osom),
    get(s.cfa),
    get(s.bomFdr),
    get(s.bomFw),
    get(s.weather),
  ]);
  return { now, home: cfg.home, radiusKm: cfg.radiusKm, district, events, osom, cfa, bomFdr, bomFw, weather };
}
