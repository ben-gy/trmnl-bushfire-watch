import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agencyOf, clean, fireRank, isVegetation, kindOf, statusBucket, warningLevel } from "../src/classify.js";
import { extractGeo, haversineKm } from "../src/geo.js";
import { buildNear, type NearSummary } from "../src/near.js";
import { EVENTS_URL, parseEvents } from "../src/sources/vicemergency.js";
import type { EventsFeed, Home, NormFeature } from "../src/types.js";

const raw = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const load = (name: string): EventsFeed => {
  const f = parseEvents(raw(name));
  if (!f) throw new Error(`${name} did not parse`);
  return f;
};

const LIVE = "events-2026-09-27T1656.json";
const JAN = "events-2026-01-09.json";
const MAR = "events-2025-03-31.json";

// Suburb-level test points, never a real house.
const SUBURB: Home = { lat: -37.73, lon: 145.22 };
const KINGLAKE: Home = { lat: -37.53, lon: 145.34 };
const MACEDON: Home = { lat: -37.42, lon: 144.56 };
const HORSHAM: Home = { lat: -36.7167, lon: 142.1997 };
const SEDGWICK: Home = { lat: -36.9, lon: 144.35 };
const NOW = Date.parse("2026-01-09T08:00:00Z");

const jan = load(JAN);
const near = (h: Home, feed = jan, km = 30): NearSummary => buildNear(feed, h, km, NOW);
const ids = (xs: { f: NormFeature }[]) => xs.map((x) => x.f.id);

/** The label point of a raw fixture feature, for comparing against the polygon distance. */
function labelKm(name: string, id: string, h: Home): number {
  const fc = raw(name) as { features: { properties: { id: unknown }; geometry: unknown }[] };
  const feat = fc.features.find((x) => String(x.properties.id) === id)!;
  const p = extractGeo(feat.geometry).points[0]!;
  return haversineKm(h, { lat: p[1], lon: p[0] });
}

// ---------------------------------------------------------------------------------------------
// Synthetic features

type Props = Record<string, unknown>;
const KM_LAT = 1 / 111.0;
/** A point `north` / `east` km from home. */
const at = (h: Home, north: number, east = 0): [number, number] => [
  h.lon + east / (111.32 * Math.cos((h.lat * Math.PI) / 180)),
  h.lat + north * KM_LAT,
];
const pt = (c: [number, number]) => ({ type: "Point", coordinates: c });
/** A square polygon `half` km either side of a centre. */
function square(h: Home, north: number, east: number, half: number) {
  const ring = [
    at(h, north - half, east - half),
    at(h, north - half, east + half),
    at(h, north + half, east + half),
    at(h, north + half, east - half),
    at(h, north - half, east - half),
  ];
  return { type: "Polygon", coordinates: [ring] };
}
let seq = 0;
const feature = (props: Props, geometry: unknown) => ({ type: "Feature", properties: { id: `S${++seq}`, ...props }, geometry });
const fire = (props: Props, c: [number, number]) =>
  feature(
    {
      feedType: "incident",
      sourceOrg: "VIC/CFA",
      sourceFeed: "cfa-incident",
      category1: "Fire",
      category2: "Bushfire",
      status: "Going",
      created: "2026-01-09T06:00:00Z",
      updated: "2026-01-09T06:30:00Z",
      location: "Somewhere Rd",
      ...props,
    },
    pt(c),
  );
const warning = (props: Props, geometry: unknown) =>
  feature({ feedType: "warning", sourceOrg: "EMV", sourceFeed: "cop-cap", category1: "Watch and Act", category2: "Fire", action: "Prepare to Leave", statewide: "N", ...props }, geometry);
const feedOf = (...features: unknown[]): EventsFeed => parseEvents({ type: "FeatureCollection", properties: {}, features })!;

// ---------------------------------------------------------------------------------------------

