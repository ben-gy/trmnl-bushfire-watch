/**
 * Shared types: the payload TRMNL renders (merge variables, v1) and the normalised models the
 * sources produce. Everything stored in KV is one of the normalised models, so they are plain JSON
 * (records, not Maps) and never carry personal data from the feeds.
 */

// ---------------------------------------------------------------------------------------------
// Payload v1: the merge variables. One polling URL, so these keys sit at the Liquid root.
// Strings are pre-formatted in Australia/Melbourne time and pre-truncated to the template's budgets.

export interface PayloadV1 {
  v: 1;
  /** false ⇒ the template shows a full-screen DATA UNAVAILABLE / CONFIGURATION ERROR. */
  ok: boolean;
  /** Fixture or sample data: the template watermarks "SAMPLE DATA · NOT LIVE". */
  sample?: boolean;
  /** Worker clock, UNIX seconds, minute resolution. The template flips to OUT OF DATE after 60 min. */
  generated_epoch: number;
  /** "Sun 16:05". Changes every poll so TRMNL always re-renders. */
  checked_local: string;
  /** When the VicEmergency feed says it was last updated, "Sun 16:04" (licence: must be shown). */
  feed_received_local: string;
  /** Only when ok is false. */
  down_title?: string;
  down_reason?: string;
  last_good_local?: string;
  /** "Central", or "District unknown". */
  district: string;
  radius_km: number;
  /** A neighbouring district inside the radius, e.g. "North Central: MODERATE · No TFB" (≤ 38), or "". */
  neighbours: string;
  /** Statewide warnings that don't take the band: "Statewide: Extreme Heat (Advice) +1" (≤ 56), or "". */
  statewide: string;
  house: House;
  days: [Day, Day];
  incidents: Incidents;
  attribution: string;
  disclaimer: string;
}

export interface House {
  /** unknown ⇒ the warnings feed is unusable ⇒ "WARNINGS UNAVAILABLE". */
  status: "in_warning" | "clear" | "unknown";
  /** 3 Emergency Warning (and evacuate variants), 2 Watch and Act, 1 Advice, 0 other. */
  rank?: 0 | 1 | 2 | 3;
  /** "YOU ARE IN A WARNING AREA · BUSHFIRE" (≤ 36, upper case). */
  kicker?: string;
  /** Official level, upper case: "EMERGENCY WARNING" (≤ 17). */
  level?: string;
  /** Official action verbatim, then places: "TAKE SHELTER NOW · Creightons Creek +13" (≤ 48). */
  action?: string;
  /** "Issued 16:58 · +1 more" or "LAST KNOWN 12:05" (≤ 24). */
  issued?: string;
}

export interface Day {
  /** "TODAY · SUN 27 SEP" / "TOMORROW · MON 28" (≤ 18). */
  label: string;
  fdr: {
    /** -1 unavailable, 0 No Rating, 1 Moderate, 2 High, 3 Extreme, 4 Catastrophic. */
    level: -1 | 0 | 1 | 2 | 3 | 4;
    /** "NO RATING" | "MODERATE" | … | "NO RATING ISSUED" | "RATING UNAVAILABLE" | a raw unrecognised word (≤ 18). */
    word: string;
    /** Official AFDRS action (≤ 46), or where to check when unavailable. */
    action: string;
    /** "FBI 12 · BoM Sun 05:30", a disagreement note, or "LAST KNOWN 14:05" when only stale sources rate it (≤ 29). */
    issued: string;
  };
  tfb: {
    state: "declared" | "none" | "pending" | "unknown";
    /** "TOTAL FIRE BAN" | "TOTAL FIRE BAN · as of 14:05" (stale) | "No TFB · restrictions may apply" | "No TFB declared yet" | "TFB status unclear" | "TFB status unavailable" (≤ 31). */
    text: string;
  };
  wx: {
    /** false ⇒ "Forecast unavailable" (never 0° or 0%). */
    ok: boolean;
    temps?: string; // "44° / 27°" (≤ 11)
    rh?: string; // "RH min 6%" (≤ 18)
    wind?: string; // "NNW 55 G90 km/h" (≤ 18)
    change?: string; // "SW change ~15:00" (≤ 18); "" when none forecast
    change_flag?: boolean; // official BoM wind-change danger flag, or the model indicator
    rain?: string; // "Rain 20% · 0–1 mm" (≤ 18)
    text?: string; // short line (≤ 28): indicators or rain history
    src?: string; // "Open-Meteo model" (≤ 28)
    src_short?: string; // "Model from 15:00 · BoM" (≤ 23): the source line under a rating note
  };
}

