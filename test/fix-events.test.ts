/**
 * Review fixes for classification and the house's neighbourhood: which house warning takes the band
 * (local before statewide at equal level), district-sized fires with odd statuses stay fires, burns
 * feeds that report a fire, warnings with no usable location kept as warnings, and clean()'s cost.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clean, kindOf } from "../src/classify.js";
import { gather } from "../src/gather.js";
import { extractGeo } from "../src/geo.js";
import { buildNear } from "../src/near.js";
import { buildPayload } from "../src/payload.js";
import { parseEvents } from "../src/sources/vicemergency.js";
import { clearMemory } from "../src/store.js";
import type { EventsFeed, Home } from "../src/types.js";
import { at, band, eventsBody, MIN, render, square, SUBURB, T_QUIET, text, upstream } from "./helpers.js";

beforeEach(() => {
  clearMemory();
});

const NOW = T_QUIET;
const iso = (ms: number) => new Date(ms).toISOString();
type Props = Record<string, unknown>;

let seq = 0;
const feature = (props: Props, geometry: unknown) => ({ type: "Feature", properties: { id: `FX${++seq}`, ...props }, geometry });
const pt = (c: [number, number]) => ({ type: "Point", coordinates: c });
const warning = (props: Props, geometry: unknown) =>
  feature(
    {
      feedType: "warning",
      sourceOrg: "EMV",
      sourceFeed: "cop-cap",
      category1: "Watch and Act",
      category2: "Fire",
      action: "Prepare to leave",
      statewide: "N",
      location: "North Warrandyte",
      cap: { event: "Bushfire" },
      created: iso(NOW - 60 * MIN),
      updated: iso(NOW - 30 * MIN),
      ...props,
    },
    geometry,
  );
const fire = (props: Props, geometry: unknown) =>
  feature(
    {
      feedType: "incident",
      sourceOrg: "VIC/DEECA",
      sourceFeed: "deeca-incident",
      category1: "Fire",
      category2: "Bushfire",
      status: "Going",
      location: "Kinglake NP",
      created: iso(NOW - 3 * 3600_000),
      updated: iso(NOW - 20 * MIN),
      ...props,
    },
    geometry,
  );
const feedOf = (...features: unknown[]): EventsFeed => parseEvents({ type: "FeatureCollection", properties: {}, features })!;
const near = (...features: unknown[]) => buildNear(feedOf(...features), SUBURB, 30, NOW);

/** A local bushfire Watch and Act over the house, and a statewide heat one updated later. */
const LOCAL_WA = () => warning({ id: "LOCAL-WA", updated: iso(NOW - 40 * MIN) }, square(SUBURB, 0, 0, 3));
const STATE_WA = () =>
  warning(
    { id: "STATE-WA", statewide: "Y", category2: "Extreme Heat", cap: { event: "Extreme Heat" }, action: "Stay indoors", location: "Victoria", updated: iso(NOW - 5 * MIN) },
    square(SUBURB, 300, 0, 1),
  );

/** A district-sized extent: one point 7 km north and a stray coordinate 60 km away. */
const bigFireGeo = () => ({ type: "GeometryCollection", geometries: [pt(at(SUBURB, 7)), pt(at(SUBURB, -60, 60))] });

async function build(features: unknown[], home: Home = SUBURB) {
  const up = upstream(NOW, {}, { events: eventsBody({ features }) });
  const g = await gather({ home, district: null, radiusKm: 30 }, { fetch: up.fetch, now: () => NOW, kv: null, log: () => {} });
  const p = buildPayload(g);
  return { p, html: render(p) };
}

// ---------------------------------------------------------------------------------------------

