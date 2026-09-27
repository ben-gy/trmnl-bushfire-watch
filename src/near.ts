/**
 * What is around one house: warnings over it and near it, fires (deduplicated), planned burns and
 * other emergency calls within the radius. Warnings and anything with polygons are measured by
 * polygon (label points ignored); nothing with a bad coordinate is dropped silently, it is counted
 * as unlocated instead. Warnings are never merged into incidents, and a warning's embedded
 * incidentFeatures are never counted (the parser does not even keep them).
 */
import { fireRank, isVegetation, statusBucket } from "./classify.js";
import { bboxDistanceKm, frame, haversineKm, measure, toXY } from "./geo.js";
import type { Agency, EventsFeed, Geo, Home, LonLat, NormFeature, StatusBucket } from "./types.js";

export interface NearItem {
  f: NormFeature;
  km: number;
  bearing: number | null;
  inArea: boolean;
  /** Point-only warning: distance from its point, not its area. */
  approx: boolean;
}

export interface FireCluster {
  /** The CFA report when there is one (its location is a road name), else the most severe. */
  lead: NormFeature;
  members: NormFeature[];
  /** The most severe member status. */
  status: string;
  rank: 0 | 1 | 2 | 3;
  bucket: StatusBucket;
  veg: boolean;
  /** Nearest member. */
  km: number;
  bearing: number | null;
  agencies: Agency[];
  /** Jobs at this spot: the largest group of one agency's repeat jobs (a cross-agency duplicate counts once). */
  count: number;
}

export interface NearSummary {
  /**
   * Local warnings whose area contains home, plus statewide ones at Watch and Act or above. Most
   * severe first; at equal severity a local warning before a statewide one (its instruction is about
   * this house), then newest.
   */
  houseWarnings: NearItem[];
  /** Local warnings within the radius (point-only ones within max(radius, 50 km), approx), not over home. Most severe, then nearest, first. */
  nearbyWarnings: NearItem[];
  /** statewide 'Y' warnings: they cover every house. */
  statewide: NearItem[];
  /** Local warnings with no usable coordinate: they may cover the house. Most severe, then newest, first. */
  unlocatedWarningList: NormFeature[];
  /** unlocatedWarningList.length. */
  unlocatedWarnings: number;
  /** BoM Met features whose polygon contains home: listed, never counted. */
  met: NearItem[];
  /** FDR / TFB pseudo-incidents containing home, for cross-checking the rating. */
  areaProducts: NearItem[];
  /** Clusters within the radius that are not safe: rank, then vegetation, then distance. */
  fires: FireCluster[];
  safeFires: number;
  burns: NearItem[];
  /** Non-fire CFA calls within the radius. */
  otherCfa: number;
  /** Non-fire calls from every agency within the radius (information only). */
  otherCalls: number;
  /** Unclassified features within the radius or with no usable coordinate. */
  unclassified: number;
  /** Fires, burns and other calls with no usable coordinate. */
  unlocated: number;
  /** When no active fire is within the radius, the nearest active one within 100 km, so "0" never reads as "nothing around". */
  nearestActiveBeyond: { km: number; bearing: number | null; what: string; where: string; status: string } | null;
}

/** A point-only warning's area can reach well past its label point. */
const APPROX_MIN_KM = 50;
const NEAREST_ACTIVE_KM = 100;
const MERGE_KM = 3;
const MERGE_MS = 12 * 3600_000;
const REPEAT_KM = 0.3;
const REPEAT_MS = 3 * 3600_000;
/** Australia, generously. A coordinate outside it is bad data (a swapped pair), not a distant incident. */
const AU: [number, number, number, number] = [110, -45, 160, -9];

const located = (g: Geo): boolean =>
  g.bbox !== null && g.bbox[2] >= AU[0] && g.bbox[0] <= AU[2] && g.bbox[3] >= AU[1] && g.bbox[1] <= AU[3];

/** An unrecognised warning level sorts just below Emergency Warning. */
const sev = (f: NormFeature): number => (f.levelRaw ? Math.max(f.level ?? 2, 2.5) : (f.level ?? 2));
/** Newest first; an unknown time sorts last. */
const newest = (a: NormFeature, b: NormFeature) => (b.updated ?? 0) - (a.updated ?? 0);

