/**
 * Distances around one house. Warning areas are measured by their polygons (inside ⇒ 0 km, else the
 * nearest edge); a warning's label point is never used when a polygon exists. On 9 Jan 2026 a label
 * point put an Emergency Warning 28.3 km from Kinglake when its edge was 9.7 km away.
 *
 * Coordinates are GeoJSON order, [lon, lat]. The local projection is Mapbox's cheap-ruler (WGS84),
 * which is accurate to about 0.1% within a few hundred km.
 */
import type { Geo, Home, LonLat } from "./types.js";

const RAD = Math.PI / 180;

export interface Frame {
  lat0: number;
  lon0: number;
  kx: number;
  ky: number;
}

export function frame(home: Home): Frame {
  const RE = 6378.137, FE = 1 / 298.257223563, E2 = FE * (2 - FE);
  const c = Math.cos(home.lat * RAD), w2 = 1 / (1 - E2 * (1 - c * c)), w = Math.sqrt(w2);
  return { lat0: home.lat, lon0: home.lon, kx: RAD * RE * w * c, ky: RAD * RE * w * w2 * (1 - E2) };
}

export function toXY(f: Frame, p: LonLat): [number, number] {
  let dLon = p[0] - f.lon0;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  return [dLon * f.kx, (p[1] - f.lat0) * f.ky];
}

export function haversineKm(a: Home, b: Home): number {
  const R = 6371.0088;
  const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial great-circle bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a: Home, b: Home): number {
  const φ1 = a.lat * RAD, φ2 = b.lat * RAD, Δλ = (b.lon - a.lon) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const C16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"] as const;
export function compass16(deg: number): string {
  return C16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}

/** Smallest angle between two bearings, 0–180. */
export function angDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Ray cast from the origin along +x. A point exactly on an edge may go either way; callers add a tolerance. */
export function ringContainsOrigin(ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > 0 !== yj > 0) {
      const x = xi + ((0 - yi) * (xj - xi)) / (yj - yi);
      if (x > 0) inside = !inside;
    }
  }
  return inside;
}

/** Nearest point to the origin on segment ab. */
export function nearestOnSegment(a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return a;
  const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2));
  return [a[0] + t * dx, a[1] + t * dy];
}

const finite = (p: unknown): p is LonLat =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && !(p[0] === 0 && p[1] === 0);

/** Collects points and polygons from any GeoJSON geometry, recursing into collections. Bad coordinates are dropped. */
export function extractGeo(g: unknown): Geo {
  const out: Geo = { points: [], polygons: [], bbox: null };
  const ring = (r: unknown): LonLat[] | null => {
    if (!Array.isArray(r)) return null;
    const pts = r.filter(finite).map((p) => [p[0], p[1]] as LonLat);
    return pts.length >= 3 ? pts : null;
  };
  const poly = (c: unknown) => {
    if (!Array.isArray(c)) return;
    const rings = c.map(ring);
    if (!rings[0]) return;
    out.polygons.push(rings.filter((r): r is LonLat[] => r !== null));
  };
  const walk = (x: unknown, depth: number) => {
    if (!x || typeof x !== "object" || depth > 4) return;
    const o = x as { type?: unknown; coordinates?: unknown; geometries?: unknown };
    switch (o.type) {
      case "Point":
        if (finite(o.coordinates)) out.points.push([o.coordinates[0], o.coordinates[1]]);
        break;
      case "MultiPoint":
        if (Array.isArray(o.coordinates)) for (const p of o.coordinates) if (finite(p)) out.points.push([p[0], p[1]]);
        break;
      case "Polygon":
        poly(o.coordinates);
        break;
      case "MultiPolygon":
        if (Array.isArray(o.coordinates)) for (const c of o.coordinates) poly(c);
        break;
      case "GeometryCollection":
        if (Array.isArray(o.geometries)) for (const c of o.geometries) walk(c, depth + 1);
        break;
    }
  };
  walk(g, 0);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p: LonLat) => {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  };
  out.points.forEach(add);
  for (const pg of out.polygons) for (const r of pg) r.forEach(add);
  if (minX <= maxX) out.bbox = [minX, minY, maxX, maxY];
  return out;
}

/** Lower bound on the distance from home to anything inside the bbox, km. */
export function bboxDistanceKm(f: Frame, bbox: Geo["bbox"]): number {
  if (!bbox) return Infinity;
  const [x0, y0] = toXY(f, [bbox[0], bbox[1]]);
  const [x1, y1] = toXY(f, [bbox[2], bbox[3]]);
  const dx = x0 > 0 ? x0 : x1 < 0 ? -x1 : 0;
  const dy = y0 > 0 ? y0 : y1 < 0 ? -y1 : 0;
  // The projection shrinks slightly away from home's latitude; stay a lower bound.
  return Math.hypot(dx, dy) * 0.98;
}

export interface Measure {
  km: number;
  /** Bearing from home to the nearest point, or null when home is inside. */
  bearing: number | null;
  /** Inside a polygon (not in a hole), or within `edgeKm` of its edge. */
  inArea: boolean;
  via: "polygon" | "point";
}

/**
 * Distance from home to a feature. With any polygon, only polygons count: 0 km inside the outer ring
 * and outside every hole, otherwise the nearest edge (hole edges included). Point-only features use
 * the nearest point. Null when the feature has no usable coordinate.
 */
export function measure(home: Home, g: Geo, edgeKm = 0.2): Measure | null {
  const f = frame(home);
  if (g.polygons.length) {
    let best = Infinity, bestPt: [number, number] | null = null, inside = false;
    for (const pg of g.polygons) {
      const rings = pg.map((r) => r.map((p) => toXY(f, p)));
      const outer = rings[0]!;
      if (ringContainsOrigin(outer) && !rings.slice(1).some(ringContainsOrigin)) inside = true;
      for (const r of rings) {
        for (let i = 0; i < r.length; i++) {
          const a = r[i]!, b = r[(i + 1) % r.length]!;
          const q = nearestOnSegment(a, b);
          const d = Math.hypot(q[0], q[1]);
          if (d < best) {
            best = d;
            bestPt = q;
          }
        }
      }
    }
    if (inside) return { km: 0, bearing: null, inArea: true, via: "polygon" };
    if (!bestPt) return null;
    const bearing = (Math.atan2(bestPt[0], bestPt[1]) / RAD + 360) % 360;
    return { km: best, bearing, inArea: best <= edgeKm, via: "polygon" };
  }
  if (g.points.length) {
    let best = Infinity, bestP: LonLat | null = null;
    for (const p of g.points) {
      const d = haversineKm(home, { lat: p[1], lon: p[0] });
      if (d < best) {
        best = d;
        bestP = p;
      }
    }
    if (!bestP) return null;
    return { km: best, bearing: best < 0.05 ? null : bearingDeg(home, { lat: bestP[1], lon: bestP[0] }), inArea: false, via: "point" };
  }
  return null;
}
