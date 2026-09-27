/**
 * Hand-made payloads for the template tests and /preview: one per state the screen must handle,
 * with strings at or near the Worker's character budgets (src/types.ts) so the pixel budget is
 * exercised. Every string has a shape the Worker actually emits (src/payload.ts, src/ratings.ts,
 * src/weather.ts): a payload the Worker can't produce would test ink that never reaches a screen.
 * Suburb-level places only. All are sample data; tests that need live behaviour spread
 * `sample: false` over a copy.
 */
import type { Count, Day, PayloadV1, Row } from "../src/types.js";

/** 16:05 on Sun 27 Sep 2026 in Melbourne (AEST). */
export const EPOCH = 1790489100;

const SOURCES = "Source: State of Victoria (CC BY 3.0 AU) · BoM · Open-Meteo (CC BY 4.0) · VicEmergency data received";
export const ATTRIBUTION = `${SOURCES} Sun 16:04`;
export const DISCLAIMER =
  "Not an official warning service. Use the VicEmergency app, emergency.vic.gov.au or Hotline 1800 226 226. If you see fire, call 000.";

const base = {
  v: 1 as const,
  ok: true,
  sample: true,
  generated_epoch: EPOCH,
  checked_local: "Sun 16:05",
  feed_received_local: "Sun 16:04",
  district: "Central",
  radius_km: 30,
  neighbours: "",
  statewide: "",
  attribution: ATTRIBUTION,
  disclaimer: DISCLAIMER,
};

/** The events feed last read at 13:52: what every payload built while it is down carries. */
const eventsDown = {
  feed_received_local: "Sun 13:52",
  attribution: `${SOURCES} Sun 13:52`,
};

function counts(n: [string, string, string, string, string]): [Count, Count, Count, Count, Count] {
  const hot = (s: string) => s !== "0";
  return [
    { n: n[0], label: "warnings", short: "warn", hot: hot(n[0]) },
    { n: n[1], label: "going", short: "going", hot: hot(n[1]) },
    { n: n[2], label: "controlled", short: "ctrl" },
    { n: n[3], label: "burns", short: "burns" },
    { n: n[4], label: "other CFA", short: "other" },
  ];
}

// ---------------------------------------------------------------------------------------------
// Weather (src/weather.ts wxStrings)

/** A model change more than an hour past on today's column keeps its text but loses the chip. */
const wxToday: Day["wx"] = {
  ok: true,
  temps: "19° / 8°",
  rh: "RH min 41% @14:00",
  wind: "NNW 20 G35 km/h",
  change: "S change ~13:00",
  change_flag: false,
  rain: "Rain 10% · 0.0 mm",
  text: "7 days: 12 mm · wet Sat 26",
  src: "Open-Meteo model",
  src_short: "Model",
};

const wxTomorrow: Day["wx"] = {
  ok: true,
  temps: "22° / 10°",
  rh: "RH min 35% @15:00",
  wind: "N 25 G45 km/h",
  change: "",
  change_flag: false,
  rain: "Rain 30% · 1.2 mm",
  text: "",
  src: "Open-Meteo model · BoM",
  src_short: "Model · BoM",
};

/** Hot, dry and windy at the budgets: the widest weather strings the Worker may send. */
const wxWorst: Day["wx"] = {
  ok: true,
  temps: "44° / 27°",
  rh: "RH min 6% @14:00",
  wind: "WNW 55 G90 km/h",
  change: "Wind change danger",
  change_flag: true,
  rain: "Rain 20% · 0.0 mm",
  text: "7 days: 0.0 mm · wet Sat 19",
  src: "Open-Meteo model · BoM",
  src_short: "Model · BoM",
};

/** Tomorrow's model change is always flagged: it is still ahead. */
const wxTomorrowHot: Day["wx"] = {
  ok: true,
  temps: "36° / 18°",
  rh: "RH min 11% @15:00",
  wind: "SSW 35 G60 km/h",
  change: "S change ~18:00",
  change_flag: true,
  rain: "Rain 40% · 1.2 mm",
  text: "Hot, dry & windy (model)",
  src: "Open-Meteo model · BoM",
  src_short: "Model · BoM",
};

