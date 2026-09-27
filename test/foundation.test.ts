import { describe, expect, it } from "vitest";
import { DISTRICTS, districtAac, districtKey, districtName } from "../src/districts.js";
import { angDiff, bboxDistanceKm, compass16, extractGeo, frame, haversineKm, measure } from "../src/geo.js";
import { addDays, ageText, fmtDay, fmtTime, fmtWeekdayTime, fromDMY, fromLongDate, localDate, parseTime } from "../src/time.js";
import { all, first, parseXml, typed } from "../src/xml.js";

describe("time", () => {
  it("gives Melbourne calendar dates across the DST change", () => {
    expect(localDate(Date.parse("2026-09-26T14:00:00.000Z"))).toBe("2026-09-27");
    expect(localDate(Date.parse("2026-09-27T21:00:00Z"))).toBe("2026-09-28");
    expect(localDate(Date.parse("2026-10-03T13:59:00Z"))).toBe("2026-10-03");
    expect(localDate(Date.parse("2026-10-03T14:00:00Z"))).toBe("2026-10-04");
    // After DST starts local midnight is 13:00Z; a fixed +10 h would say 4 Oct here.
    expect(localDate(Date.parse("2026-10-04T13:00:00.000Z"))).toBe("2026-10-05");
    expect(localDate(Date.parse("2027-04-03T13:00:00Z"))).toBe("2027-04-04");
    expect(localDate(Date.parse("2027-04-04T14:00:00Z"))).toBe("2027-04-05");
  });
  it("formats with our own names", () => {
    expect(fmtDay("2026-09-27")).toBe("Sun 27 Sep");
    expect(fmtTime(Date.parse("2026-09-27T06:05:00Z"))).toBe("16:05");
    expect(fmtTime(Date.parse("2026-10-04T06:05:00Z"))).toBe("17:05");
    expect(fmtWeekdayTime(Date.parse("2026-09-27T06:05:00Z"))).toBe("Sun 16:05");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-10-03", 2)).toBe("2026-10-05");
    expect(ageText(0, 45 * 60_000)).toBe("45 min");
  });
  it("parses the feeds' date formats", () => {
    expect(fromDMY("27/09/2026")).toBe("2026-09-27");
    expect(fromDMY("2026-09-27")).toBeNull();
    expect(fromLongDate("Sunday, 27 September 2026")).toBe("2026-09-27");
    expect(fromLongDate("Thursday, 01 October 2026")).toBe("2026-10-01");
    expect(parseTime("2026-09-27T02:20:19.0020721Z")).toBe(Date.parse("2026-09-27T02:20:19.002Z"));
    expect(parseTime("2026-09-27T08:56:47+10:00")).toBe(Date.parse("2026-09-26T22:56:47Z"));
    expect(parseTime("2026-09-27T05:00:00-00:00")).toBe(Date.parse("2026-09-27T05:00:00Z"));
    expect(parseTime(null)).toBeNull();
    expect(parseTime("soon")).toBeNull();
    // Out-of-range instants are feed errors, and fmtTime throws beyond Date's range.
    expect(parseTime(1e17)).toBeNull();
    expect(parseTime(0)).toBeNull();
    expect(parseTime("1999-12-31T23:59:59Z")).toBeNull();
    expect(parseTime("2101-01-01T00:00:00Z")).toBeNull();
  });
});

