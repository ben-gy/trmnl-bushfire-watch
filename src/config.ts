/**
 * Request parsing for GET /v1/brief.json. The token is checked before anything else is read. The
 * location comes from a header (TRMNL fills it from its lat_lon field) so it never appears in a URL,
 * and a bad or missing location is an explicit error: there is no default city to fall back to.
 * Messages are shown on the device and never echo the coordinates.
 */
import { districtKey } from "./districts.js";
import type { DistrictKey, Home } from "./types.js";

export interface Env {
  BRIEF_TOKEN?: string;
  DEV?: string;
  ALLOW_QUERY_LOCATION?: string;
  FIRE_KV?: KVNamespace;
}

export type ConfigError = "auth" | "location_missing" | "location_invalid" | "outside_vic" | "not_configured";

export type RequestConfig =
  | { ok: true; home: Home; district: DistrictKey | null /* null = auto */; radiusKm: number; fixture: string | null }
  | { ok: false; error: ConfigError; message: string };

/** Victoria's bounding box. It takes in slivers of NSW and SA; the district lookup finds no district there. */
export const VIC_BOUNDS = { latMin: -39.3, latMax: -33.9, lonMin: 140.9, lonMax: 150.1 } as const;

export const RADIUS_KM = { min: 5, max: 100, default: 30 } as const;

/**
 * Placeholder home for ?fixture= requests, which need no location: each fixture scenario places its
 * own home. The suburb-level test point, never used for live data.
 */
export const FIXTURE_HOME: Home = { lat: -37.73, lon: 145.22 };

type Fail = Extract<RequestConfig, { ok: false }>;
const fail = (error: ConfigError, message: string): Fail => ({ ok: false, error, message });

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant time: both sides are hashed to 32 bytes, then compared with an XOR accumulator. */
export async function tokenMatches(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256(given ?? ""), sha256(expected)]);
  let diff = given === null ? 1 : 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const NUM = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;
const PAIR = new RegExp(`^(${NUM})\\s*(?:[,;]|\\s)\\s*(${NUM})$`);

/** "lat,lon" with any spacing, optional brackets, or percent-encoded; null when it isn't two numbers. */
function parsePair(raw: string): [number, number] | null {
  let s = raw.trim();
  if (s.includes("%")) {
    try {
      s = decodeURIComponent(s).trim();
    } catch {
      return null;
    }
  }
  s = s.replace(/[−‒–]/g, "-").replace(/^[[(]\s*/, "").replace(/\s*[\])]$/, "");
  const m = PAIR.exec(s);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
}

const inVic = (lat: number, lon: number) =>
  lat >= VIC_BOUNDS.latMin && lat <= VIC_BOUNDS.latMax && lon >= VIC_BOUNDS.lonMin && lon <= VIC_BOUNDS.lonMax;

const INVALID = 'Location must be "latitude, longitude" in decimal degrees. Set it in the plugin settings.';

/** Never auto-fixes a swapped or unsigned pair: the user must see and correct the setting. */
function checkLocation(lat: number, lon: number): { ok: true; home: Home } | Fail {
  if (inVic(lat, lon)) return { ok: true, home: { lat, lon } };
  if (inVic(lon, lat)) return fail("location_invalid", "Location looks swapped: enter the latitude (about -34 to -39) first, then the longitude.");
  if (inVic(-lat, lon)) return fail("location_invalid", "Latitude must be negative (south of the equator).");
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return fail("location_invalid", INVALID);
  return fail("outside_vic", "Location is outside Victoria. This dashboard covers Victorian fire districts only.");
}

function readLocation(req: Request, q: URLSearchParams | null): { ok: true; home: Home } | Fail {
  let raw = req.headers.get("x-home-secret");
  if (raw === null || !raw.trim()) {
    const lat = q?.get("lat") ?? null, lon = q?.get("lon") ?? null;
    if (lat === null && lon === null) return fail("location_missing", "Location not set. Set the home location in the plugin settings.");
    if (!lat?.trim() || !lon?.trim()) return fail("location_invalid", INVALID);
    raw = `${lat},${lon}`;
  }
  const pair = parsePair(raw);
  return pair ? checkLocation(pair[0], pair[1]) : fail("location_invalid", INVALID);
}

/** 'auto', empty or missing → null (look it up); an unknown name also means auto. */
function readDistrict(raw: string | null): DistrictKey | null {
  if (raw === null || !raw.trim() || raw.trim().toLowerCase() === "auto") return null;
  return districtKey(raw);
}

/** Whole kilometres, clamped to 5–100; missing or non-numeric → 30. */
function readRadius(raw: string | null): number {
  if (raw === null || !raw.trim()) return RADIUS_KM.default;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return RADIUS_KM.default;
  return Math.min(RADIUS_KM.max, Math.max(RADIUS_KM.min, Math.round(n)));
}

export async function parseRequest(req: Request, env: Env): Promise<RequestConfig> {
  if (!env.BRIEF_TOKEN) return fail("not_configured", "BRIEF_TOKEN is not set on the Worker");
  if (!(await tokenMatches(req.headers.get("x-brief-token"), env.BRIEF_TOKEN))) {
    return fail("auth", "Access token missing or wrong. Check the plugin's Worker access token.");
  }
  const url = new URL(req.url);
  // Query strings end up in request logs, so only `wrangler dev` accepts a location there.
  const q = env.ALLOW_QUERY_LOCATION === "1" ? url.searchParams : null;
  const district = readDistrict(req.headers.get("x-district") ?? q?.get("district") ?? null);
  const radiusKm = readRadius(req.headers.get("x-radius-km") ?? q?.get("radius_km") ?? null);
  const fx = url.searchParams.get("fixture");
  const fixture = fx !== null && /^[a-z0-9-]{1,32}$/.test(fx) ? fx : null;
  if (fixture) return { ok: true, home: FIXTURE_HOME, district, radiusKm, fixture };
  const loc = readLocation(req, q);
  if (!loc.ok) return loc;
  return { ok: true, home: loc.home, district, radiusKm, fixture: null };
}