describe("warnings drive the headline (9 Jan 2026)", () => {
  it("Horsham is inside a Watch and Act with no active fire within 30 km", () => {
    const n = near(HORSHAM);
    const top = n.houseWarnings[0]!;
    expect(top.f.id).toBe("39307");
    expect(top.f.level).toBe(2);
    expect(top.f.cat1).toBe("Watch and Act");
    expect(top.inArea).toBe(true);
    expect(n.fires.filter((c) => c.bucket === "active")).toHaveLength(0);
    // The Emergency Warning next door is listed first among nearby ones, by level.
    expect(n.nearbyWarnings[0]!.f.id).toBe("39255");
    expect(n.nearbyWarnings[0]!.km).toBeCloseTo(1.73, 1);
    // "0 fires" never reads as "nothing around".
    expect(n.nearestActiveBeyond).not.toBeNull();
    expect(n.nearestActiveBeyond!.km).toBeGreaterThan(30);
    expect(n.nearestActiveBeyond!.km).toBeLessThanOrEqual(100);
  });

  it("measures Kinglake's Emergency Warning by its edge (9.7 km), not its label point (28 km)", () => {
    const n = near(KINGLAKE);
    const ew = n.nearbyWarnings.find((w) => w.f.id === "39350")!;
    expect(ew.f.level).toBe(3);
    expect(Math.abs(ew.km - 9.7)).toBeLessThanOrEqual(0.3);
    expect(ew.approx).toBe(false);
    expect(labelKm(JAN, "39350", KINGLAKE)).toBeGreaterThan(27.5);
    // Kinglake itself is inside the Watch and Act.
    expect(ids(n.houseWarnings)).toEqual(["39340"]);
  });

  it("includes the Kinglake Watch and Act from the suburb at 21.5 km although its label is 31 km away", () => {
    const n = near(SUBURB);
    const wa = n.nearbyWarnings.find((w) => w.f.id === "39340")!;
    expect(wa.f.level).toBe(2);
    expect(Math.abs(wa.km - 21.5)).toBeLessThanOrEqual(0.5);
    expect(labelKm(JAN, "39340", SUBURB)).toBeGreaterThan(30);
    expect(n.houseWarnings).toHaveLength(0);
    // The Emergency Warnings beyond 30 km by edge stay out.
    expect(ids(n.nearbyWarnings)).toEqual(["39340"]);
  });
});

describe("area products, Met warnings and statewide warnings (9 Jan 2026)", () => {
  const areaIds = jan.features.filter((f) => f.feed === "cfa-fdr" || f.feed === "cfa-fdrtfb").map((f) => f.id);
  const metIds = jan.features.filter((f) => f.feed.startsWith("bom-")).map((f) => f.id);

  it("classifies cfa-fdr / cfa-fdrtfb as area products and BoM features as Met, never fires", () => {
    expect(areaIds).toHaveLength(2);
    expect(metIds).toHaveLength(3);
    for (const f of jan.features) {
      if (areaIds.includes(f.id)) expect(f.kind).toBe("area_product");
      if (metIds.includes(f.id)) expect(f.kind).toBe("met_warning");
    }
  });

  it("keeps them out of every count at every test point", () => {
    for (const h of [SUBURB, KINGLAKE, MACEDON, HORSHAM]) {
      const n = near(h);
      const counted = [...n.fires.flatMap((c) => c.members.map((m) => m.id)), ...ids(n.burns), ...ids(n.nearbyWarnings)];
      for (const id of [...areaIds, ...metIds]) expect(counted).not.toContain(id);
    }
  });

  it("lists the ones containing home, for the rating cross-check", () => {
    const k = near(KINGLAKE);
    expect(k.areaProducts.map((a) => a.f.status).sort()).toEqual(["CATASTROPHIC", "TOTAL FIRE BAN IN FORCE"]);
    // Central (the suburb) was Extreme, so only the TFB product covers it.
    expect(near(SUBURB).areaProducts.map((a) => a.f.status)).toEqual(["TOTAL FIRE BAN IN FORCE"]);
    expect(near(SUBURB).met.map((m) => m.f.cat2)).toEqual(["Weather"]);
  });

  it("puts the three statewide warnings in statewide, and none of them (all below Watch and Act) over the house", () => {
    const n = near(SUBURB);
    expect(ids(n.statewide).sort()).toEqual(["39070", "39380", "39386"]);
    expect(n.statewide.every((s) => s.inArea && s.km === 0)).toBe(true);
    expect(n.houseWarnings).toHaveLength(0);
    expect(ids(n.nearbyWarnings)).not.toContain("39386");
  });
});