describe("geo", () => {
  const home = { lat: -37.73, lon: 145.22 };
  const sq = (cx: number, cy: number, r: number): [number, number][] => [
    [cx - r, cy - r],
    [cx + r, cy - r],
    [cx + r, cy + r],
    [cx - r, cy + r],
    [cx - r, cy - r],
  ];
  it("measures polygons by containment and edge, ignoring label points", () => {
    const inside = extractGeo({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [146, -37] }, { type: "Polygon", coordinates: [sq(145.22, -37.73, 0.05)] }] });
    expect(measure(home, inside)).toMatchObject({ km: 0, inArea: true, via: "polygon" });
    const hole = extractGeo({ type: "Polygon", coordinates: [sq(145.22, -37.73, 0.2), sq(145.22, -37.73, 0.05)] });
    const mh = measure(home, hole)!;
    expect(mh.inArea).toBe(false);
    expect(mh.km).toBeGreaterThan(4);
    expect(mh.km).toBeLessThan(6);
    const multi = extractGeo({ type: "MultiPolygon", coordinates: [[sq(150, -30, 0.1)], [sq(145.22, -37.73, 0.01)]] });
    expect(measure(home, multi)!.inArea).toBe(true);
    // A polygon whose nearest edge is 150 m away counts as in the area.
    const near = extractGeo({ type: "Polygon", coordinates: [[[145.2217, -37.8], [145.3, -37.8], [145.3, -37.6], [145.2217, -37.6], [145.2217, -37.8]]] });
    const mn = measure(home, near)!;
    expect(mn.km).toBeGreaterThan(0.1);
    expect(mn.km).toBeLessThan(0.2);
    expect(mn.inArea).toBe(true);
  });
  it("measures points by great circle with a compass bearing", () => {
    const m = measure(home, extractGeo({ type: "Point", coordinates: [145.22, -37.53] }))!;
    expect(m.km).toBeCloseTo(22.2, 0);
    expect(compass16(m.bearing!)).toBe("N");
    expect(compass16(225)).toBe("SW");
    expect(compass16(-10)).toBe("N");
    expect(angDiff(350, 10)).toBe(20);
    expect(haversineKm(home, { lat: -37.814, lon: 144.963 })).toBeCloseTo(24.4, 0);
  });
  it("drops bad coordinates and reports no geometry as null", () => {
    expect(measure(home, extractGeo({ type: "Point", coordinates: [0, 0] }))).toBeNull();
    expect(measure(home, extractGeo(null))).toBeNull();
    expect(extractGeo({ type: "Point", coordinates: ["x", 1] }).points).toEqual([]);
  });
  it("prefilters by bbox without overestimating", () => {
    const g = extractGeo({ type: "Point", coordinates: [145.22, -37.53] });
    const b = bboxDistanceKm(frame(home), g.bbox);
    expect(b).toBeLessThanOrEqual(measure(home, g)!.km);
    expect(b).toBeGreaterThan(20);
    expect(bboxDistanceKm(frame(home), [145, -38, 146, -37])).toBe(0);
  });
});

describe("xml", () => {
  it("parses BoM-style nesting, attributes, entities and CDATA", () => {
    const doc = parseXml(
      '﻿<?xml version="1.0"?><product><area aac="VIC_FW007" description="Central" type="fire-district"><forecast-period index="1" start-time-local="2026-09-28T00:00:00+10:00"><element type="fire_behaviour_index">8</element><text type="fire_danger">No Rating</text></forecast-period></area><item><description><![CDATA[<p>Central: MODERATE</p>]]></description><title>A &amp; B</title></item></product>',
    );
    const area = first(doc, "area")!;
    expect(area.attrs.aac).toBe("VIC_FW007");
    const fp = [...all(area, "forecast-period")];
    expect(fp).toHaveLength(1);
    expect(typed(fp[0]!, "element", "fire_behaviour_index")).toBe("8");
    expect(typed(fp[0]!, "text", "fire_danger")).toBe("No Rating");
    expect(first(doc, "description")!.text).toBe("<p>Central: MODERATE</p>");
    expect(first(doc, "title")!.text).toBe("A & B");
    expect(doc.complete).toBe(true);
  });
  it("reports a document cut short as incomplete", () => {
    expect(parseXml("<product><amoc><identifier>IDV18555</identifier></amoc></product>").complete).toBe(true);
    expect(parseXml("<product><amoc><identifier>IDV18555</identifier></amoc>").complete).toBe(false);
    expect(parseXml("").complete).toBe(false);
  });
});

describe("districts", () => {
  it("maps every spelling to one key and never matches a substring", () => {
    expect(DISTRICTS).toHaveLength(9);
    for (const d of DISTRICTS) {
      expect(districtKey(d.name)).toBe(d.key);
      expect(districtKey(d.name.toUpperCase())).toBe(d.key);
      expect(districtKey(d.aac)).toBe(d.key);
      expect(districtKey(d.key)).toBe(d.key);
      expect(districtName(d.key)).toBe(d.name);
      expect(districtAac(d.key)).toBe(d.aac);
    }
    expect(districtKey("NORTH CENTRAL")).toBe("north_central");
    expect(districtKey("West & South Gippsland")).toBe("west_and_south_gippsland");
    expect(districtKey("Centra")).toBeNull();
    expect(districtKey("")).toBeNull();
  });
});