export interface Incidents {
  /** false ⇒ "INCIDENTS & WARNINGS UNAVAILABLE"; counts and rows are then absent, never zero. */
  ok: boolean;
  /** Feed is 10–45 min old: counts shown with an OLD DATA chip. */
  stale: boolean;
  heading: string; // "WITHIN 30 KM" (≤ 14)
  as_at: string; // "as at 16:04 · +9 more" | "16:59 · +2 more +2 safe" | "OLD DATA 16:40 +2 more" (≤ 24)
  /** warnings, going, controlled, burns, other CFA — in that order. */
  counts?: [Count, Count, Count, Count, Count];
  rows?: Row[]; // ≤ 5, in display order (unlocated warnings, warnings over and near home, going fires, …)
  more?: number;
  empty_text?: string; // only when ok && !stale && no rows (≤ 80)
  error_text?: string; // only when !ok, e.g. "Last known 15:59: EMERGENCY WARNING · location unknown · …" (≤ 80)
}

export interface Count {
  n: string; // "0".."99+" (≤ 3)
  label: string; // "warnings" | "going" | "controlled" | "burns" | "other CFA" (≤ 11)
  short: string; // "warn" | "going" | "ctrl" | "burns" | "other" (≤ 5)
  hot?: boolean; // warnings > 0 or going > 0
}

export interface Row {
  kind: "warning" | "fire" | "fire_ctrl" | "burn" | "other";
  sev: 1 | 2 | 3;
  line1: string; // "9.7 km NNW · WATCH AND ACT" (≤ 32 with upwind, ≤ 38 without)
  line2: string; // "Prepare to leave · Bushfire · Kangaroo Ground +4" (≤ 56)
  upwind: boolean;
}

// ---------------------------------------------------------------------------------------------
// Districts

export type DistrictKey =
  | "mallee"
  | "wimmera"
  | "northern_country"
  | "north_east"
  | "east_gippsland"
  | "west_and_south_gippsland"
  | "central"
  | "north_central"
  | "south_west";

/** YYYY-MM-DD, a calendar date in Australia/Melbourne. */
export type LocalDate = string;

// ---------------------------------------------------------------------------------------------
// Geometry

export type LonLat = [number, number];

export interface Geo {
  points: LonLat[];
  /** Each polygon is [outer ring, ...holes]; MultiPolygons are flattened into several polygons. */
  polygons: LonLat[][][];
  /** [minLon, minLat, maxLon, maxLat] over everything, or null when there is no usable coordinate. */
  bbox: [number, number, number, number] | null;
}

export interface Home {
  lat: number;
  lon: number;
}

// ---------------------------------------------------------------------------------------------
// VicEmergency events (normalised, PII-free)

export type Kind = "warning" | "area_product" | "met_warning" | "burn" | "fire" | "other" | "earthquake" | "unclassified";
export type Agency = "CFA" | "FRV" | "SES" | "DEECA" | "EMV" | "BoM" | "RFS" | "CFS" | "Other";
export type StatusBucket = "active" | "controlled" | "safe";

export interface NormFeature {
  id: string;
  kind: Kind;
  agency: Agency;
  /** sourceFeed, e.g. "cfa-incident". Used only to recognise CFA calls, never to classify. */
  feed: string;
  cat1: string;
  cat2: string;
  status: string;
  location: string;
  /** cap.event ?? category2, e.g. "Bushfire". */
  event: string;
  /** Warning action verbatim ("Prepare to Leave"), else "". */
  action: string;
  /** Warnings only: 3 Emergency Warning / evacuate, 2 Watch and Act, 1 Advice, 0 Community Update. */
  level: 0 | 1 | 2 | 3 | null;
  /**
   * The warning's category1 to show verbatim when it is not a standard level name (an evacuation
   * variant, or something new); "" otherwise. It ranks as max(level, 2.5).
   */
  levelRaw: string;
  statewide: boolean;
  created: number | null;
  updated: number | null;
  geo: Geo;
}