describe("storm day at the suburb (9 Jan 2026)", () => {
  const n = near(SUBURB);
  it("never counts SES or other non-fire jobs as fires", () => {
    const members = n.fires.flatMap((c) => c.members);
    expect(members.some((m) => m.agency === "SES")).toBe(false);
    expect(members.every((m) => m.kind === "fire")).toBe(true);
    expect(jan.features.filter((f) => f.agency === "SES").every((f) => f.kind === "other")).toBe(true);
  });
  it("counts 82 non-fire calls (SES 74, CFA 4, FRV 4) and only the 4 non-fire CFA ones as other CFA", () => {
    expect(n.otherCalls).toBe(82);
    expect(n.otherCfa).toBe(4);
  });
  it("counts 7 fire jobs: 2 active, 2 controlled, 3 safe", () => {
    expect(n.fires.map((c) => c.bucket)).toEqual(["active", "active", "controlled", "controlled"]);
    expect(n.safeFires).toBe(3);
    // Sorted by rank, then vegetation, then distance.
    expect(n.fires[0]!.lead.location).toBe("Main Rd, Eltham");
    expect(n.fires[2]!.veg).toBe(true);
    expect(n.nearestActiveBeyond).toBeNull();
  });
});

describe("fire deduplication", () => {
  it("merges the Sedgwick CFA/DELWP pair and keeps the most severe status", () => {
    const pair = jan.features.filter((f) => f.kind === "fire" && /sedgwick/i.test(f.location));
    expect(pair.map((f) => f.agency).sort()).toEqual(["CFA", "DEECA"]);
    const [a, b] = pair.map((f) => f.geo.points[0]!);
    expect(haversineKm({ lat: a![1], lon: a![0] }, { lat: b![1], lon: b![0] })).toBeCloseTo(0.4, 1);
    const c = near(SEDGWICK).fires.find((x) => x.members.some((m) => pair.includes(m)))!;
    expect(c.members).toHaveLength(2);
    expect(c.status).toBe("Not Yet Under Control");
    expect(c.rank).toBe(3);
    expect(c.bucket).toBe("active");
    expect(c.lead.agency).toBe("CFA");
    expect(c.lead.location).toBe("Axe Creek Rd, Sedgwick");
    expect(c.agencies).toEqual(["CFA", "DEECA"]);
    expect(c.count).toBe(1);
  });

  it("merges the Greendale pair 2.3 km apart", () => {
    const c = near(MACEDON).fires.find((x) => /greendale/i.test(x.lead.location))!;
    expect(c.agencies.sort()).toEqual(["CFA", "DEECA"]);
    expect(c.members).toHaveLength(2);
  });

  it("keeps two fires of one agency 1 km apart separate", () => {
    const n = buildNear(feedOf(fire({}, at(SUBURB, 5)), fire({}, at(SUBURB, 6))), SUBURB, 30, NOW);
    expect(n.fires).toHaveLength(2);
  });

  it("does not fuse two CFA fires through a DEECA report between them", () => {
    const n = buildNear(
      feedOf(
        fire({}, at(SUBURB, 5)),
        fire({ sourceOrg: "VIC/DEECA", sourceFeed: "deeca-incident" }, at(SUBURB, 7.5)),
        fire({}, at(SUBURB, 10)),
      ),
      SUBURB,
      30,
      NOW,
    );
    expect(n.fires).toHaveLength(2);
    for (const c of n.fires) expect(c.members.filter((m) => m.agency === "CFA")).toHaveLength(1);
  });

  it("does not merge across agencies when created more than 12 h apart or unknown", () => {
    const deeca = { sourceOrg: "VIC/DEECA", sourceFeed: "deeca-incident" };
    const far = feedOf(fire({}, at(SUBURB, 5)), fire({ ...deeca, created: "2026-01-08T12:00:00Z" }, at(SUBURB, 5.5)));
    expect(buildNear(far, SUBURB, 30, NOW).fires).toHaveLength(2);
    const unknown = feedOf(fire({}, at(SUBURB, 5)), fire({ ...deeca, created: null }, at(SUBURB, 5.5)));
    expect(buildNear(unknown, SUBURB, 30, NOW).fires).toHaveLength(2);
  });

  it("collapses repeat jobs of one agency at one address into a row with a count", () => {
    const frv = { sourceOrg: "VIC/ESTA", sourceFeed: "esta-cad-event", category2: "Structure Fire", status: "Responding" };
    const n = buildNear(
      feedOf(
        fire(frv, at(SUBURB, 5)),
        fire({ ...frv, status: "Going" }, at(SUBURB, 5.1)),
        fire(frv, at(SUBURB, 5, 0.1)),
        fire({ ...frv, category2: "Car Fire" }, at(SUBURB, 5.1)),
      ),
      SUBURB,
      30,
      NOW,
    );
    expect(n.fires).toHaveLength(2);
    const row = n.fires[0]!;
    expect(row.count).toBe(3);
    expect(row.status).toBe("Going");
    expect(row.agencies).toEqual(["FRV"]);
  });

  it("never merges planned burns with fires", () => {
    const n = buildNear(
      feedOf(
        fire({}, at(SUBURB, 5)),
        feature({ feedType: "incident", sourceOrg: "VIC/DEECA", sourceFeed: "deeca-burns", category1: "Planned Burn", category2: "Planned Burn", status: "Going", created: "2026-01-09T06:00:00Z" }, pt(at(SUBURB, 5.2))),
      ),
      SUBURB,
      30,
      NOW,
    );
    expect(n.fires).toHaveLength(1);
    expect(n.fires[0]!.members).toHaveLength(1);
    expect(n.burns).toHaveLength(1);
  });
});

