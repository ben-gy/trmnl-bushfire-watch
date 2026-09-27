/**
 * Review fixes in the payload and ratings: buildPayload over gather() with injected deps (a fake
 * upstream serving the snapshots by URL, a frozen clock, an in-memory KV where a case needs a
 * last-good copy). Each case is one confirmed finding: alarms kept on screen when data is missing
 * (4), stale ratings labelled and aged out (5), warnings with no location (7), fire-row order (8),
 * yesterday's area products (11), per-section containment (12), the nearest fire beyond the radius
 * (14), "+N safe" (15), the neighbour line (16) and ?fixture=constructor (25). The [rN] cases are the
 * final review's: the events copy's own alarms (r3), an unplaced warning in alarm-only mode (r4), the
 * warnings count (r5), a stale neighbour's time (r6), "+N more" when OLD DATA (r7), which neighbour (r8).
 */
import { beforeEach, describe, expect, it } from "vitest";
import app, { deps } from "../src/index.js";
import { type DistrictResult, type Gathered, gather } from "../src/gather.js";
import { buildPayload } from "../src/payload.js";
import { ALARM_KEEP_MS, buildRatings, neighbourLine, type RatingInputs } from "../src/ratings.js";
import { clearMemory } from "../src/store.js";
import { addDays, localDate } from "../src/time.js";
import type { BomFdr, Deps, DistrictKey, Home, NormFeature, PayloadV1, RatingsFeed, SourceResult } from "../src/types.js";
import {
  at,
  band,
  BUDGET_BYTES,
  budgetViolations,
  bytes,
  eventsBody,
  fakeKv,
  FX,
  HOUR,
  MIN,
  render,
  RENDER_ERROR,
  type Responder,
  type SourceKey,
  square,
  SUBURB,
  T_QUIET,
  text,
  upstream,
  ZERO_CLAIM,
} from "./helpers.js";

beforeEach(() => {
  clearMemory();
});

const iso = (ms: number) => new Date(ms).toISOString();
const down503: Responder = () => new Response("Service Unavailable", { status: 503, headers: { "content-type": "text/html" } });

interface Opts {
  now?: number;
  over?: Partial<Record<SourceKey, Responder>>;
  bodies?: Partial<Record<SourceKey, string>>;
  kv?: KVNamespace | null;
  home?: Home;
  district?: DistrictResult;
}

async function gathered(o: Opts = {}): Promise<Gathered> {
  const now = o.now ?? T_QUIET;
  const up = upstream(now, o.over, o.bodies);
  const g = await gather(
    { home: o.home ?? SUBURB, district: o.district?.lookup.key ?? null, radiusKm: 30 },
    { fetch: up.fetch, now: () => now, kv: o.kv ?? null, log: () => {} },
    o.district ? { district: o.district } : {},
  );
  expect(up.unknown).toEqual([]);
  return g;
}

/** Every payload the Worker builds must fit its budgets and render cleanly. */
function checked(p: PayloadV1): { p: PayloadV1; html: string } {
  expect(budgetViolations(p)).toEqual([]);
  expect(bytes(p)).toBeLessThanOrEqual(BUDGET_BYTES);
  const html = render(p);
  expect(html).not.toMatch(RENDER_ERROR);
  return { p, html };
}

async function build(o: Opts = {}) {
  const g = await gathered(o);
  return { g, ...checked(buildPayload(g)) };
}

/** osom-fdrtfb.json with some districts' ratings and bans replaced, by "dd/mm/yyyy". */
function osomWith(changes: Record<string, { fdr?: Record<string, string>; tfb?: Record<string, string> }>): string {
  const j = JSON.parse(FX.osom) as { results: { issueFor: string; issueAt?: string; declareList: { name: string; status: string }[] }[] };
  for (const r of j.results) {
    const c = changes[r.issueFor];
    const set = c ? ("issueAt" in r ? c.fdr : c.tfb) : undefined;
    if (!set) continue;
    for (const d of r.declareList) if (d.name in set) d.status = set[d.name]!;
  }
  return JSON.stringify(j);
}

const YES = "YES - TOTAL FIRE BAN IN FORCE";

// ---------------------------------------------------------------------------------------------
// Feature builders (the live feed's shape)

function warning(o: { id: string; level: string; action: string; geometry: unknown; location?: string; event?: string; updated?: number }) {
  const t = o.updated ?? T_QUIET - 10 * MIN;
  return {
    type: "Feature",
    properties: {
      feedType: "warning",
      sourceOrg: "EMV",
      sourceFeed: "cop-cap",
      id: o.id,
      category1: o.level,
      category2: "Fire",
      status: "Moderate",
      action: o.action,
      statewide: "N",
      location: o.location ?? "North Warrandyte",
      cap: { event: o.event ?? "Bushfire" },
      created: iso(t - 30 * MIN),
      updated: iso(t),
    },
    geometry: o.geometry,
  };
}

function fire(o: { id: string; north: number; east?: number; status: string; cat2?: string; org?: [string, string]; location?: string }) {
  const [sourceOrg, sourceFeed] = o.org ?? ["VIC/CFA", "cfa-incident"];
  return {
    type: "Feature",
    properties: {
      feedType: "incident",
      sourceOrg,
      sourceFeed,
      id: o.id,
      category1: "Fire",
      category2: o.cat2 ?? "Grass Fire",
      status: o.status,
      location: o.location ?? `Road ${o.id}`,
      created: iso(T_QUIET - 2 * HOUR),
      updated: iso(T_QUIET - 20 * MIN),
    },
    geometry: { type: "Point", coordinates: at(SUBURB, o.north, o.east ?? 0) },
  };
}

function burn(id: string, north: number) {
  return {
    type: "Feature",
    properties: {
      feedType: "incident",
      sourceOrg: "VIC/DEECA",
      sourceFeed: "deeca-burns",
      id,
      category1: "Planned Burn",
      category2: "Planned Burn",
      status: "Patrolled",
      location: "Kangaroo Ground",
      created: iso(T_QUIET - 26 * HOUR),
      updated: iso(T_QUIET - 3 * HOUR),
    },
    geometry: { type: "Point", coordinates: at(SUBURB, north, 1) },
  };
}