// ---------------------------------------------------------------------------------------------
// Ratings (src/ratings.ts buildRatings)

const CHECK = "Check emergency.vic.gov.au or VicEmergency app";
const moderate: Day["fdr"] = { level: 1, word: "MODERATE", action: "Plan and prepare", issued: "FBI 12 · BoM Sun 05:30" };
const noRating: Day["fdr"] = { level: 0, word: "NO RATING", action: "No rating – fires can still start", issued: "FBI 8 · BoM Sun 16:00" };
/** VicEmergency said NO FORECAST and nothing independent confirmed it: still level 0. */
const notIssued: Day["fdr"] = { level: 0, word: "NO RATING ISSUED", action: "No rating – fires can still start", issued: "" };
const unavailable: Day["fdr"] = { level: -1, word: "RATING UNAVAILABLE", action: CHECK, issued: "" };
const high = (issued: string): Day["fdr"] => ({ level: 2, word: "HIGH", action: "Be ready to act", issued });
const extreme = (issued: string): Day["fdr"] => ({ level: 3, word: "EXTREME", action: "Take action now to protect life and property", issued });
const catastrophic = (issued: string): Day["fdr"] => ({ level: 4, word: "CATASTROPHIC", action: "For your survival, leave bushfire risk areas", issued });

const noTfb: Day["tfb"] = { state: "none", text: "No TFB · restrictions may apply" };
/** Tomorrow's NO is never an all-clear: bans are usually declared the afternoon before. */
const notYet: Day["tfb"] = { state: "pending", text: "No TFB declared yet" };
const tfbUnavailable: Day["tfb"] = { state: "unknown", text: "TFB status unavailable" };
const tfb: Day["tfb"] = { state: "declared", text: "TOTAL FIRE BAN" };
/** Every YES came from a copy the Worker could no longer refresh. */
const tfbAsOf: Day["tfb"] = { state: "declared", text: "TOTAL FIRE BAN · as of 14:05" };

const STATEWIDE = "Statewide: Weather (Advice) · Extreme Heat (Advice) +1";

// ---------------------------------------------------------------------------------------------
// Rows (src/payload.ts warningRow, fireRow, burnRow)

const busyRows: Row[] = [
  {
    kind: "warning",
    sev: 3,
    line1: "9.7 km NNW · EMERGENCY WARNING",
    line2: "Take shelter now · Bushfire · Kinglake West, Toolangi +9",
    upwind: true,
  },
  {
    kind: "warning",
    sev: 3,
    line1: "22 km NE · WATCH AND ACT",
    line2: "Prepare to leave · Bushfire · Castella, Kinglake +4",
    upwind: true,
  },
  {
    kind: "fire",
    sev: 2,
    line1: "12 km NNW · Grass and scrub fire",
    line2: "Responding · Kangaroo Ground-St Andrews Rd, St Andrews",
    upwind: true,
  },
  {
    kind: "fire_ctrl",
    sev: 1,
    line1: "18 km ENE · Grass and scrub fire ×12",
    line2: "Under control · Yarra Glen-Christmas Hills Rd, Christmas",
    upwind: false,
  },
  {
    kind: "burn",
    sev: 1,
    line1: "28 km SE · Planned burn",
    line2: "In progress · Warrandyte State Park, Pound Bend Reserve",
    upwind: false,
  },
];

// ---------------------------------------------------------------------------------------------

/** Today MODERATE, tomorrow NO RATING, nothing within the radius. */
export const quiet: PayloadV1 = {
  ...base,
  neighbours: "North Central: MODERATE · No TFB",
  house: { status: "clear" },
  days: [
    { label: "TODAY · SUN 27 SEP", fdr: moderate, tfb: noTfb, wx: wxToday },
    { label: "TOMORROW · MON 28", fdr: noRating, tfb: notYet, wx: wxTomorrow },
  ],
  incidents: {
    ok: true,
    stale: false,
    heading: "WITHIN 30 KM",
    as_at: "as at 16:04",
    counts: counts(["0", "0", "0", "0", "0"]),
    rows: [],
    more: 0,
    empty_text: "No warnings, fires or burns within 30 km · nearest active fire 41 km NE",
  },
};