describe("[1] house warning order: level, then local before statewide, then newest", () => {
  it("a newer statewide Watch and Act does not take the band from a local one over the house", () => {
    const n = near(STATE_WA(), LOCAL_WA());
    expect(n.houseWarnings.map((w) => w.f.id)).toEqual(["LOCAL-WA", "STATE-WA"]);
  });

  it("a statewide Emergency Warning still outranks a local Watch and Act", () => {
    const n = near(LOCAL_WA(), warning({ id: "STATE-EW", statewide: "Y", category1: "Emergency Warning", action: "Leave immediately" }, null));
    expect(n.houseWarnings.map((w) => w.f.id)).toEqual(["STATE-EW", "LOCAL-WA"]);
  });

  it("a local Emergency Warning outranks a statewide Watch and Act, and equal local ones stay newest first", () => {
    const n = near(
      STATE_WA(),
      warning({ id: "OLD", updated: iso(NOW - 50 * MIN) }, square(SUBURB, 0, 0, 4)),
      warning({ id: "NEW", updated: iso(NOW - 2 * MIN) }, square(SUBURB, 0, 0, 5)),
      warning({ id: "EW", category1: "Emergency Warning", action: "Leave immediately" }, square(SUBURB, 0, 0, 2)),
    );
    expect(n.houseWarnings.map((w) => w.f.id)).toEqual(["EW", "NEW", "OLD", "STATE-WA"]);
  });

  it("the band gives the local fire instruction, not the statewide heat one", async () => {
    const { p, html } = await build([STATE_WA(), LOCAL_WA()]);
    expect(p.house.status).toBe("in_warning");
    const b = text(band(html)).toUpperCase();
    expect(b).toContain("PREPARE TO LEAVE");
    expect(b).not.toContain("STAY INDOORS");
    expect(b).not.toContain("STATEWIDE WARNING");
  });
});

describe("[6] a district-sized incident is an area product only when its status is a rating or ban", () => {
  const big = extractGeo(bigFireGeo());
  const poly = extractGeo({ type: "Polygon", coordinates: [[[144, -38], [145, -38], [145, -37], [144, -37], [144, -38]]] });
  const inc = (status: unknown, c1 = "Fire", c2 = "Bushfire") => ({ feedType: "incident", sourceOrg: "VIC/CFA", sourceFeed: "cfa-incident", category1: c1, category2: c2, status });

  it("keeps a large fire with an unknown, blank, missing or new status as a fire", () => {
    for (const g of [big, poly]) {
      for (const s of ["Unknown", "", null, undefined, "  ", "Escalating", "Abandoned", "Urban interface", "Going", "Safe"]) {
        expect(kindOf(inc(s), g), String(s)).toBe("fire");
      }
      // A large non-fire incident with an odd status stays visible as an other call.
      expect(kindOf(inc("Unknown", "Flood", "Riverine"), g)).toBe("other");
    }
  });

  it("still treats a large pseudo-incident with a rating or ban status as an area product", () => {
    for (const s of ["CATASTROPHIC", "Extreme", "high", "Moderate", "NO RATING", "NO_FORECAST", "Total Fire Ban in force", "TFB declared", "Fire Danger Rating", "No fire bans"]) {
      expect(kindOf(inc(s, "Fire", "New Product"), poly), s).toBe("area_product");
    }
    // Small, it is an incident whatever it says.
    expect(kindOf(inc("CATASTROPHIC", "Fire", "New Product"), extractGeo(pt([145, -37.5])))).toBe("fire");
  });

  it("counts a large fire with status Unknown or null 7 km away as going", () => {
    const n = near(fire({ id: "BIG-UNKNOWN", status: "Unknown" }, bigFireGeo()), fire({ id: "BIG-NULL", status: null, sourceOrg: "VIC/CFA", sourceFeed: "cfa-incident", location: "Other Rd" }, { type: "GeometryCollection", geometries: [pt(at(SUBURB, -12, 3)), pt(at(SUBURB, 50, -60))] }));
    expect(n.areaProducts).toHaveLength(0);
    expect(n.fires.map((c) => [c.lead.id, c.bucket])).toEqual([
      ["BIG-UNKNOWN", "active"],
      ["BIG-NULL", "active"],
    ]);
    expect(n.fires[0]!.km).toBeCloseTo(7, 0);
  });

  it("shows it on the screen as a going fire", async () => {
    const { p } = await build([fire({ status: "Unknown" }, bigFireGeo())]);
    expect(p.incidents.ok).toBe(true);
    expect(p.incidents.counts![1]).toMatchObject({ label: "going", n: "1" });
    expect(p.incidents.empty_text).toBeUndefined();
  });
});