/** A cfa-fdr style area product over the house. */
function areaProduct(status: string, created: number) {
  return {
    type: "Feature",
    properties: {
      feedType: "incident",
      sourceOrg: "VIC/CFA",
      sourceFeed: "cfa-fdr",
      id: `fdr-${created}`,
      category1: "Fire",
      category2: "Fire Danger Rating",
      status,
      location: "Central",
      created: iso(created),
      updated: iso(created),
    },
    geometry: square(SUBURB, 0, 0, 25),
  };
}

const feedOf = (features: unknown[], lastUpdated = T_QUIET - MIN) => eventsBody({ lastUpdated, features });

// ---------------------------------------------------------------------------------------------

describe("[4] the full-screen DATA UNAVAILABLE never hides a known alarm", () => {
  it("(a) events down and a 3 h old OSOM: today's ban and tomorrow's Catastrophic stay on the normal layout", async () => {
    const kv = fakeKv();
    const t1 = T_QUIET - 3 * HOUR;
    const osom = osomWith({
      "27/09/2026": { fdr: { Central: "HIGH" }, tfb: { Central: YES } },
      "28/09/2026": { fdr: { Central: "CATASTROPHIC" }, tfb: { Central: YES } },
    });
    await build({ now: t1, kv: kv.kv, bodies: { osom } });
    clearMemory();
    const { g, p, html } = await build({ now: T_QUIET, kv: kv.kv, over: { events: down503, osom: down503, cfa: down503, bom_fdr: down503 } });
    expect(g.osom.state).toBe("stale");

    expect(p.ok).toBe(true);
    // A stale HIGH is not an alarm, so today's rating itself is unavailable…
    expect(p.days[0].fdr).toMatchObject({ level: -1, word: "RATING UNAVAILABLE" });
    // …but the ban and tomorrow's Catastrophic are, and they are labelled with their age.
    expect(p.days[0].tfb).toEqual({ state: "declared", text: "TOTAL FIRE BAN · as of 13:59" });
    expect(p.days[1].fdr).toMatchObject({ level: 4, word: "CATASTROPHIC", action: "For your survival, leave bushfire risk areas" });
    expect(p.days[1].fdr.issued).toMatch(/^LAST KNOWN 13:59/);
    expect(p.days[1].tfb).toEqual({ state: "declared", text: "TOTAL FIRE BAN · as of 13:59" });
    expect(p.incidents.ok).toBe(false);
    expect(p.house).toEqual({ status: "unknown" });
    expect(html).toContain("CATASTROPHIC");
    expect(text(html)).not.toMatch(ZERO_CLAIM);
  });

  it("(b) after 16:00 with EMV and CFA down, BoM's fresh Catastrophic for tomorrow is shown", async () => {
    // Central's first forecast period in the BoM sample is tomorrow (28 Sep).
    const i = FX.idv18555.indexOf('description="Central"');
    const bomCat = FX.idv18555.slice(0, i) + FX.idv18555.slice(i).replace("No Rating", "Catastrophic");
    const { g, p } = await build({ bodies: { bom_fdr: bomCat }, over: { events: down503, osom: down503, cfa: down503 } });
    expect(g.bomFdr.state).toBe("ok");
    expect(p.ok).toBe(true);
    expect(p.days[0].fdr.level).toBe(-1);
    expect(p.days[1].fdr).toMatchObject({ level: 4, word: "CATASTROPHIC" });
    expect(p.days[1].fdr.issued).not.toMatch(/LAST KNOWN/);
    expect(p.incidents.ok).toBe(false);
  });

  it("still goes full-screen when nothing alarming is known", async () => {
    const { p } = await build({ over: { events: down503, osom: down503, cfa: down503 } });
    // BoM's tomorrow is No Rating: not an alarm.
    expect(p.ok).toBe(false);
    expect(p.down_title).toBe("DATA UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------------------------

describe("[5] stale rating alarms are labelled LAST KNOWN and dropped after 6 h", () => {
  async function ratingsThenDown(fdr: string, tfb: string, age: number) {
    const kv = fakeKv();
    const t1 = T_QUIET - age;
    await build({ now: t1, kv: kv.kv, bodies: { osom: osomWith({ "27/09/2026": { fdr: { Central: fdr }, tfb: { Central: tfb } } }) } });
    clearMemory();
    return build({ now: T_QUIET, kv: kv.kv, over: { osom: down503, cfa: down503, bom_fdr: down503, events: down503 } });
  }

  it("a 2 h old EXTREME and ban say when they were last known", async () => {
    const { p } = await ratingsThenDown("EXTREME", YES, 2 * HOUR);
    expect(p.days[0].fdr).toEqual({ level: 3, word: "EXTREME", action: "Take action now to protect life and property", issued: "LAST KNOWN 14:59" });
    expect(p.days[0].tfb).toEqual({ state: "declared", text: "TOTAL FIRE BAN · as of 14:59" });
  });

  it("a 7 h old CATASTROPHIC and ban are dropped", async () => {
    const { p } = await ratingsThenDown("CATASTROPHIC", YES, 7 * HOUR);
    expect(p.ok).toBe(false);
    expect(p.days[0].fdr.level).toBe(-1);
    expect(p.days[0].tfb.state).toBe("unknown");
  });

  // The rules themselves, on hand-made source results.
  const NOW = T_QUIET;
  const TODAY = localDate(NOW);
  const feed = (fdr: string, tfb?: string): RatingsFeed => ({
    fdr: { [TODAY]: { central: fdr } },
    tfb: tfb ? { [TODAY]: { central: tfb } } : {},
    declaration: {},
    notYet: [],
    issued: {},
  });
  const src = <T,>(id: SourceResult<T>["id"], data: T | null, state: SourceResult<T>["state"], asOf: number | null): SourceResult<T> => ({
    id,
    state,
    data,
    asOf,
    fetchedAt: asOf,
    error: null,
  });
  const inputs = (o: Partial<RatingInputs>): RatingInputs => ({
    dates: [TODAY, addDays(TODAY, 1)],
    now: NOW,
    district: "central",
    osom: src<RatingsFeed>("osom", null, "unavailable", null),
    conditions: src<RatingsFeed>("events", null, "unavailable", null),
    cfa: src<RatingsFeed>("cfa", null, "unavailable", null),
    bomFdr: src<BomFdr>("bom_fdr", null, "unavailable", null),
    ...o,
  });

  it("drops a copy over 6 h old even while its source still counts as stale", () => {
    const kept = buildRatings(inputs({ osom: src("osom", feed("CATASTROPHIC", YES), "stale", NOW - 5 * HOUR) }));
    expect(kept[0].fdr).toMatchObject({ level: 4, issued: "LAST KNOWN 12:00" });
    expect(kept[0].tfb).toEqual({ state: "declared", text: "TOTAL FIRE BAN · as of 12:00" });
    const old = buildRatings(inputs({ osom: src("osom", feed("CATASTROPHIC", YES), "stale", NOW - 7 * HOUR) }));
    expect(old[0].fdr.level).toBe(-1);
    expect(old[0].tfb).toEqual({ state: "unknown", text: "TFB status unavailable" });
  });

  it("a fresh source saying the same thing makes it current: no label", () => {
    const [today] = buildRatings(
      inputs({ osom: src("osom", feed("EXTREME", YES), "stale", NOW - 2 * HOUR), cfa: src("cfa", feed("EXTREME", YES), "ok", NOW - 5 * MIN) }),
    );
    expect(today.fdr).toMatchObject({ level: 3, word: "EXTREME", issued: "" });
    expect(today.tfb).toEqual({ state: "declared", text: "TOTAL FIRE BAN" });
  });

  it("a stale alarm above a fresh lower rating keeps the fresh one in the note", () => {
    const [today] = buildRatings(inputs({ osom: src("osom", feed("EXTREME"), "stale", NOW - 2 * HOUR), cfa: src("cfa", feed("HIGH"), "ok", NOW - 5 * MIN) }));
    expect(today.fdr).toMatchObject({ level: 3, word: "EXTREME", issued: "LAST KNOWN 15:00 · CFA: HIGH" });
  });

  it("measures BoM's age from the issue that should have replaced it", () => {
    const bom = (nextIssue: number): BomFdr => ({ issued: NOW - 20 * HOUR, nextIssue, days: { central: { [TODAY]: { rating: "Extreme", fbi: 60 } } } });
    const kept = buildRatings(inputs({ bomFdr: src("bom_fdr", bom(NOW - 5 * HOUR), "stale", NOW - 20 * HOUR) }));
    expect(kept[0].fdr).toMatchObject({ level: 3, word: "EXTREME", issued: "LAST KNOWN 21:00" });
    const dropped = buildRatings(inputs({ bomFdr: src("bom_fdr", bom(NOW - 7 * HOUR), "stale", NOW - 20 * HOUR) }));
    expect(dropped[0].fdr.level).toBe(-1);
    expect(ALARM_KEEP_MS).toBe(6 * HOUR);
  });
});

// ---------------------------------------------------------------------------------------------

describe("[7] a warning with no usable location", () => {
  /** Five Watch and Act areas 5–13 km away, none over the house. */
  const nearby = [0, 1, 2, 3, 4].map((k) =>
    warning({ id: `WA${k}`, level: "Watch and Act", action: "Prepare to leave", geometry: square(SUBURB, 5 + 2 * k, 3, 1), location: `Place ${k}` }),
  );
  const ew = (geometry: unknown, id = "EW1") => warning({ id, level: "Emergency Warning", action: "Leave immediately", geometry, location: "North Warrandyte" });

  for (const [name, geometry] of [
    ["no geometry", null],
    ["a [0,0] point", { type: "Point", coordinates: [0, 0] }],
  ] as const) {
    it(`an Emergency Warning with ${name}: a sev-3 row above nearby ones, counted, and the house not called clear`, async () => {
      const { p, html } = await build({ bodies: { events: feedOf([...nearby, ew(geometry)]) } });
      expect(p.house).toEqual({ status: "unknown" });
      const rows = p.incidents.rows!;
      expect(rows[0]).toEqual({
        kind: "warning",
        sev: 3,
        line1: "EMERGENCY WARNING · location unknown",
        line2: "Leave immediately · Bushfire · North Warrandyte",
        upwind: false,
      });
      expect(p.incidents.more).toBe(1);
      expect(p.incidents.counts![0]).toMatchObject({ label: "warnings", n: "6", hot: true });
      expect(rows.some((r) => /not placed/.test(r.line1))).toBe(false);
      expect(band(html)).toContain("WARNINGS UNAVAILABLE");
    });
  }

  it("two of them: the most severe leads, with a count", async () => {
    const wa = warning({ id: "WA-X", level: "Watch and Act", action: "Prepare to leave", geometry: null });
    const { p } = await build({ bodies: { events: feedOf([wa, ew(null, "EW2")]) } });
    expect(p.incidents.rows![0]).toMatchObject({ sev: 3, line1: "EMERGENCY WARNING · no location +1" });
  });

  it("an unplaced Advice is listed but leaves the house clear", async () => {
    const adv = warning({ id: "ADV1", level: "Advice", action: "Stay informed", geometry: null, event: "Smoke" });
    const { p } = await build({ bodies: { events: feedOf([adv]) } });
    expect(p.house.status).toBe("clear");
    expect(p.incidents.rows).toEqual([{ kind: "warning", sev: 2, line1: "ADVICE · location unknown", line2: "Stay informed · Smoke · North Warrandyte", upwind: false }]);
  });

  it("keeps the generic row for things that are not warnings", async () => {
    const lost = { ...fire({ id: "F-LOST", north: 0, status: "Going" }), geometry: null };
    const { p } = await build({ bodies: { events: feedOf([lost]) } });
    expect(p.house.status).toBe("clear");
    expect(p.incidents.rows!.map((r) => r.line1)).toEqual(["1 item not placed on the map"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("[8] fire rows: going first, then vegetation, then distance", () => {
  it("a Not Yet Under Control fire 20 km away is listed before five nearer Responding calls", async () => {
    const calls = [2, 3, 4, 5, 6].map((km) => fire({ id: `R${km}`, north: km, east: km, status: "Responding" }));
    const nyuc = fire({ id: "NYUC", north: -20, status: "Not Yet Under Control" });
    const { p } = await build({ bodies: { events: feedOf([...calls, nyuc]) } });
    const rows = p.incidents.rows!;
    expect(rows).toHaveLength(5);
    expect(rows[0]!.line1).toMatch(/^20 km S · Grass fire$/);
    expect(rows[0]!.sev).toBe(3);
    expect(p.incidents.more).toBe(1);
    // The rest by distance.
    expect(rows.slice(1).map((r) => r.line1.split(" · ")[0])).toEqual(["2.8 km NE", "4.2 km NE", "5.7 km NE", "7.1 km NE"]);
  });

  it("a going non-vegetation fire still comes before an active vegetation one, and a controlled one last", async () => {
    const car = fire({ id: "CAR", north: 12, status: "Going", cat2: "Car Fire" });
    const grass = fire({ id: "GR", north: 3, status: "Responding" });
    const ctrl = fire({ id: "CTRL", north: 1, status: "Under Control", cat2: "Bushfire" });
    const { p } = await build({ bodies: { events: feedOf([car, grass, ctrl]) } });
    expect(p.incidents.rows!.map((r) => [r.kind, r.line1.split(" · ")[1]])).toEqual([
      ["fire", "Car fire"],
      ["fire", "Grass fire"],
      ["fire_ctrl", "Bushfire"],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("[11] area products describe the day they were issued for", () => {
  const midnight = Date.parse("2026-09-26T14:00:00Z"); // 00:00 on Sun 27 Sep, Melbourne

  it("today's CATASTROPHIC product raises the rating", async () => {
    const { p } = await build({ bodies: { events: feedOf([areaProduct("CATASTROPHIC", midnight)]) } });
    expect(p.days[0].fdr).toMatchObject({ level: 4, word: "CATASTROPHIC" });
  });

  it("yesterday's does not, after midnight", async () => {
    const { p } = await build({ bodies: { events: feedOf([areaProduct("CATASTROPHIC", midnight - 24 * HOUR), areaProduct("TOTAL FIRE BAN IN FORCE", midnight - 24 * HOUR)]) } });
    expect(p.days[0].fdr).toMatchObject({ level: 1, word: "MODERATE" });
    expect(p.days[0].tfb.state).toBe("none");
  });

  it("nor does one from an alarm-only (over 45 min old) copy of the feed", async () => {
    const kv = fakeKv();
    const t1 = T_QUIET - 2 * HOUR;
    const first = await build({ now: t1, kv: kv.kv, bodies: { events: feedOf([areaProduct("CATASTROPHIC", midnight)], t1) } });
    expect(first.p.days[0].fdr.word).toBe("CATASTROPHIC");
    clearMemory();
    const { g, p } = await build({ now: T_QUIET, kv: kv.kv, over: { events: down503 } });
    expect(g.events.state).toBe("unavailable");
    expect(g.events.data).not.toBeNull();
    expect(p.days[0].fdr).toMatchObject({ level: 1, word: "MODERATE" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("[12] a throw in one section costs only that section", () => {
  const boom = () => {
    throw new Error("bad model");
  };

  it("events: a cached feed of the wrong shape leaves ratings and weather, incidents unavailable", async () => {
    const g = await gathered();
    const bad = { ...g, events: { ...g.events, data: { ...g.events.data!, features: { count: 0 } as unknown as NormFeature[] } } };
    const { p, html } = checked(buildPayload(bad));
    expect(p.ok).toBe(true);
    expect(p.days[0].fdr).toMatchObject({ level: 1, word: "MODERATE" });
    expect(p.days[0].wx.ok).toBe(true);
    expect(p.house).toEqual({ status: "unknown" });
    expect(p.incidents).toMatchObject({ ok: false });
    expect(p.incidents.counts).toBeUndefined();
    expect(p.statewide).toBe("");
    expect(text(html)).not.toMatch(ZERO_CLAIM);
  });

  it("events: a warning over the house that throws when read makes warnings unavailable, never clear", async () => {
    const g = await gathered();
    const w = { ...g.events.data!.features[0]!, kind: "warning", level: 2, levelRaw: "", statewide: false, geo: { points: [], polygons: [square(SUBURB, 0, 0, 2).coordinates], bbox: null } } as NormFeature;
    const ring = w.geo.polygons[0]![0]!;
    w.geo.bbox = [Math.min(...ring.map((c) => c[0])), Math.min(...ring.map((c) => c[1])), Math.max(...ring.map((c) => c[0])), Math.max(...ring.map((c) => c[1]))];
    Object.defineProperty(w, "action", { get: boom });
    const bad = { ...g, events: { ...g.events, data: { ...g.events.data!, features: [w] } } };
    const { p } = checked(buildPayload(bad));
    expect(p.ok).toBe(true);
    expect(p.house).toEqual({ status: "unknown" });
    expect(p.incidents.ok).toBe(false);
    expect(p.days[0].fdr.word).toBe("MODERATE");
  });

  it("ratings: both days unavailable, incidents and weather untouched", async () => {
    const g = await gathered();
    const good = checked(buildPayload(g)).p;
    const osom = { ...g.osom.data! };
    Object.defineProperty(osom, "fdr", { get: boom, enumerable: true });
    const { p } = checked(buildPayload({ ...g, osom: { ...g.osom, data: osom } }));
    expect(p.ok).toBe(true);
    for (const d of p.days) {
      expect(d.fdr).toMatchObject({ level: -1, word: "RATING UNAVAILABLE" });
      expect(d.tfb).toEqual({ state: "unknown", text: "TFB status unavailable" });
    }
    expect(p.incidents).toEqual(good.incidents);
    expect(p.days.map((d) => d.wx)).toEqual(good.days.map((d) => d.wx));
    expect(p.neighbours).toBe("");
  });

  it("weather: forecast unavailable on both days, no upwind claims, ratings untouched", async () => {
    const g = await gathered();
    const good = checked(buildPayload(g)).p;
    const wx = { ...g.weather.data! };
    Object.defineProperty(wx, "hours", { get: boom, enumerable: true });
    const { p } = checked(buildPayload({ ...g, weather: { ...g.weather, data: wx } }));
    expect(p.days.map((d) => d.wx)).toEqual([{ ok: false }, { ok: false }]);
    expect(p.days.map((d) => d.fdr)).toEqual(good.days.map((d) => d.fdr));
    expect(p.incidents.ok).toBe(true);
    expect(p.incidents.rows!.every((r) => !r.upwind)).toBe(true);
  });

  it("an out-of-range feed time shows as unknown rather than taking the screen down", async () => {
    const g = await gathered();
    const { p } = checked(buildPayload({ ...g, events: { ...g.events, asOf: 9e15 } }));
    expect(p.feed_received_local).toBe("unknown");
    expect(p.days[0].fdr.word).toBe("MODERATE");
  });
});

// ---------------------------------------------------------------------------------------------

describe("[14] the nearest active fire beyond the radius", () => {
  const far = fire({ id: "FAR", north: 40, status: "Not Yet Under Control", cat2: "Bushfire", location: "Flowerdale" });

  it("gets its own row whenever nothing within the radius is going", async () => {
    const { p } = await build({ bodies: { events: feedOf([burn("B1", 8), far]) } });
    expect(p.incidents.counts![1]).toMatchObject({ label: "going", n: "0" });
    expect(p.incidents.rows).toEqual([
      { kind: "fire", sev: 2, line1: "40 km N · nearest active fire", line2: "Not yet under control · Flowerdale", upwind: false },
      expect.objectContaining({ kind: "burn" }),
    ]);
  });

  it("alone, it stays in the empty text", async () => {
    const { p } = await build({ bodies: { events: feedOf([far]) } });
    expect(p.incidents.rows).toEqual([]);
    expect(p.incidents.empty_text).toBe("No warnings, fires or burns within 30 km · nearest active fire 40 km N");
  });

  it("is not added when a fire within the radius is going", async () => {
    const { p } = await build({ bodies: { events: feedOf([fire({ id: "G", north: 5, status: "Going" }), far]) } });
    expect(p.incidents.rows!.map((r) => r.line1)).not.toContainEqual(expect.stringMatching(/nearest active/));
  });
});

// ---------------------------------------------------------------------------------------------

describe("[15] safe fires show as '+N safe'", () => {
  const safe = [fire({ id: "S1", north: 10, status: "Safe" }), fire({ id: "S2", north: -10, status: "Safe" })];

  it("beside the time", async () => {
    const { p } = await build({ bodies: { events: feedOf([fire({ id: "G", north: 5, status: "Going" }), ...safe]) } });
    expect(p.incidents.counts![1]!.n).toBe("1");
    expect(p.incidents.as_at).toBe("as at 16:59 · +2 safe");
  });

  it("after '+N more' when both fit", async () => {
    const going = [1, 2, 3, 4, 5, 6, 7].map((k) => fire({ id: `G${k}`, north: 4 * k - 14, east: 4, status: "Going" }));
    const { p } = await build({ bodies: { events: feedOf([...going, ...safe]) } });
    expect(p.incidents.more).toBe(2);
    expect(p.incidents.as_at).toBe("16:59 · +2 more +2 safe");
  });

  it("in the OLD DATA form too", async () => {
    const { p } = await build({ bodies: { events: feedOf([fire({ id: "G", north: 5, status: "Going" }), ...safe], T_QUIET - 20 * MIN) } });
    expect(p.incidents.stale).toBe(true);
    expect(p.incidents.as_at).toBe("OLD DATA · 16:40 +2 safe");
  });
});

// ---------------------------------------------------------------------------------------------

describe("[16] the neighbour line fits 38 characters with its rating and ban", () => {
  it("shortens West and South Gippsland rather than cutting off CATASTROPHIC · TFB", async () => {
    const district: DistrictResult = { lookup: { key: "central", lga: "nillumbik", neighbours: ["west_and_south_gippsland"] }, state: "ok", source: "vicmap" };
    const osom = osomWith({ "27/09/2026": { fdr: { "West and South Gippsland": "CATASTROPHIC" }, tfb: { "West and South Gippsland": YES } } });
    const { p } = await build({ district, bodies: { osom } });
    expect(p.neighbours).toBe("W&S Gippsland: CATASTROPHIC · TFB");
  });

  it("neighbourLine itself never exceeds 38, and never cuts a declared ban", () => {
    const today = localDate(T_QUIET);
    const tomorrow = addDays(today, 1);
    const f: RatingsFeed = {
      fdr: { [today]: { west_and_south_gippsland: "CATASTROPHIC", northern_country: "NO FORECAST" }, [tomorrow]: { west_and_south_gippsland: "NO FORECAST" } },
      tfb: { [today]: { west_and_south_gippsland: YES, northern_country: YES }, [tomorrow]: { west_and_south_gippsland: "MAYBE" } },
      declaration: {},
      notYet: [],
      issued: {},
    };
    const ok = (data: RatingsFeed | BomFdr | null, id: SourceResult<unknown>["id"]) => ({ id, state: data ? "ok" : "unavailable", data, asOf: T_QUIET, fetchedAt: T_QUIET, error: null }) as never;
    const i: RatingInputs = { dates: [today, tomorrow], now: T_QUIET, district: "central" as DistrictKey, osom: ok(f, "osom"), conditions: ok(null, "events"), cfa: ok(null, "cfa"), bomFdr: ok(null, "bom_fdr") };
    const lines = [
      neighbourLine("west_and_south_gippsland", today, i),
      neighbourLine("west_and_south_gippsland", tomorrow, i),
      neighbourLine("northern_country", today, i),
    ];
    expect(lines).toEqual(["W&S Gippsland: CATASTROPHIC · TFB", "W&S Gippsland: NO RATING ISSUED", "Northern Country: NO RATING… · TFB"]);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(38);
  });
});

// ---------------------------------------------------------------------------------------------
// Final review, payload fixes 3–8

/** The 27 Sep feed with today's (27 Sep) conditions for some districts replaced, by display name. */
function feedWithConditions(features: unknown[], lastUpdated: number, fdr: Record<string, string>, tfb: Record<string, string>): string {
  const j = JSON.parse(feedOf(features, lastUpdated)) as { properties: { conditions: { forecasts: { date: string; fdr: Record<string, string>; tfb: Record<string, string> }[] } } };
  const today = j.properties.conditions.forecasts.find((f) => f.date === "2026-09-26T14:00:00.000Z")!;
  Object.assign(today.fdr, fdr);
  Object.assign(today.tfb, tfb);
  return JSON.stringify(j);
}

/** full.liquid's nb_alarm: an Extreme+ word after the name, or a ban as the last " · " part. */
const nbAlarm = (line: string) => /: (CATASTROPHIC|EXTREME)\b/.test(line) || ["TFB", "TOTAL FIRE BAN"].includes(line.split(" · ").at(-1)!);

describe("[r3] the events copy's own Catastrophic and ban stay as long as its house warning", () => {
  const houseEW = (t: number) => warning({ id: "EW-H", level: "Emergency Warning", action: "Leave immediately", geometry: square(SUBURB, 0, 0, 3), updated: t });

  async function eventsOnly(age: number, features: unknown[], fdr: string, tfb: string) {
    const kv = fakeKv();
    const t1 = T_QUIET - age;
    await build({ now: t1, kv: kv.kv, bodies: { events: feedWithConditions(features, t1 - MIN, { Central: fdr }, { Central: tfb }) } });
    clearMemory();
    return build({ now: T_QUIET, kv: kv.kv, over: { events: down503, osom: down503, cfa: down503, bom_fdr: down503 } });
  }

  it("a 2 h old copy: the house warning, CATASTROPHIC and the ban are all LAST KNOWN", async () => {
    const { g, p, html } = await eventsOnly(2 * HOUR, [houseEW(T_QUIET - 2 * HOUR - 5 * MIN)], "CATASTROPHIC", YES);
    expect(g.events.state).toBe("unavailable");
    expect(p.house).toMatchObject({ status: "in_warning", level: "EMERGENCY WARNING", issued: "LAST KNOWN 14:59" });
    expect(p.days[0].fdr).toEqual({ level: 4, word: "CATASTROPHIC", action: "For your survival, leave bushfire risk areas", issued: "LAST KNOWN 14:59" });
    expect(p.days[0].tfb).toEqual({ state: "declared", text: "TOTAL FIRE BAN · as of 14:59" });
    expect(band(html)).toContain("CATASTROPHIC");
  });

  it("but never an all-clear from it: a 2 h old MODERATE and no ban are not shown", async () => {
    const { p } = await eventsOnly(2 * HOUR, [houseEW(T_QUIET - 2 * HOUR - 5 * MIN)], "MODERATE", "NO - RESTRICTIONS MAY APPLY");
    expect(p.house.status).toBe("in_warning");
    expect(p.days[0].fdr).toMatchObject({ level: -1, word: "RATING UNAVAILABLE" });
    expect(p.days[0].tfb).toEqual({ state: "unknown", text: "TFB status unavailable" });
  });

  it("and not past 6 h", async () => {
    const { p } = await eventsOnly(7 * HOUR, [], "CATASTROPHIC", YES);
    expect(p.ok).toBe(false);
    expect(p.days[0].fdr.level).toBe(-1);
  });
});

describe("[r4] alarm-only: an Emergency Warning with no usable location is named, not dropped", () => {
  const unplaced = (level: string, action: string) => warning({ id: "U1", level, action, geometry: null, location: "North Warrandyte", updated: T_QUIET - HOUR - 10 * MIN });

  async function alarmOnly(feature: unknown) {
    const kv = fakeKv();
    const t1 = T_QUIET - HOUR;
    await build({ now: t1, kv: kv.kv, bodies: { events: feedOf([feature], t1 - MIN) } });
    clearMemory();
    return build({ now: T_QUIET, kv: kv.kv, over: { events: down503 } });
  }

  it("the panel says what was last known, and the house is not called clear", async () => {
    const { g, p, html } = await alarmOnly(unplaced("Emergency Warning", "Leave immediately"));
    expect(g.events.state).toBe("unavailable");
    expect(p.house).toEqual({ status: "unknown" });
    expect(p.incidents.ok).toBe(false);
    expect(p.incidents.error_text).toBe("Last known 15:59: EMERGENCY WARNING · location unknown · North Warrandyte");
    expect(text(html)).toContain("EMERGENCY WARNING");
    expect(band(html)).toContain("WARNINGS UNAVAILABLE");
  });

  it("an Advice keeps the plain feed message", async () => {
    const { p } = await alarmOnly(unplaced("Advice", "Stay informed"));
    expect(p.incidents.error_text).toBe("The VicEmergency feed could not be read since Sun 15:59.");
  });

  it("with every rating source down too, the normal layout stays so the warning is still named", async () => {
    const kv = fakeKv();
    const t1 = T_QUIET - HOUR;
    await build({ now: t1, kv: kv.kv, bodies: { events: feedOf([unplaced("Emergency Warning", "Leave immediately")], t1 - MIN) } });
    clearMemory();
    const { p, html } = await build({ now: T_QUIET, kv: kv.kv, over: { events: down503, osom: down503, cfa: down503, bom_fdr: down503 } });
    expect(p.ok).toBe(true);
    expect(p.days[0].fdr.level).toBe(-1);
    expect(p.incidents.error_text).toMatch(/^Last known 15:59: EMERGENCY WARNING/);
    expect(text(html)).toContain("EMERGENCY WARNING");
  });
});

describe("[r5] the warnings count covers every warning listed", () => {
  it("a statewide Watch and Act over the house counts: never '0 warnings' beside it", async () => {
    const heat = warning({ id: "SW-HEAT", level: "Watch and Act", action: "Stay indoors", geometry: null, event: "Extreme Heat", location: "Victoria" });
    (heat.properties as Record<string, unknown>).statewide = "Y";
    const { p, html } = await build({ bodies: { events: feedOf([heat]) } });
    expect(p.house).toMatchObject({ status: "in_warning", kicker: "STATEWIDE WARNING · EXTREME HEAT" });
    expect(p.incidents.rows!.map((r) => r.line1)).toEqual(["IN AREA · WATCH AND ACT"]);
    expect(p.incidents.counts![0]).toMatchObject({ n: "1", label: "warnings", hot: true });
    expect(text(html)).not.toMatch(/\b0 warnings\b/);
  });

  it("a statewide Advice is not over the house, so it is neither listed nor counted", async () => {
    const heat = warning({ id: "SW-ADV", level: "Advice", action: "Stay informed", geometry: null, event: "Extreme Heat", location: "Victoria" });
    (heat.properties as Record<string, unknown>).statewide = "Y";
    const { p } = await build({ bodies: { events: feedOf([heat]) } });
    expect(p.house.status).toBe("clear");
    expect(p.incidents.rows).toEqual([]);
    expect(p.incidents.counts![0]).toMatchObject({ n: "0", label: "warnings" });
  });
});

describe("[r6] a neighbour's alarm from a stale copy says how old it is", () => {
  const NOW = T_QUIET;
  const TODAY = localDate(NOW);
  const res = <T,>(id: SourceResult<T>["id"], data: T | null, state: SourceResult<T>["state"], asOf: number | null): SourceResult<T> => ({ id, state, data, asOf, fetchedAt: asOf, error: null });
  const feed = (fdr: Partial<Record<DistrictKey, string>>, tfb: Partial<Record<DistrictKey, string>>): RatingsFeed => ({
    fdr: { [TODAY]: fdr as Record<string, string> },
    tfb: { [TODAY]: tfb as Record<string, string> },
    declaration: {},
    notYet: [],
    issued: {},
  });
  const inputs = (o: Partial<RatingInputs>): RatingInputs => ({
    dates: [TODAY, addDays(TODAY, 1)],
    now: NOW,
    district: "central",
    osom: res<RatingsFeed>("osom", null, "unavailable", null),
    conditions: res<RatingsFeed>("events", null, "unavailable", null),
    cfa: res<RatingsFeed>("cfa", null, "unavailable", null),
    bomFdr: res<BomFdr>("bom_fdr", null, "unavailable", null),
    ...o,
  });

  it("probe E: a 3 h old OSOM's North Central CATASTROPHIC and ban carry 14:00", () => {
    const i = inputs({ osom: res("osom", feed({ central: "EXTREME", north_central: "CATASTROPHIC" }, { central: YES, north_central: YES }), "stale", NOW - 3 * HOUR) });
    expect(buildRatings(i)[0].fdr.issued).toBe("LAST KNOWN 14:00");
    const line = neighbourLine("north_central", TODAY, i);
    expect(line).toBe("N Central: CATASTROPHIC · 14:00 · TFB");
    expect(nbAlarm(line)).toBe(true);
  });

  it("a stale ban beside a fresh HIGH keeps the ban last, where the template finds it", async () => {
    const i = inputs({
      osom: res("osom", feed({ north_central: "HIGH" }, { north_central: YES }), "stale", NOW - 3 * HOUR),
      cfa: res("cfa", feed({ north_central: "HIGH" }, { north_central: "NO - RESTRICTIONS MAY APPLY" }), "ok", NOW - 5 * MIN),
    });
    const line = neighbourLine("north_central", TODAY, i);
    expect(line).toBe("North Central: HIGH · 14:00 · TFB");
    expect(nbAlarm(line)).toBe(true);

    // With the band taken and the statewide line in the one free slot, only an alarm moves in.
    const busy = [1, 2, 3, 4, 5, 6].map((k) => fire({ id: `G${k}`, north: 3 * k, east: 2, status: "Going" }));
    const { p } = await build({ bodies: { events: feedOf(busy) } });
    expect(p.incidents.rows).toHaveLength(5);
    const q: PayloadV1 = {
      ...p,
      statewide: "Statewide: Extreme Heat (Advice)",
      neighbours: line,
      house: { status: "in_warning", rank: 2, kicker: "IN A WARNING AREA · BUSHFIRE", level: "WATCH AND ACT", action: "PREPARE TO LEAVE · North Warrandyte", issued: "Issued 16:50" },
    };
    expect(text(render(q))).toContain(line);
  });

  it("a stale Extreme with no ban drops the ban word before the rating or the time", () => {
    const i = inputs({
      osom: res("osom", feed({ north_central: "CATASTROPHIC" }, {}), "stale", NOW - 3 * HOUR),
      cfa: res("cfa", feed({}, { north_central: "NO - RESTRICTIONS MAY APPLY" }), "ok", NOW - 5 * MIN),
    });
    expect(neighbourLine("north_central", TODAY, i)).toBe("North Central: CATASTROPHIC · 14:00");
  });

  it("every district, rating and ban: ≤ 38, timed, and still an alarm to the template", () => {
    const keys: DistrictKey[] = ["mallee", "wimmera", "northern_country", "north_east", "east_gippsland", "west_and_south_gippsland", "central", "north_central", "south_west"];
    for (const k of keys) {
      for (const word of ["EXTREME", "CATASTROPHIC"]) {
        for (const ban of [YES, "NO - RESTRICTIONS MAY APPLY", "MAYBE"]) {
          const i = inputs({
            district: k === "central" ? "north_central" : "central",
            osom: res("osom", feed({ [k]: word }, { [k]: YES }), "stale", NOW - 3 * HOUR),
            cfa: res("cfa", feed({}, ban === YES ? {} : { [k]: ban }), "ok", NOW - 5 * MIN),
          });
          // A stale YES is still a ban; a fresh NO beside it never lowers it.
          const line = neighbourLine(k, TODAY, i);
          expect(line.length, line).toBeLessThanOrEqual(38);
          expect(line, line).toMatch(/14:00/);
          expect(nbAlarm(line), line).toBe(true);
        }
        // No ban from anywhere: the rating alone is the alarm.
        const noBan = inputs({ district: k === "central" ? "north_central" : "central", osom: res("osom", feed({ [k]: word }, {}), "stale", NOW - 3 * HOUR) });
        const line = neighbourLine(k, TODAY, noBan);
        expect(line.length, line).toBeLessThanOrEqual(38);
        expect(line, line).toMatch(/14:00/);
        expect(line, line).toContain(`: ${word}`);
      }
    }
  });

  it("fresh lines are unchanged: no time", () => {
    const i = inputs({ osom: res("osom", feed({ north_central: "CATASTROPHIC" }, { north_central: YES }), "ok", NOW - 5 * MIN) });
    expect(neighbourLine("north_central", TODAY, i)).toBe("North Central: CATASTROPHIC · TFB");
  });
});

describe("[r7] the OLD DATA form still says how many rows are hidden", () => {
  const going = [1, 2, 3, 4, 5, 6, 7].map((k) => fire({ id: `G${k}`, north: 4 * k - 14, east: 4, status: "Going" }));

  it("probe H: 7 going fires in a 20 min old feed", async () => {
    const { p, html } = await build({ bodies: { events: feedOf(going, T_QUIET - 20 * MIN) } });
    expect(p.incidents.stale).toBe(true);
    expect(p.incidents.more).toBe(2);
    expect(p.incidents.as_at).toBe("OLD DATA 16:40 +2 more");
    expect(text(html)).toContain("+2 more");
  });

  it("'+N more' outranks '+N safe'", async () => {
    const safe = [fire({ id: "S1", north: 10, status: "Safe" }), fire({ id: "S2", north: -10, status: "Safe" })];
    const { p } = await build({ bodies: { events: feedOf([...going, ...safe], T_QUIET - 20 * MIN) } });
    expect(p.incidents.as_at).toMatch(/\+2 more/);
    expect(p.incidents.as_at).not.toMatch(/safe/);
  });
});

describe("[r8] the neighbour line: an alarm first, then the rating, then a ban", () => {
  const nb = (neighbours: DistrictKey[]): DistrictResult => ({ lookup: { key: "central", lga: "nillumbik", neighbours }, state: "ok", source: "vicmap" });
  const both: DistrictKey[] = ["north_central", "west_and_south_gippsland"];

  async function line(neighbours: DistrictKey[], fdr: Record<string, string>, tfb: Record<string, string>) {
    const osom = osomWith({ "27/09/2026": { fdr: { Central: "MODERATE", ...fdr }, tfb } });
    const { p } = await build({ district: nb(neighbours), bodies: { osom }, over: { cfa: down503, bom_fdr: down503 } });
    return p.neighbours;
  }

  it("probe I: on a tie in rating, the one under a ban wins, in either order", async () => {
    const fdr = { "North Central": "HIGH", "West and South Gippsland": "HIGH" };
    const tfb = { "North Central": "NO - RESTRICTIONS MAY APPLY", "West and South Gippsland": YES };
    expect(await line(both, fdr, tfb)).toBe("West and South Gippsland: HIGH · TFB");
    expect(await line([...both].reverse(), fdr, tfb)).toBe("West and South Gippsland: HIGH · TFB");
  });

  it("a ban under a lower rating still beats a higher rating without one: the ban is the alarm", async () => {
    const fdr = { "North Central": "HIGH", "West and South Gippsland": "MODERATE" };
    const tfb = { "North Central": "NO - RESTRICTIONS MAY APPLY", "West and South Gippsland": YES };
    expect(await line(both, fdr, tfb)).toBe("W&S Gippsland: MODERATE · TFB");
  });

  it("between alarms, the higher rating wins", async () => {
    const fdr = { "North Central": "EXTREME", "West and South Gippsland": "HIGH" };
    const tfb = { "North Central": "NO - RESTRICTIONS MAY APPLY", "West and South Gippsland": YES };
    expect(await line(both, fdr, tfb)).toBe("North Central: EXTREME · No TFB");
  });
});

// ---------------------------------------------------------------------------------------------

describe("[25] ?fixture= only takes the scenarios' own names", () => {
  it("?fixture=constructor is an unknown fixture, not an internal error", async () => {
    const original: Deps = { ...deps };
    try {
      deps.fetch = (() => Promise.reject(new Error("no upstream calls"))) as typeof fetch;
      deps.log = () => {};
      const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
      const res = await app.fetch(new Request("https://trmnl-fire-risk.test/v1/brief.json?fixture=constructor", { headers: { "x-brief-token": "t" } }), { BRIEF_TOKEN: "t" }, ctx);
      const p = (await res.json()) as PayloadV1;
      expect(res.status).toBe(200);
      expect(res.headers.get("x-brief-error")).toBe("fixture");
      expect(p).toMatchObject({ ok: false, sample: true, down_title: "CONFIGURATION ERROR" });
      expect(p.down_reason).toContain('Unknown fixture "constructor"');
    } finally {
      Object.assign(deps, original);
    }
  });
});