/** EXTREME with a Total Fire Ban, 5 rows, 4 warnings nearby, statewide warnings listed; tomorrow's sources disagree. */
export const busy: PayloadV1 = {
  ...base,
  neighbours: "North Central: CATASTROPHIC · TFB",
  statewide: STATEWIDE,
  house: { status: "clear" },
  days: [
    { label: "TODAY · FRI 9 JAN", fdr: extreme("FBI 74 · BoM Thu 16:00"), tfb, wx: wxWorst },
    { label: "TOMORROW · SAT 10", fdr: high("BoM: HIGH · EMV: MOD · FBI 38"), tfb: notYet, wx: wxTomorrowHot },
  ],
  incidents: {
    ok: true,
    stale: false,
    heading: "WITHIN 30 KM",
    as_at: "as at 16:04 · +9 more",
    counts: counts(["4", "6", "11", "2", "82"]),
    rows: busyRows,
    more: 9,
  },
};

/** House inside an Emergency Warning on a CATASTROPHIC TFB day, everything at its budget. */
export const houseEW: PayloadV1 = {
  ...base,
  district: "West and South Gippsland",
  neighbours: "North Central: CATASTROPHIC · TFB",
  statewide: STATEWIDE,
  house: {
    status: "in_warning",
    rank: 3,
    kicker: "YOU ARE IN A WARNING AREA · BUSHFIRE",
    level: "EMERGENCY WARNING",
    action: "TAKE SHELTER NOW · Creightons Creek, Dropmore +9",
    issued: "Issued 16:58 · +1 more",
  },
  days: [
    { label: "TODAY · WED 28 JAN", fdr: catastrophic("FBI 104 · BoM Tue 16:00"), tfb, wx: wxWorst },
    {
      label: "TOMORROW · THU 29",
      fdr: extreme("BoM: EXT · EMV/CFA: HIGH · FBI 61"),
      tfb,
      wx: { ...wxTomorrowHot, temps: "41° / 24°", rh: "RH min 8% @13:00", wind: "NNW 50 G85 km/h" },
    },
  ],
  incidents: {
    ok: true,
    stale: false,
    heading: "WITHIN 100 KM",
    as_at: "as at 16:04 · +99 more",
    counts: counts(["12", "31", "99+", "4", "99+"]),
    rows: [
      {
        kind: "warning",
        sev: 3,
        line1: "IN AREA · EMERGENCY WARNING",
        line2: "Take shelter now · Bushfire · Creightons Creek, Gobur +9",
        upwind: false,
      },
      {
        kind: "warning",
        sev: 3,
        line1: "13 km WNW · EMERGENCY WARNING",
        line2: "Leave immediately · Grass fire · Black Snake Creek +22",
        upwind: true,
      },
      {
        kind: "fire",
        sev: 3,
        line1: "12 km WNW · Grass and scrub fire",
        line2: "Not yet under control · Heathcote-Kilmore Rd, Glenaroua",
        upwind: true,
      },
      {
        kind: "fire",
        sev: 2,
        line1: "100 km WSW · Grass and scrub fire ×12",
        line2: "Responding · Mountain Hwy, Bayswater North, Wantirna Sth",
        upwind: false,
      },
      {
        kind: "other",
        sev: 2,
        line1: "2 items not placed on the map",
        line2: "Check the VicEmergency map for anything near you",
        upwind: false,
      },
    ],
    more: 99,
  },
};

/** The events feed is down: no counts, house status unknown, rating still shown. */
export const incidentsDown: PayloadV1 = {
  ...base,
  ...eventsDown,
  neighbours: "North Central: HIGH · No TFB",
  house: { status: "unknown" },
  days: [
    { label: "TODAY · SUN 27 SEP", fdr: high("FBI 31 · BoM Sun 05:30"), tfb: noTfb, wx: wxToday },
    { label: "TOMORROW · MON 28", fdr: { ...moderate, issued: "FBI 14 · BoM Sun 16:00" }, tfb: tfbUnavailable, wx: wxTomorrow },
  ],
  incidents: {
    ok: false,
    stale: false,
    heading: "WITHIN 30 KM",
    as_at: "last received 13:52",
    error_text: "The VicEmergency feed could not be read since Sun 13:52.",
  },
};