describe("[7] local warnings with no usable coordinate are kept, not just counted", () => {
  it("lists them most severe first, excluding statewide ones, with the count matching", () => {
    const n = near(
      warning({ id: "WA-NULL", updated: iso(NOW - 1 * MIN) }, null),
      warning({ id: "EW-ZERO", category1: "Emergency Warning", action: "Leave immediately", updated: iso(NOW - 30 * MIN) }, pt([0, 0])),
      warning({ id: "ADV-SWAPPED", category1: "Advice", action: "Stay informed" }, pt([145.22, 37.73])),
      warning({ id: "STATE-NULL", statewide: "Y", category1: "Advice" }, null),
      warning({ id: "LOCATED" }, square(SUBURB, 0, 0, 3)),
    );
    expect(n.unlocatedWarningList.map((f) => f.id)).toEqual(["EW-ZERO", "WA-NULL", "ADV-SWAPPED"]);
    expect(n.unlocatedWarnings).toBe(3);
    expect(n.unlocatedWarningList[0]).toMatchObject({ kind: "warning", level: 3, action: "Leave immediately", location: "North Warrandyte", statewide: false });
    expect(n.statewide.map((w) => w.f.id)).toEqual(["STATE-NULL"]);
    expect(n.houseWarnings.map((w) => w.f.id)).toEqual(["LOCATED"]);
  });

  it("is empty when every warning is placed", () => {
    const n = near(warning({}, square(SUBURB, 0, 0, 3)));
    expect(n.unlocatedWarningList).toEqual([]);
    expect(n.unlocatedWarnings).toBe(0);
  });

  it("does not list the same warning twice", () => {
    const w = warning({ id: "DUP" }, null);
    const n = near(w, w);
    expect(n.unlocatedWarningList.map((f) => f.id)).toEqual(["DUP"]);
    expect(n.unlocatedWarnings).toBe(1);
  });
});

describe("[20] a burns feed reporting a Fire is a fire", () => {
  const burnsFire = (props: Props = {}) =>
    fire({ sourceFeed: "deeca-burns", category1: "Fire", category2: "Bushfire", status: "Going", ...props }, pt(at(SUBURB, 6)));

  it("classifies by category, not by the feed's name", () => {
    const geo = extractGeo(null);
    expect(kindOf({ feedType: "incident", sourceFeed: "deeca-burns", category1: "Fire", category2: "Bushfire" }, geo)).toBe("fire");
    expect(kindOf({ feedType: "incident", sourceFeed: "delwp-burns", category1: " FIRE ", category2: "Grass" }, geo)).toBe("fire");
    expect(kindOf({ feedType: "incident", sourceFeed: "deeca-burns", category1: "Planned Burn", category2: "Planned Burn" }, geo)).toBe("burn");
    expect(kindOf({ feedType: "incident", sourceFeed: "deeca-burns", category1: "Other" }, geo)).toBe("burn");
    // Planned-burn categories win even when category1 says Fire.
    expect(kindOf({ feedType: "incident", sourceFeed: "deeca-burns", category1: "Fire", category2: "Planned Burn" }, geo)).toBe("burn");
  });

  it("counts an escaped burn as a going fire, not a planned burn", () => {
    const n = near(burnsFire({ id: "ESCAPED" }));
    expect(n.burns).toHaveLength(0);
    expect(n.fires.map((c) => [c.lead.id, c.bucket, c.rank])).toEqual([["ESCAPED", "active", 3]]);
  });

  it("shows it as going on the screen", async () => {
    const { p } = await build([burnsFire()]);
    expect(p.incidents.counts![1]).toMatchObject({ label: "going", n: "1" });
    expect(p.incidents.counts![3]).toMatchObject({ label: "burns", n: "0" });
    expect(p.incidents.rows?.some((r) => r.kind === "burn")).toBe(false);
  });
});

describe("[26] clean() is linear on runs of '<'", () => {
  it("strips tags as before", () => {
    expect(clean("<b>Leave</b>&nbsp;now\u0007\n  please")).toBe("Leave now please");
    expect(clean("&lt;script&gt;alert&lt;/script&gt; now")).toBe("alert now");
    expect(clean("a < b and c > d")).toBe("a d");
    expect(clean("<p class='x'>Stay <i>informed</i></p>")).toBe("Stay informed");
    // A stray '<' before a tag no longer joins the tag, but the tag itself still goes.
    const s = clean("x <<b>y");
    expect(s).not.toMatch(/b>/);
    expect(s).toMatch(/^x .*y$/);
  });

  it("stays fast on hostile runs of '<'", () => {
    // The old /<[^>]*>/ took ~25 ms per 4 KB run; forty of them would take about a second.
    const run = "<".repeat(4096);
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) expect(clean(i % 2 ? run : `${run}x>`, 60).length).toBeLessThanOrEqual(60);
    expect(clean([run, run, run], 60).length).toBeLessThanOrEqual(60);
    expect(clean("<a".repeat(2048), 60).length).toBeLessThanOrEqual(60);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});