export interface DayConditions {
  date: LocalDate;
  fdr: Partial<Record<DistrictKey, string>>;
  tfb: Partial<Record<DistrictKey, string>>;
}

export interface EventsFeed {
  /** properties.lastUpdated, epoch ms. */
  lastUpdated: number | null;
  features: NormFeature[];
  /** properties.conditions.forecasts[], keyed by Melbourne date. */
  conditions: DayConditions[];
}

// ---------------------------------------------------------------------------------------------
// Fire danger ratings and Total Fire Bans

/** Raw upper-case strings as published, per district and date. */
export interface RatingsFeed {
  /** e.g. "MODERATE", "NO FORECAST", "NO RATING". */
  fdr: Record<LocalDate, Partial<Record<DistrictKey, string>>>;
  /** e.g. "NO - RESTRICTIONS MAY APPLY", "YES - TOTAL FIRE BAN IN FORCE". */
  tfb: Record<LocalDate, Partial<Record<DistrictKey, string>>>;
  /** Official declaration sentence per date, when the source has one. */
  declaration: Record<LocalDate, string>;
  /** Dates the source lists but has not yet forecast (CFA's placeholder 5th day). */
  notYet: LocalDate[];
  /** Issue time (epoch ms) per date, when the source says. */
  issued: Record<LocalDate, number>;
}

export interface BomFdrDay {
  /** BoM's text, e.g. "Moderate", "No Rating". */
  rating: string;
  fbi: number | null;
  /** The issue this day came from (the morning's 'today' outlives the 16:00 issue), epoch ms. */
  issued?: number | null;
}

export interface BomFdr {
  issued: number | null;
  nextIssue: number | null;
  days: Partial<Record<DistrictKey, Record<LocalDate, BomFdrDay>>>;
}

export interface FireWx {
  date: LocalDate;
  fdr: string | null;
  fbi: number | null;
  haines: number | null;
  lightning: number | null;
  wcdi: number | null;
  wcdFlag: boolean | null;
  tmax50: number | null;
  rhmin50: number | null;
  windDir: string | null;
  gust90: number | null;
}

export interface BomFw {
  issued: number | null;
  district: Partial<Record<DistrictKey, FireWx[]>>;
  /** Keyed by normalised LGA name, e.g. "nillumbik". */
  subarea: Record<string, FireWx[]>;
}

// ---------------------------------------------------------------------------------------------
// Weather (Open-Meteo, hourly)

export interface WxHour {
  /** epoch ms */
  t: number;
  temp: number | null;
  rh: number | null;
  wspd: number | null;
  wdir: number | null;
  gust: number | null;
  precip: number | null;
  pop: number | null;
  code: number | null;
}

export interface Weather {
  /** epoch ms of the model's current reading */
  currentAt: number | null;
  current: WxHour | null;
  hours: WxHour[];
}

// ---------------------------------------------------------------------------------------------
// District lookup

export interface DistrictLookup {
  key: DistrictKey | null;
  /** Normalised LGA name ("nillumbik"), or null. */
  lga: string | null;
  /** Other districts whose area lies within the radius. */
  neighbours: DistrictKey[];
}

// ---------------------------------------------------------------------------------------------
// Source plumbing

export type SourceId = "events" | "osom" | "cfa" | "bom_fdr" | "bom_fw" | "weather" | "district";
export type SourceState = "ok" | "stale" | "unavailable";

export interface SourceResult<T> {
  id: SourceId;
  state: SourceState;
  data: T | null;
  /** The source's own timestamp (feed lastUpdated, BoM issue time, …), epoch ms. */
  asOf: number | null;
  /** When we last fetched or revalidated it, epoch ms. */
  fetchedAt: number | null;
  /** Short reason for a failure: "timeout", "http 503", "bad document". Never feed text. */
  error: string | null;
}

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
  kv: KVNamespace | null;
  /** Structured log line; never passed coordinates, tokens or feed text. */
  log: (o: Record<string, unknown>) => void;
}