/** No source had today's rating for the district; tomorrow's NO FORECAST went unconfirmed. Weather missing too. */
export const ratingUnavailable: PayloadV1 = {
  ...base,
  house: { status: "clear" },
  days: [
    { label: "TODAY · SUN 27 SEP", fdr: unavailable, tfb: tfbUnavailable, wx: { ok: false } },
    { label: "TOMORROW · MON 28", fdr: notIssued, tfb: notYet, wx: { ok: false } },
  ],
  incidents: {
    ok: true,
    stale: false,
    heading: "WITHIN 30 KM",
    as_at: "as at 16:04 · +1 more",
    counts: counts(["0", "1", "3", "1", "7"]),
    rows: [
      {
        kind: "fire",
        sev: 3,
        line1: "24 km N · Grass fire",
        line2: "Going · Kinglake Rd, Kinglake",
        upwind: true,
      },
      {
        kind: "fire_ctrl",
        sev: 1,
        line1: "8.1 km SW · Bushfire",
        line2: "Under control · Ringwood-Warrandyte Rd, Warrandyte",
        upwind: false,
      },
      {
        kind: "burn",
        sev: 1,
        line1: "15 km E · Planned burn",
        line2: "Patrolled · Kinglake National Park, Mt Everard Track",
        upwind: false,
      },
    ],
    more: 1,
  },
};

/** The events feed is 10–45 min old: counts and rows with the OLD DATA chip. */
export const stale: PayloadV1 = {
  ...base,
  feed_received_local: "Sun 15:20",
  attribution: `${SOURCES} Sun 15:20`,
  house: { status: "clear" },
  days: [
    { label: "TODAY · SUN 27 SEP", fdr: high("FBI 29 · BoM Sun 05:30"), tfb: noTfb, wx: wxToday },
    { label: "TOMORROW · MON 28", fdr: moderate, tfb: notYet, wx: wxTomorrow },
  ],
  incidents: {
    ok: true,
    stale: true,
    heading: "WITHIN 30 KM",
    as_at: "OLD DATA · 15:20",
    counts: counts(["1", "1", "0", "0", "3"]),
    rows: [busyRows[1]!, busyRows[2]!],
    more: 0,
  },
};

/**
 * The events feed is 20 min old on an EXTREME TFB day with five rows: the band's WARNINGS · OLD DATA
 * chip sits beside the tallest pill, so a stale "no warning over the house" never reads as a fresh
 * one, and the alarming neighbour takes the panel's slot from the statewide line.
 */
export const staleBusy: PayloadV1 = {
  ...busy,
  feed_received_local: "Sun 15:45",
  attribution: `${SOURCES} Sun 15:45`,
  incidents: { ...busy.incidents, stale: true, as_at: "OLD DATA · 15:45" },
};

/** The Worker's full-screen shape (src/payload.ts downPayload). */
const downDay: Day = { label: "", fdr: unavailable, tfb: tfbUnavailable, wx: { ok: false } };

/** Nothing usable at all. */
export const down: PayloadV1 = {
  ...base,
  ...eventsDown,
  ok: false,
  down_title: "DATA UNAVAILABLE",
  down_reason: "Fire danger ratings and warnings could not be loaded.",
  last_good_local: "Sun 13:52",
  district: "",
  radius_km: 0,
  house: { status: "unknown" },
  days: [downDay, { ...downDay }],
  incidents: { ok: false, stale: false, heading: "", as_at: "" },
};

/** Bad token or location: never a default city. */
export const configError: PayloadV1 = {
  ...down,
  feed_received_local: "unknown",
  attribution: `${SOURCES} unknown`,
  down_title: "CONFIGURATION ERROR",
  down_reason: "Access token missing or wrong. Check the plugin's Worker access token.",
  last_good_local: undefined,
};