describe("live 27 Sep 2026 snapshot", () => {
  const live = load(LIVE);
  it("parses, drops earthquakes and keeps the feed time", () => {
    expect(live.features).toHaveLength(13);
    expect(live.features.some((f) => f.cat1 === "Earthquake")).toBe(false);
    expect(live.lastUpdated).toBe(Date.parse(String((raw(LIVE) as { properties: { lastUpdated: string } }).properties.lastUpdated)));
  });
  it("keys conditions by Melbourne date and district", () => {
    expect(live.conditions.map((c) => c.date)).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(live.conditions[0]!.fdr.central).toBe("MODERATE");
    expect(live.conditions[1]!.fdr.central).toBe("NO FORECAST");
    expect(live.conditions[0]!.tfb.north_central).toBe("NO - RESTRICTIONS MAY APPLY");
    expect(Object.keys(live.conditions[0]!.fdr)).toHaveLength(9);
  });
  it("classifies structure and building fires as fires, planned burns as burns", () => {
    const byC2 = (c2: string) => live.features.filter((f) => f.cat2 === c2);
    expect(byC2("Building Fire").every((f) => f.kind === "fire")).toBe(true);
    for (const feed of [live, jan, load(MAR)]) {
      for (const f of feed.features.filter((x) => x.cat2 === "Structure Fire")) expect(f.kind).toBe("fire");
    }
    expect(jan.features.filter((x) => x.cat2 === "Structure Fire")).toHaveLength(1);
    const burns = live.features.filter((f) => f.feed === "deeca-burns");
    expect(burns).toHaveLength(2);
    expect(burns.every((f) => f.kind === "burn" && f.agency === "DEECA")).toBe(true);
  });
  it("normalises a warning", () => {
    const w = live.features.find((f) => f.kind === "warning")!;
    expect(w).toMatchObject({ id: "43208", level: 1, levelRaw: "", event: "Bushfire", action: "Stay Informed", location: "Seacombe", statewide: false, agency: "EMV" });
    expect(w.geo.polygons).toHaveLength(1);
    expect(w.created).toBe(Date.parse("2026-09-26T22:56:47Z"));
  });
  it("finds the Dandenong building fire within 30 km of the suburb", () => {
    const n = buildNear(live, SUBURB, 30, Date.parse("2026-09-27T06:56:00Z"));
    expect(n.fires.map((c) => [c.lead.location, c.status])).toEqual([["Dandenong", "Not Yet Under Control"]]);
    expect(n.fires[0]!.veg).toBe(false);
  });
});

describe("legacy names (31 Mar 2025)", () => {
  const mar = load(MAR);
  it("recognises delwp-burns, delwp-incident and mfb-incident", () => {
    const by = (feed: string) => mar.features.filter((f) => f.feed === feed);
    expect(by("delwp-burns")).toHaveLength(35);
    expect(by("delwp-burns").every((f) => f.kind === "burn" && f.agency === "DEECA")).toBe(true);
    expect(by("delwp-incident").every((f) => f.kind === "fire" && f.agency === "DEECA")).toBe(true);
    expect(by("mfb-incident").every((f) => f.agency === "FRV")).toBe(true);
    expect(by("mfb-incident").filter((f) => f.kind === "fire").map((f) => f.cat2).sort()).toEqual(["Non Structure Fire", "Structure Fire"]);
    expect(by("mfb-incident").filter((f) => f.kind === "other")).toHaveLength(4);
    expect(by("bom-idv20600").every((f) => f.kind === "met_warning")).toBe(true);
  });
});