/** `_now` is unused today: every time window here is between features' own timestamps. */
export function buildNear(feed: EventsFeed, home: Home, radiusKm: number, _now: number): NearSummary {
  const out: NearSummary = {
    houseWarnings: [],
    nearbyWarnings: [],
    statewide: [],
    unlocatedWarningList: [],
    unlocatedWarnings: 0,
    met: [],
    areaProducts: [],
    fires: [],
    safeFires: 0,
    burns: [],
    otherCfa: 0,
    otherCalls: 0,
    unclassified: 0,
    unlocated: 0,
    nearestActiveBeyond: null,
  };
  const fr = frame(home);
  const fireKm = Math.max(radiusKm, NEAREST_ACTIVE_KM) + MERGE_KM;
  const fires: NearItem[] = [];
  const seen = new Set<string>();

  const unlocated = (f: NormFeature) => {
    if (f.kind === "warning") out.unlocatedWarningList.push(f);
    else if (f.kind === "unclassified") out.unclassified++;
    else if (f.kind === "fire" || f.kind === "burn" || f.kind === "other") out.unlocated++;
  };

  for (const f of feed.features) {
    const key = `${f.kind}|${f.feed}|${f.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (f.kind === "earthquake") continue;

    if (f.kind === "warning" && f.statewide) {
      const it: NearItem = { f, km: 0, bearing: null, inArea: true, approx: false };
      out.statewide.push(it);
      if ((f.level ?? 2) >= 2) out.houseWarnings.push(it);
      continue;
    }
    if (!located(f.geo)) {
      unlocated(f);
      continue;
    }
    const approx = f.kind === "warning" && f.geo.polygons.length === 0;
    const limit =
      f.kind === "fire" ? fireKm
      : approx ? Math.max(radiusKm, APPROX_MIN_KM)
      : f.kind === "met_warning" || f.kind === "area_product" ? 0
      : radiusKm;
    if (bboxDistanceKm(fr, f.geo.bbox) > limit + 1) continue;
    const m = measure(home, f.geo);
    if (!m) {
      unlocated(f);
      continue;
    }
    const it: NearItem = { f, km: m.km, bearing: m.bearing, inArea: m.inArea, approx };
    switch (f.kind) {
      case "warning":
        if (m.inArea) out.houseWarnings.push(it);
        else if (m.km <= limit) out.nearbyWarnings.push(it);
        break;
      case "met_warning":
        if (m.inArea && m.via === "polygon") out.met.push(it);
        break;
      case "area_product":
        if (m.inArea && m.via === "polygon") out.areaProducts.push(it);
        break;
      case "burn":
        if (m.km <= radiusKm) out.burns.push(it);
        break;
      case "fire":
        if (m.km <= fireKm) fires.push(it);
        break;
      case "other":
        if (m.km <= radiusKm) {
          out.otherCalls++;
          if (f.agency === "CFA" || f.feed.startsWith("cfa-")) out.otherCfa++;
        }
        break;
      case "unclassified":
        if (m.km <= radiusKm) out.unclassified++;
        break;
    }
  }

  out.houseWarnings.sort((a, b) => sev(b.f) - sev(a.f) || Number(a.f.statewide) - Number(b.f.statewide) || newest(a.f, b.f));
  out.nearbyWarnings.sort((a, b) => sev(b.f) - sev(a.f) || a.km - b.km);
  out.statewide.sort((a, b) => sev(b.f) - sev(a.f) || newest(a.f, b.f));
  out.burns.sort((a, b) => a.km - b.km);
  out.unlocatedWarningList.sort((a, b) => sev(b) - sev(a) || newest(a, b));
  out.unlocatedWarnings = out.unlocatedWarningList.length;

  const clusters = clusterFires(fires, fr);
  for (const c of clusters) {
    if (c.km > radiusKm) continue;
    if (c.bucket === "safe") out.safeFires++;
    else out.fires.push(c);
  }
  out.fires.sort((a, b) => b.rank - a.rank || Number(b.veg) - Number(a.veg) || a.km - b.km);

  if (!out.fires.some((c) => c.bucket === "active")) {
    const near = clusters
      .filter((c) => c.bucket === "active" && c.km <= NEAREST_ACTIVE_KM)
      .sort((a, b) => a.km - b.km)[0];
    if (near) {
      const { lead } = near;
      out.nearestActiveBeyond = {
        km: near.km,
        bearing: near.bearing,
        what: lead.event || lead.cat2 || "Fire",
        where: lead.location,
        status: near.status,
      };
    }
  }
  return out;
}

/** A fire's position for deduplication: its first point, else the centre of its extent. */
function position(g: Geo): LonLat {
  const p = g.points[0];
  if (p) return p;
  const b = g.bbox!;
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

const within = (a: number | null, b: number | null, ms: number) => a !== null && b !== null && Math.abs(a - b) <= ms;

/**
 * Two passes, both biased against undercounting:
 * 1. Repeat jobs of one agency at one spot (≤ 0.3 km, same category2, updated ≤ 3 h apart) become one group.
 * 2. Groups from different agencies merge when two members are ≤ 3 km and created ≤ 12 h apart,
 *    closest pairs first, and never when that would put two groups of one agency together (a DEECA
 *    report between two separate CFA fires must not fuse them).
 * Unknown times never merge.
 */
function clusterFires(items: NearItem[], fr: ReturnType<typeof frame>): FireCluster[] {
  const n = items.length;
  const pos = items.map((it) => position(it.f.geo));
  const x = pos.map((p) => toXY(fr, p)[0]);
  const order = items.map((_, i) => i).sort((a, b) => x[a]! - x[b]!);

  const pairs: { i: number; j: number; km: number }[] = [];
  for (let a = 0; a < n; a++) {
    const i = order[a]!;
    for (let b = a + 1; b < n; b++) {
      const j = order[b]!;
      if (x[j]! - x[i]! > MERGE_KM + 0.5) break;
      const km = haversineKm({ lat: pos[i]![1], lon: pos[i]![0] }, { lat: pos[j]![1], lon: pos[j]![0] });
      if (km <= MERGE_KM) pairs.push({ i, j, km });
    }
  }

  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };

  // Pass 1: repeat jobs of one agency.
  for (const { i, j, km } of pairs) {
    const a = items[i]!.f, b = items[j]!.f;
    if (
      a.agency === b.agency &&
      km <= REPEAT_KM &&
      a.cat2.toLowerCase() === b.cat2.toLowerCase() &&
      within(a.updated, b.updated, REPEAT_MS)
    ) {
      parent[find(j)] = find(i);
    }
  }
  const groupOf = items.map((_, i) => find(i));
  const groupSize = new Map<number, number>();
  for (const g of groupOf) groupSize.set(g, (groupSize.get(g) ?? 0) + 1);

  // Pass 2: the same fire reported by two agencies.
  const agencies = new Map<number, Set<Agency>>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!agencies.has(r)) agencies.set(r, new Set());
    agencies.get(r)!.add(items[i]!.f.agency);
  }
  pairs.sort((p, q) => p.km - q.km);
  for (const { i, j } of pairs) {
    const a = items[i]!.f, b = items[j]!.f;
    if (a.agency === b.agency || !within(a.created, b.created, MERGE_MS)) continue;
    const ra = find(i), rb = find(j);
    if (ra === rb) continue;
    const sa = agencies.get(ra)!, sb = agencies.get(rb)!;
    if ([...sb].some((g) => sa.has(g))) continue;
    parent[rb] = ra;
    for (const g of sb) sa.add(g);
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = byRoot.get(r);
    if (list) list.push(i);
    else byRoot.set(r, [i]);
  }

  const out: FireCluster[] = [];
  for (const idx of byRoot.values()) {
    const its = idx.map((i) => items[i]!);
    const severity = (it: NearItem) => fireRank(it.f.status);
    const bySeverity = [...its].sort((a, b) => severity(b) - severity(a) || newest(a.f, b.f) || a.km - b.km);
    const worst = bySeverity[0]!;
    const lead = bySeverity.find((it) => it.f.agency === "CFA") ?? worst;
    const status = severity(lead) === severity(worst) ? lead.f.status : worst.f.status;
    const nearest = its.reduce((m, it) => (it.km < m.km ? it : m));
    const members = [lead.f, ...bySeverity.filter((it) => it !== lead).map((it) => it.f)];
    const ag: Agency[] = [];
    for (const f of members) if (!ag.includes(f.agency)) ag.push(f.agency);
    out.push({
      lead: lead.f,
      members,
      status,
      rank: fireRank(status),
      bucket: statusBucket(status),
      veg: members.some((f) => isVegetation(f.cat2)),
      km: nearest.km,
      bearing: nearest.bearing,
      agencies: ag,
      count: idx.reduce((m, i) => Math.max(m, groupSize.get(groupOf[i]!) ?? 1), 1),
    });
  }
  return out;
}