/** House inside a Watch and Act with no fires nearby (Horsham, 9 Jan): the sample watermark case. */
export const sample: PayloadV1 = {
  ...base,
  district: "Wimmera",
  statewide: STATEWIDE,
  house: {
    status: "in_warning",
    rank: 2,
    kicker: "YOU ARE IN A WARNING AREA · BUSHFIRE",
    level: "WATCH AND ACT",
    action: "PREPARE TO LEAVE · Horsham, Haven, Vectis +6",
    issued: "Issued 15:41",
  },
  days: [
    { label: "TODAY · FRI 9 JAN", fdr: extreme("FBI 68 · BoM Thu 16:00"), tfb, wx: wxWorst },
    { label: "TOMORROW · SAT 10", fdr: moderate, tfb: notYet, wx: wxTomorrow },
  ],
  incidents: {
    ok: true,
    stale: false,
    heading: "WITHIN 30 KM",
    as_at: "as at 16:04",
    counts: counts(["1", "0", "0", "0", "2"]),
    rows: [
      {
        kind: "warning",
        sev: 3,
        line1: "IN AREA · WATCH AND ACT",
        line2: "Prepare to leave · Grass fire · Horsham, Haven +7",
        upwind: false,
      },
    ],
    more: 0,
  },
};

/**
 * A local Advice over the house on a CATASTROPHIC TFB day: the band stays the warning's (plan
 * precedence) but takes the rating's ink and gives today's AFDRS action, not "Follow the warning".
 * The rating's note and the pill are both present, the tightest right column.
 */
export const houseAdviceCat: PayloadV1 = {
  ...base,
  house: {
    status: "in_warning",
    rank: 1,
    kicker: "YOU ARE IN A WARNING AREA · BUSHFIRE",
    level: "ADVICE",
    action: "THREAT IS REDUCED · Kinglake, Pheasant Creek +3",
    issued: "Issued 16:58 · +1 more",
  },
  days: [
    { label: "TODAY · FRI 9 JAN", fdr: catastrophic("FBI 104 · BoM Fri 05:30"), tfb, wx: wxWorst },
    { label: "TOMORROW · SAT 10", fdr: extreme("FBI 71 · BoM Thu 16:00"), tfb, wx: wxTomorrowHot },
  ],
  incidents: {
    ok: true,
    stale: false,
    heading: "WITHIN 30 KM",
    as_at: "as at 16:04",
    counts: counts(["2", "0", "0", "0", "3"]),
    rows: [
      {
        kind: "warning",
        sev: 3,
        line1: "IN AREA · ADVICE",
        line2: "Threat is reduced · Bushfire · Kinglake +3",
        upwind: false,
      },
      {
        kind: "warning",
        sev: 2,
        line1: "6.4 km N · ADVICE",
        line2: "Avoid smoke · Smoke · Kinglake West, Pheasant Creek +2",
        upwind: true,
      },
    ],
    more: 0,
  },
};

/**
 * A statewide Extreme Heat Watch and Act over the house on a CATASTROPHIC TFB day: the band stays
 * the warning's, in the rating's ink, and still gives today's AFDRS action. The note and the pill
 * leave no room for the generic line as well, so the action takes its place.
 */
export const houseHeatCat: PayloadV1 = {
  ...base,
  house: {
    status: "in_warning",
    rank: 2,
    kicker: "STATEWIDE WARNING · EXTREME HEAT",
    level: "WATCH AND ACT",
    action: "STAY INDOORS · Victoria",
    issued: "Issued 16:50",
  },
  days: [
    { label: "TODAY · FRI 9 JAN", fdr: catastrophic("FBI 102 · BoM Thu 16:00"), tfb, wx: wxWorst },
    { label: "TOMORROW · SAT 10", fdr: extreme("FBI 64 · BoM Thu 16:00"), tfb, wx: wxTomorrowHot },
  ],
  incidents: {
    ok: true,
    stale: false,
    heading: "WITHIN 30 KM",
    as_at: "as at 16:04",
    counts: counts(["0", "0", "0", "0", "2"]),
    rows: [
      {
        kind: "warning",
        sev: 3,
        line1: "IN AREA · WATCH AND ACT",
        line2: "Stay indoors · Extreme Heat · Victoria",
        upwind: false,
      },
    ],
    more: 0,
  },
};