describe("classification rules", () => {
  const geo = extractGeo(null);
  it("classifies by feedType and category, not by who sent it", () => {
    expect(kindOf({ feedType: "incident", sourceOrg: "VIC/XYZ", sourceFeed: "xyz-incident", category1: "Fire", category2: "Structure Fire" }, geo)).toBe("fire");
    expect(kindOf({ feedType: " Incident ", category1: "FIRE", category2: "Something New" }, geo)).toBe("fire");
    expect(kindOf({ feedType: "incident", category1: "Tree Down" }, geo)).toBe("other");
    expect(kindOf({ feedType: "hazard", category1: "Fire" }, geo)).toBe("unclassified");
    expect(kindOf({}, geo)).toBe("unclassified");
    expect(kindOf({ feedType: "warning", category1: "Advice" }, geo)).toBe("warning");
    expect(kindOf({ feedType: "incident", category1: "Fire", category2: "Fire Danger Rating Today" }, geo)).toBe("area_product");
    expect(kindOf({ feedType: "incident", category1: "Fire", category2: "Fire Ban District" }, geo)).toBe("area_product");
    expect(kindOf({ feedType: "incident", sourceFeed: "cfa-prepare-fdr", category1: "Fire" }, geo)).toBe("area_product");
    expect(kindOf({ feedType: "incident", sourceOrg: "AU/BOM", category1: "Weather" }, geo)).toBe("met_warning");
    expect(kindOf({ feedType: "burn-area", category1: "Fire" }, geo)).toBe("burn");
    expect(kindOf({ feedType: "incident", sourceFeed: "xyz-burns", category1: "Burn Off" }, geo)).toBe("burn");
    // An escaped burn filed as a Fire on a burns feed is a fire.
    expect(kindOf({ feedType: "incident", sourceFeed: "xyz-burns", category1: "Fire" }, geo)).toBe("fire");
    expect(kindOf({ feedType: "earthquake" }, geo)).toBe("earthquake");
  });
  it("treats a district-sized pseudo-incident with a rating status as an area product, but never a large fire", () => {
    const big = extractGeo({ type: "Polygon", coordinates: [[[144, -38], [145, -38], [145, -37], [144, -37], [144, -38]]] });
    expect(kindOf({ feedType: "incident", category1: "Fire", category2: "New Product", status: "EXTREME" }, big)).toBe("area_product");
    expect(kindOf({ feedType: "incident", category1: "Fire", category2: "Bushfire", status: "Going" }, big)).toBe("fire");
  });
  it("maps statuses conservatively", () => {
    expect(statusBucket("Escalating")).toBe("active");
    expect(statusBucket(null as unknown as string)).toBe("active");
    expect(statusBucket("")).toBe("active");
    expect(statusBucket("Being Controlled")).toBe("active");
    expect(statusBucket("under control")).toBe("controlled");
    expect(statusBucket("Patrolled")).toBe("controlled");
    expect(statusBucket(" SAFE ")).toBe("safe");
    expect(statusBucket("Complete")).toBe("safe");
    expect(fireRank("Not Yet Controlled")).toBe(3);
    expect(fireRank("Out Of Control")).toBe(3);
    expect(fireRank("Request For Assistance")).toBe(2);
    expect(fireRank("Something New")).toBe(2);
    expect(fireRank(null as unknown as string)).toBe(2);
    expect(fireRank("Contained")).toBe(1);
    expect(fireRank("Safe")).toBe(0);
  });
  it("ranks warning levels, and never downgrades an unknown one", () => {
    expect(warningLevel("Emergency Warning", "")).toEqual({ level: 3, raw: "" });
    expect(warningLevel("Evacuate Now", "")).toEqual({ level: 3, raw: "Evacuate Now" });
    expect(warningLevel("Watch and Act", "")).toEqual({ level: 2, raw: "" });
    expect(warningLevel("Warning", "")).toEqual({ level: 2, raw: "" });
    expect(warningLevel("Major Flood Warning", "")).toEqual({ level: 2, raw: "" });
    expect(warningLevel("Advice", "")).toEqual({ level: 1, raw: "" });
    expect(warningLevel("Final Minor", "")).toEqual({ level: 1, raw: "" });
    expect(warningLevel("Community Update", "")).toEqual({ level: 0, raw: "" });
    expect(warningLevel("Bushfire Alert", "Stay informed")).toEqual({ level: 2, raw: "Bushfire Alert" });
    expect(warningLevel("Bushfire Alert", "Leave immediately")).toEqual({ level: 3, raw: "Bushfire Alert" });
    expect(warningLevel("", "")).toEqual({ level: 2, raw: "Level unknown" });
  });
  it("recognises vegetation fires and agencies", () => {
    expect(["Bushfire", "Grass Fire", "Scrub", "Crop Fire", "Haystack"].every(isVegetation)).toBe(true);
    expect(["Structure Fire", "Building Fire", "Car Fire", "Other"].some(isVegetation)).toBe(false);
    expect(agencyOf("VIC/CFA", "cfa-incident")).toBe("CFA");
    expect(agencyOf("VIC/ESTA", "esta-cad-event")).toBe("FRV");
    expect(agencyOf("VIC/XYZ", "mfb-incident")).toBe("FRV");
    expect(agencyOf("VIC/DELWP", "delwp-burns")).toBe("DEECA");
    expect(agencyOf("AU/BOM", "bom-idv20600")).toBe("BoM");
    expect(agencyOf("NSW/RFS", "rfs-cap")).toBe("RFS");
    expect(agencyOf("SA/CFS", "cfs-incident")).toBe("CFS");
    expect(agencyOf("QLD/QFES", "qfes")).toBe("Other");
  });
  it("cleans feed text", () => {
    expect(clean("<b>Leave</b>&nbsp;now\u0007\n  please")).toBe("Leave now please");
    expect(clean("call jo.bloggs@example.vic.gov.au now")).toBe("call [email removed] now");
    expect(clean("(jo@example.com).")).toBe("([email removed]).");
    const t0 = performance.now();
    expect(clean(`${"a".repeat(50_000)}@${"b".repeat(50_000)}.com`, 20)).toHaveLength(20);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(clean(null)).toBe("");
    expect(clean({ a: 1 })).toBe("");
    expect(clean(42)).toBe("42");
    expect(clean(["0 ha", "1 ha"])).toBe("0 ha, 1 ha");
    const long = clean("Castella, Kinglake, Kinglake Central, Kinglake East, Kinglake West, Pheasant Creek", 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toBe("Castella, Kinglake, Kinglake Central…");
  });
});

describe("unknowns stay visible", () => {
  it("counts unknown statuses as active and ranks unknown warning levels just below Emergency Warning", () => {
    const n = buildNear(
      feedOf(
        fire({ status: "Escalating" }, at(SUBURB, 5)),
        fire({ status: null }, at(SUBURB, 10)),
        warning({ category1: "Advice" }, square(SUBURB, 0, 0, 2)),
        warning({ category1: "Bushfire Alert", action: "Stay informed" }, square(SUBURB, 0, 0, 3)),
        warning({ category1: "Watch and Act" }, square(SUBURB, 0, 0, 4)),
        warning({ category1: "Emergency Warning" }, square(SUBURB, 0, 0, 5)),
      ),
      SUBURB,
      30,
      NOW,
    );
    expect(n.fires.map((c) => c.bucket)).toEqual(["active", "active"]);
    expect(n.houseWarnings.map((w) => w.f.levelRaw || w.f.cat1)).toEqual(["Emergency Warning", "Bushfire Alert", "Watch and Act", "Advice"]);
  });

  it("counts unclassified and unlocated features instead of dropping them", () => {
    const n = buildNear(
      feedOf(
        feature({ feedType: "hazard", category1: "Fire" }, pt(at(SUBURB, 3))),
        feature({ feedType: "hazard" }, null),
        feature({ feedType: "hazard" }, pt(at(SUBURB, 80))),
        fire({}, [0, 0]),
        fire({}, [145.22, 37.73]), // latitude sign flipped: outside Australia
        warning({}, null),
        { type: "Feature", geometry: null },
      ),
      SUBURB,
      30,
      NOW,
    );
    expect(n.unclassified).toBe(3); // near, null geometry, and the property-less feature
    expect(n.unlocated).toBe(2);
    expect(n.unlocatedWarnings).toBe(1);
    expect(n.fires).toHaveLength(0);
  });

  it("measures a point-only warning from its point, flagged approx, out to 50 km", () => {
    const n = buildNear(feedOf(warning({}, pt(at(SUBURB, 40))), warning({}, pt(at(SUBURB, 60)))), SUBURB, 30, NOW);
    expect(n.nearbyWarnings).toHaveLength(1);
    expect(n.nearbyWarnings[0]!.approx).toBe(true);
    expect(n.nearbyWarnings[0]!.km).toBeCloseTo(40, 0);
  });

  it("treats a house 150 m outside an edge as in the area, and a house in a hole as outside", () => {
    const edge = buildNear(feedOf(warning({}, square(SUBURB, 1.15, 0, 1))), SUBURB, 30, NOW);
    expect(edge.houseWarnings).toHaveLength(1);
    const outer = square(SUBURB, 0, 0, 5).coordinates[0]!;
    const hole = square(SUBURB, 0, 0, 2).coordinates[0]!;
    const holed = buildNear(feedOf(warning({}, { type: "Polygon", coordinates: [outer, hole] })), SUBURB, 30, NOW);
    expect(holed.houseWarnings).toHaveLength(0);
    expect(holed.nearbyWarnings[0]!.km).toBeCloseTo(2, 1);
  });

  it("lets a statewide Watch and Act cover the house", () => {
    const n = buildNear(feedOf(warning({ statewide: "Y", category1: "Watch and Act" }, square(SUBURB, 300, 0, 1))), SUBURB, 30, NOW);
    expect(n.statewide).toHaveLength(1);
    expect(n.houseWarnings).toHaveLength(1);
    expect(n.nearbyWarnings).toHaveLength(0);
  });
});

describe("parseEvents", () => {
  it("exports the feed URL", () => {
    expect(EVENTS_URL).toBe("https://emergency.vic.gov.au/public/events-geojson.json");
  });

  it("rejects anything that is not a FeatureCollection with a features array", () => {
    for (const junk of [null, undefined, "", "<html>", 42, [], {}, { type: "FeatureCollection" }, { type: "FeatureCollection", features: {} }, { type: "Feature", features: [] }]) {
      expect(parseEvents(junk)).toBeUndefined();
    }
    expect(parseEvents({ type: "FeatureCollection", features: [] })).toEqual({ lastUpdated: null, features: [], conditions: [] });
  });

  it("ignores undated forecasts and unknown district names", () => {
    const f = parseEvents({
      type: "FeatureCollection",
      features: [],
      properties: {
        conditions: {
          forecasts: [
            { date: "soon", fdr: { Central: "HIGH" } },
            { date: "2026-10-04T13:00:00.000Z", fdr: { Central: "HIGH", "Central Highlands": "EXTREME", "NORTH CENTRAL": "MODERATE" }, tfb: { Central: 1 } },
          ],
        },
      },
    })!;
    expect(f.conditions).toEqual([{ date: "2026-10-05", fdr: { central: "HIGH", north_central: "MODERATE" }, tfb: {} }]);
  });

  it("keeps no personal data from any fixture", () => {
    for (const name of [LIVE, JAN, MAR]) {
      const s = JSON.stringify(parseEvents(raw(name)));
      expect(s).not.toMatch(/[^\s@"]{1,64}@[^\s@"]{1,253}\.[a-z]{2,}/i);
      expect(s).not.toMatch(/"(contact|webBody|text|url|resources|incidentFeatures)"/);
    }
  });

  it("strips contact details, bodies and emails even when the feed carries them", () => {
    const s = JSON.stringify(
      feedOf(
        warning(
          {
            cap: { event: "Bushfire", contact: "duty.officer@example.vic.gov.au" },
            webBody: "<p>Call me</p>",
            text: "Contact duty.officer@example.vic.gov.au",
            url: "https://example.vic.gov.au/x",
            location: "Near <i>Foo</i> (ask jo@example.com)",
            incidentFeatures: [{ properties: { id: "dup" } }],
          },
          pt(at(SUBURB, 1)),
        ),
      ),
    );
    expect(s).not.toMatch(/@/);
    expect(s).not.toMatch(/contact|webBody|Call me|incidentFeatures|example\.vic/);
    expect(s).toContain("Near Foo (ask [email removed])");
  });
});