/**
 * Every rating source down for 2 h, the events feed too: the last copy's EXTREME / CATASTROPHIC and
 * bans stay, labelled LAST KNOWN and "as of", with warnings unavailable.
 */
export const staleAlarm: PayloadV1 = {
  ...base,
  ...eventsDown,
  neighbours: "North Central: EXTREME · TFB",
  house: { status: "unknown" },
  days: [
    { label: "TODAY · FRI 9 JAN", fdr: extreme("LAST KNOWN 14:05"), tfb: tfbAsOf, wx: wxWorst },
    { label: "TOMORROW · SAT 10", fdr: catastrophic("LAST KNOWN 14:05"), tfb: tfbAsOf, wx: wxTomorrowHot },
  ],
  incidents: {
    ok: false,
    stale: false,
    heading: "WITHIN 30 KM",
    as_at: "last received 13:52",
    error_text: "The VicEmergency feed could not be read since Sun 13:52.",
  },
};

/**
 * A Watch and Act over the house, five rows and a statewide Advice line, with the neighbouring
 * district at EXTREME under a ban: the neighbour's alarm takes the only context slot.
 */
export const neighbourAlarm: PayloadV1 = {
  ...base,
  district: "Wimmera",
  neighbours: "Central: EXTREME · TOTAL FIRE BAN",
  statewide: STATEWIDE,
  house: {
    status: "in_warning",
    rank: 2,
    kicker: "IN A WARNING AREA · GRASS FIRE",
    level: "WATCH AND ACT",
    action: "MONITOR CONDITIONS AS THEY ARE CHANGING",
    issued: "Issued 16:57",
  },
  days: [
    { label: "TODAY · FRI 9 JAN", fdr: extreme("FBI 58 · BoM Thu 16:00"), tfb, wx: wxWorst },
    { label: "TOMORROW · SAT 10", fdr: high("FBI 33 · BoM Thu 16:00"), tfb, wx: wxTomorrowHot },
  ],
  incidents: {
    ok: true,
    stale: false,
    heading: "WITHIN 30 KM",
    as_at: "as at 16:04 · +2 more",
    counts: counts(["6", "0", "0", "0", "2"]),
    rows: [
      {
        kind: "warning",
        sev: 3,
        line1: "IN AREA · WATCH AND ACT",
        line2: "Monitor conditions as they are changing · Horsham +2",
        upwind: false,
      },
      {
        kind: "warning",
        sev: 3,
        line1: "1.7 km S · EMERGENCY WARNING",
        line2: "Leave immediately · Grass Fire · Vectis East, Dooen +3",
        upwind: true,
      },
      {
        kind: "warning",
        sev: 3,
        line1: "1.8 km SSE · WATCH AND ACT",
        line2: "Monitor conditions as they are changing · Bungalally +7",
        upwind: false,
      },
      {
        kind: "warning",
        sev: 3,
        line1: "2.2 km N · WATCH AND ACT",
        line2: "Monitor conditions as they are changing · Pimpinio +3",
        upwind: true,
      },
      {
        kind: "warning",
        sev: 3,
        line1: "10 km W · EMERGENCY WARNING",
        line2: "Shelter indoors now · Grass Fire · Arapiles +8",
        upwind: true,
      },
    ],
    more: 2,
  },
};

/** What TRMNL renders when the poll body is not JSON: nothing at the root. */
export const empty = {} as unknown as PayloadV1;

export const PAYLOADS = {
  quiet,
  busy,
  houseEW,
  incidentsDown,
  ratingUnavailable,
  stale,
  staleBusy,
  down,
  configError,
  sample,
  houseAdviceCat,
  houseHeatCat,
  staleAlarm,
  neighbourAlarm,
  empty,
} as const;

export type PayloadName = keyof typeof PAYLOADS;
