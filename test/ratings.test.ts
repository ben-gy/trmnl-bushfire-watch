import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { districtKey } from "../src/districts.js";
import { AFDRS_ACTION, buildRatings, neighbourLine, normRating, type RatingInputs } from "../src/ratings.js";
import { IDV18555_URL, mergeBomFdr, parseIdv18555 } from "../src/sources/bom-fdr.js";
import { IDV18560_URL, mergeBomFw, parseIdv18560 } from "../src/sources/bom-fw.js";
import { CFA_URL, parseCfaRss } from "../src/sources/cfa-rss.js";
import { OSOM_URL, parseOsom, ratingsFromConditions } from "../src/sources/fdrtfb.js";
import { addDays, localDate, parseTime } from "../src/time.js";
import type { BomFdr, BomFw, Day, DayConditions, DistrictKey, RatingsFeed, SourceId, SourceResult, SourceState } from "../src/types.js";

const fixture = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
const OSOM_JSON = JSON.parse(fixture("osom-fdrtfb-2026-09-27T1656.json")) as { results: unknown[] };
const CFA_XML = fixture("cfa-tfbfdr-2026-09-27T1656.xml");
// Synthetic, in the shape of the BoM products (which are personal-use only).
const IDV18555 = fixture("IDV18555-sample.xml");
const IDV18560 = fixture("IDV18560-sample.xml");

interface RawForecast {
  date: string;
  fdr: Record<string, string>;
  tfb: Record<string, string>;
}
const forecasts = (f: string) => (JSON.parse(fixture(f)) as { properties: { conditions: { forecasts: RawForecast[] } } }).properties.conditions.forecasts;

/** The events feed's dated conditions, normalised here so this test does not depend on the events parser. */
function conditionsOf(f: string): DayConditions[] {
  const byKey = (o: Record<string, string>) => {
    const out: Partial<Record<DistrictKey, string>> = {};
    for (const [name, v] of Object.entries(o)) {
      const k = districtKey(name);
      if (k) out[k] = v;
    }
    return out;
  };
  return forecasts(f).map((x) => ({ date: localDate(parseTime(x.date)!), fdr: byKey(x.fdr), tfb: byKey(x.tfb) }));
}

/** An osom-fdrtfb document in the live shape, built from an events feed's dated conditions. */
function osomFrom(fs: RawForecast[]): unknown {
  const results: unknown[] = [];
  for (const x of fs) {
    const [y, m, d] = localDate(parseTime(x.date)!).split("-");
    const dmy = `${d}/${m}/${y}`;
    const list = (o: Record<string, string>) => Object.entries(o).map(([name, status]) => ({ name, status }));
    results.push({ issueFor: dmy, status: "Y", declaration: `${dmy} is a day of Total Fire Ban.`, declareList: list(x.tfb) });
    results.push({ issueFor: dmy, issueAt: dmy, imgUrl: null, declareList: list(x.fdr) });
  }
  return { results };
}

function src<T>(id: SourceId, data: T | null | undefined, state: SourceState = data ? "ok" : "unavailable"): SourceResult<T> {
  return { id, state, data: data ?? null, asOf: null, fetchedAt: null, error: state === "unavailable" ? "test" : null };
}

const NOW = Date.parse("2026-09-27T07:00:00Z"); // 17:00 AEST, after BoM's 16:00 issue
const TODAY = localDate(NOW);
const TOMORROW = addDays(TODAY, 1);

function inputs(o: Partial<RatingInputs> = {}): RatingInputs {
  return {
    dates: [TODAY, TOMORROW],
    now: NOW,
    district: "central",
    osom: src<RatingsFeed>("osom", null),
    conditions: src<RatingsFeed>("events", null),
    cfa: src<RatingsFeed>("cfa", null),
    bomFdr: src<BomFdr>("bom_fdr", null),
    ...o,
  };
}

const feed = (fdr: RatingsFeed["fdr"] = {}, tfb: RatingsFeed["tfb"] = {}): RatingsFeed => ({ fdr, tfb, declaration: {}, notYet: [], issued: {} });
const bom = (days: BomFdr["days"], issued: number | null = Date.parse("2026-09-27T06:00:00Z")): BomFdr => ({ issued, nextIssue: null, days });

function withinBudgets(days: { fdr: Day["fdr"]; tfb: Day["tfb"] }[]) {
  for (const d of days) {
    expect(d.fdr.action.length).toBeLessThanOrEqual(46);
    expect(d.fdr.issued.length).toBeLessThanOrEqual(29);
    expect(d.fdr.word.length).toBeLessThanOrEqual(18);
    expect(d.tfb.text.length).toBeLessThanOrEqual(31);
    expect(d.fdr.action).not.toBe("");
    expect(d.fdr.word).not.toBe("");
  }
}

describe("osom-fdrtfb", () => {
  it("exports the live URL", () => {
    expect(OSOM_URL).toBe("https://emergency.vic.gov.au/public/osom-fdrtfb.json");
    expect(CFA_URL).toBe("https://www.cfa.vic.gov.au/cfa/rssfeed/tfbfdrforecast_rss.xml");
    expect(IDV18555_URL).toBe("https://reg.bom.gov.au/fwo/IDV18555.xml");
    expect(IDV18560_URL).toBe("https://reg.bom.gov.au/fwo/IDV18560.xml");
  });

  it("parses the 27 Sep fixture by entry shape and issueFor", () => {
    const o = parseOsom(OSOM_JSON)!;
    expect(Object.keys(o.fdr).sort()).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(Object.keys(o.tfb).sort()).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(o.fdr["2026-09-27"]).toEqual({
      east_gippsland: "NO FORECAST",
      west_and_south_gippsland: "NO FORECAST",
      north_east: "MODERATE",
      central: "MODERATE",
      north_central: "MODERATE",
      northern_country: "NO FORECAST",
      south_west: "NO FORECAST",
      wimmera: "NO FORECAST",
      mallee: "NO FORECAST",
    });
    expect(o.fdr["2026-09-28"]?.central).toBe("NO FORECAST");
    expect(o.fdr["2026-09-28"]?.east_gippsland).toBe("MODERATE");
    expect(o.fdr["2026-09-29"]?.wimmera).toBe("MODERATE");
    expect(o.fdr["2026-09-30"]?.wimmera).toBe("NO FORECAST");
    for (const date of Object.keys(o.tfb)) {
      expect(Object.keys(o.tfb[date]!)).toHaveLength(9);
      expect(new Set(Object.values(o.tfb[date]!))).toEqual(new Set(["NO - RESTRICTIONS MAY APPLY"]));
    }
    expect(o.declaration["2026-09-28"]).toBe("Tomorrow, Mon, 28 Sep 2026 is not currently a day of Total Fire Ban.");
    expect(o.notYet).toEqual([]);
    expect(o.issued).toEqual({});
  });

  it("gives the same output for shuffled results[]", () => {
    const a = parseOsom(OSOM_JSON);
    const shuffled = { results: [5, 0, 7, 2, 4, 1, 6, 3].map((k) => OSOM_JSON.results[k]) };
    expect(parseOsom(shuffled)).toEqual(a);
    expect(parseOsom({ results: [...OSOM_JSON.results].reverse() })).toEqual(a);
  });

  it("returns undefined on schema drift", () => {
    expect(parseOsom(null)).toBeUndefined();
    expect(parseOsom({})).toBeUndefined();
    expect(parseOsom({ results: "x" })).toBeUndefined();
    expect(parseOsom({ results: [{ issueFor: "27/09/2026", foo: [] }] })).toBeUndefined();
    expect(parseOsom({ results: [{ issueFor: "2026-09-27", issueAt: "x", declareList: [{ name: "Central", status: "HIGH" }] }] })).toBeUndefined();
    expect(parseOsom("<html>")).toBeUndefined();
  });

  it("keeps the more alarming value when a district-day repeats", () => {
    const o = parseOsom({
      results: [
        { issueFor: "27/09/2026", issueAt: "27/09/2026", declareList: [{ name: "Central", status: "EXTREME" }] },
        { issueFor: "27/09/2026", issueAt: "27/09/2026", declareList: [{ name: "Central", status: "HIGH" }] },
        { issueFor: "27/09/2026", declaration: "", declareList: [{ name: "Central", status: "YES - TOTAL FIRE BAN IN FORCE" }] },
        { issueFor: "27/09/2026", declaration: "", declareList: [{ name: "Central", status: "NO - RESTRICTIONS MAY APPLY" }] },
      ],
    })!;
    expect(o.fdr["2026-09-27"]?.central).toBe("EXTREME");
    expect(o.tfb["2026-09-27"]?.central).toBe("YES - TOTAL FIRE BAN IN FORCE");
  });

  it("wraps the events feed's conditions in the same shape", () => {
    const c = ratingsFromConditions(conditionsOf("events-2026-09-27T1656.json"));
    expect(c.fdr["2026-09-27"]?.central).toBe("MODERATE");
    expect(c.fdr["2026-09-28"]?.central).toBe("NO FORECAST");
    expect(c.tfb["2026-09-27"]?.central).toBe("NO - RESTRICTIONS MAY APPLY");
    const legacy = ratingsFromConditions(conditionsOf("events-2025-03-31.json"));
    // 2025-03-31T13:00Z is local midnight on 1 April (AEDT).
    expect(legacy.fdr["2025-03-31"]).toBeUndefined();
    expect(legacy.fdr["2025-04-01"]?.east_gippsland).toBe("NO FORECAST");
    expect(legacy.fdr["2025-04-01"]?.central).toBe("MODERATE");
    const jan = ratingsFromConditions(conditionsOf("events-2026-01-09.json"));
    expect(jan.fdr["2026-01-09"]?.central).toBe("EXTREME");
    expect(jan.fdr["2026-01-09"]?.north_central).toBe("CATASTROPHIC");
    expect(jan.tfb["2026-01-09"]?.central).toBe("YES - TOTAL FIRE BAN IN FORCE");
    expect(ratingsFromConditions([])).toEqual(feed());
  });
});

describe("CFA RSS", () => {
  it("parses the 27 Sep fixture by title date", () => {
    const c = parseCfaRss(CFA_XML)!;
    expect(c.fdr["2026-09-27"]).toEqual({
      central: "MODERATE",
      east_gippsland: "NO RATING",
      mallee: "NO RATING",
      north_central: "MODERATE",
      north_east: "MODERATE",
      northern_country: "NO RATING",
      south_west: "NO RATING",
      west_and_south_gippsland: "NO RATING",
      wimmera: "NO RATING",
    });
    expect(c.tfb["2026-09-27"]?.central).toBe("NO - RESTRICTIONS MAY APPLY");
    expect(c.fdr["2026-09-28"]?.central).toBe("NO RATING");
    expect(c.fdr["2026-09-28"]?.east_gippsland).toBe("MODERATE");
    expect(c.fdr["2026-10-01"]?.central).toBe("MODERATE");
    expect(c.fdr["2026-10-01"]?.mallee).toBe("NO RATING");
    expect(Object.keys(c.fdr).sort()).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
    // 05:30 AM and the sic "16:00 PM", both Melbourne wall time (AEST).
    expect(c.issued["2026-09-27"]).toBe(Date.parse("2026-09-26T19:30:00Z"));
    expect(c.issued["2026-09-28"]).toBe(Date.parse("2026-09-27T06:00:00Z"));
    expect(c.declaration["2026-09-27"]).toBe("Today, Sun, 27 Sep 2026 is not currently a day of Total Fire Ban.");
    expect(c.notYet).toEqual([]);
  });

  it("puts an item with no issue line in notYet and ignores its placeholder ratings", () => {
    const items = CFA_XML.split("<item>");
    const last = items.length - 1;
    items[last] = items[last]!.replace(/Bureau of Meteorology forecast issued at:[^&]*/, "");
    const c = parseCfaRss(items.join("<item>"))!;
    expect(c.notYet).toEqual(["2026-10-01"]);
    expect(c.fdr["2026-10-01"]).toBeUndefined();
    expect(c.issued["2026-10-01"]).toBeUndefined();
    expect(c.tfb["2026-10-01"]?.central).toBe("NO - RESTRICTIONS MAY APPLY");
    expect(c.fdr["2026-09-30"]?.central).toBe("MODERATE");
  });

  it("keys items by title, not position, and tolerates a BOM and CDATA", () => {
    const head = CFA_XML.slice(0, CFA_XML.indexOf("<item>"));
    const items = CFA_XML.slice(CFA_XML.indexOf("<item>"), CFA_XML.lastIndexOf("</channel>")).split(/(?=<item>)/);
    const reordered = `\uFEFF${head}${[...items].reverse().join("")}</channel></rss>`;
    expect(parseCfaRss(reordered)).toEqual(parseCfaRss(CFA_XML));
    const cdata = CFA_XML.replace(/<description>(&lt;p&gt;[\s\S]*?)<\/description>/g, (_m, d: string) => {
      const html = d.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      return `<description><![CDATA[${html}]]></description>`;
    });
    expect(parseCfaRss(cdata)).toEqual(parseCfaRss(CFA_XML));
  });

  it("never reads North Central as Central", () => {
    const xml = `<rss><channel><item><title>Sunday, 27 September 2026</title><description>&lt;p&gt;North Central: YES - TOTAL FIRE BAN IN FORCE&lt;/p&gt;&lt;p&gt;Fire Danger Ratings&lt;br/&gt;Bureau of Meteorology forecast issued at: Sunday, 27 September 2026 05:30 AM&lt;/p&gt;&lt;p&gt;North Central: EXTREME&lt;br&gt;&lt;/p&gt;</description></item></channel></rss>`;
    const c = parseCfaRss(xml)!;
    expect(c.fdr["2026-09-27"]).toEqual({ north_central: "EXTREME" });
    expect(c.tfb["2026-09-27"]).toEqual({ north_central: "YES - TOTAL FIRE BAN IN FORCE" });
  });

  it("returns undefined on schema drift", () => {
    expect(parseCfaRss("")).toBeUndefined();
    expect(parseCfaRss("<html><body>Access denied</body></html>")).toBeUndefined();
    expect(parseCfaRss("<rss><channel><item><title>Soon</title><description>x</description></item></channel></rss>")).toBeUndefined();
  });
});

describe("BoM IDV18555", () => {
  it("dates periods by start-time-local: the 16:00 issue has no today", () => {
    const b = parseIdv18555(IDV18555)!;
    expect(b.issued).toBe(Date.parse("2026-09-27T06:00:00Z"));
    expect(b.nextIssue).toBe(Date.parse("2026-09-27T19:30:00Z"));
    expect(Object.keys(b.days).sort()).toEqual(
      ["central", "east_gippsland", "mallee", "north_central", "north_east", "northern_country", "south_west", "west_and_south_gippsland", "wimmera"].sort(),
    );
    expect(b.days.central?.["2026-09-27"]).toBeUndefined();
    expect(Object.keys(b.days.central!)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(b.days.central?.["2026-09-28"]).toMatchObject({ rating: "No Rating", fbi: 8 });
    expect(b.days.central?.["2026-09-29"]).toMatchObject({ rating: "Moderate", fbi: 15 });
    expect(b.days.central?.["2026-10-01"]).toMatchObject({ rating: "Moderate", fbi: 17 });
    expect(b.days.east_gippsland?.["2026-09-28"]).toMatchObject({ rating: "Moderate", fbi: 14 });
    expect(b.days.mallee?.["2026-09-28"]).toMatchObject({ rating: "No Rating", fbi: 5 });
  });

  it("returns undefined on schema drift", () => {
    expect(parseIdv18555("")).toBeUndefined();
    expect(parseIdv18555("<html>Service unavailable</html>")).toBeUndefined();
    expect(parseIdv18555(IDV18560)).toBeUndefined();
    expect(parseIdv18555(IDV18555.replace(/type="fire-district"/g, 'type="district"'))).toBeUndefined();
  });

  it("merges by date so today's morning value survives the 16:00 issue", () => {
    const morning = parseIdv18555(
      `<product><amoc><identifier>IDV18555</identifier><issue-time-utc>2026-09-26T19:30:00Z</issue-time-utc>` +
        `<next-routine-issue-time-utc>2026-09-27T06:00:00Z</next-routine-issue-time-utc></amoc><forecast>` +
        `<area aac="VIC_FW007" description="Central" type="fire-district">` +
        `<forecast-period index="0" start-time-local="2026-09-26T00:00:00+10:00"><element type="fire_behaviour_index">9</element><text type="fire_danger">No Rating</text></forecast-period>` +
        `<forecast-period index="1" start-time-local="2026-09-27T00:00:00+10:00"><element type="fire_behaviour_index">14</element><text type="fire_danger">Moderate</text></forecast-period>` +
        `<forecast-period index="2" start-time-local="2026-09-28T00:00:00+10:00"><element type="fire_behaviour_index">11</element><text type="fire_danger">Moderate</text></forecast-period>` +
        `</area></forecast></product>`,
    )!;
    const afternoon = parseIdv18555(IDV18555)!;
    const m = mergeBomFdr(morning, afternoon, TODAY);
    expect(m.issued).toBe(afternoon.issued);
    expect(m.nextIssue).toBe(afternoon.nextIssue);
    expect(m.days.central?.["2026-09-26"]).toBeUndefined();
    expect(m.days.central?.["2026-09-27"]).toMatchObject({ rating: "Moderate", fbi: 14 });
    expect(m.days.central?.["2026-09-28"]).toMatchObject({ rating: "No Rating", fbi: 8 });
    expect(mergeBomFdr(null, afternoon, TODAY).days.central).toEqual(afternoon.days.central);
    // An older copy arriving late never overwrites the newer issue.
    expect(mergeBomFdr(afternoon, morning, TODAY).days.central?.["2026-09-28"]).toMatchObject({ rating: "No Rating", fbi: 8 });

    // Today's FBI is credited to the morning issue it came from.
    const [today, tomorrow] = buildRatings(inputs({ osom: src("osom", parseOsom(OSOM_JSON)), bomFdr: src("bom_fdr", m) }));
    expect(today.fdr).toEqual({ level: 1, word: "MODERATE", action: "Plan and prepare", issued: "FBI 14 · BoM Sun 05:30" });
    expect(tomorrow.fdr.issued).toBe("FBI 8 · BoM Sun 16:00");
  });
});

describe("BoM IDV18560", () => {
  it("parses district and LGA sub-area fire weather", () => {
    const w = parseIdv18560(IDV18560)!;
    expect(w.issued).toBe(Date.parse("2026-09-27T06:00:00Z"));
    expect(Object.keys(w.district).sort()).toEqual(["central", "north_central", "wimmera"]);
    expect(w.district.central).toEqual([
      {
        date: "2026-09-28",
        fdr: "No Rating",
        fbi: 8,
        haines: 9,
        lightning: 0,
        wcdi: 14,
        wcdFlag: false,
        tmax50: 19,
        rhmin50: 49,
        windDir: "SSE",
        gust90: 28,
      },
    ]);
    expect(w.district.north_central?.[0]).toMatchObject({ date: "2026-09-28", wcdi: 19, haines: 10, tmax50: 21 });
    expect(w.subarea.nillumbik).toEqual([
      {
        date: "2026-09-28",
        fdr: "No Rating",
        fbi: 7,
        haines: 8,
        lightning: 0,
        wcdi: 13,
        wcdFlag: false,
        tmax50: null,
        rhmin50: null,
        windDir: null,
        gust90: null,
      },
    ]);
    expect(w.subarea.murrindindi?.[0]).toMatchObject({ date: "2026-09-28", lightning: 1 });
    expect(w.subarea.horsham).toHaveLength(1);
    // The region and group areas are neither districts nor sub-areas.
    expect(Object.keys(w.subarea).sort()).toEqual(["horsham", "murrindindi", "nillumbik"]);
    expect(w.subarea.victoria).toBeUndefined();
  });

  it("reads a yes flag and blank numbers as null, never 0", () => {
    const xml = IDV18560.replace(
      /(<area aac="VIC_FS029"[\s\S]*?)<element type="wind_change_danger_flag">no<\/element>/,
      '$1<element type="wind_change_danger_flag">yes</element>',
    ).replace(/(<area aac="VIC_FS029"[\s\S]*?)<element type="haines_index">8<\/element>/, '$1<element type="haines_index"></element>');
    const n = parseIdv18560(xml)!.subarea.nillumbik![0]!;
    expect(n.wcdFlag).toBe(true);
    expect(n.haines).toBeNull();
  });

  it("returns undefined on schema drift", () => {
    expect(parseIdv18560("")).toBeUndefined();
    expect(parseIdv18560(IDV18555)).toBeUndefined();
    expect(parseIdv18560("<product><amoc><identifier>IDV18560</identifier></amoc></product>")).toBeUndefined();
  });

  it("merges per key and date", () => {
    const next = parseIdv18560(IDV18560)!;
    const prev: BomFw = {
      issued: Date.parse("2026-09-26T20:30:00Z"),
      district: { central: [{ ...next.district.central![0]!, date: "2026-09-27", wcdFlag: true }, { ...next.district.central![0]!, date: "2026-09-26" }] },
      subarea: { nillumbik: [{ ...next.subarea.nillumbik![0]!, date: "2026-09-27", wcdi: 40 }] },
    };
    const m = mergeBomFw(prev, next, TODAY);
    expect(m.issued).toBe(next.issued);
    expect(m.district.central?.map((x) => x.date)).toEqual(["2026-09-27", "2026-09-28"]);
    expect(m.district.central?.[0]?.wcdFlag).toBe(true);
    expect(m.subarea.nillumbik?.map((x) => [x.date, x.wcdi])).toEqual([
      ["2026-09-27", 40],
      ["2026-09-28", 13],
    ]);
    expect(m.district.north_central).toEqual(next.district.north_central);
  });
});

describe("normRating", () => {
  it("maps every spelling to three distinct states", () => {
    expect(normRating("NO FORECAST")).toEqual({ level: 0, word: "NO RATING", recognised: true });
    expect(normRating("NO RATING")).toEqual({ level: 0, word: "NO RATING", recognised: true });
    expect(normRating("No Rating")).toEqual({ level: 0, word: "NO RATING", recognised: true });
    expect(normRating("Moderate")).toEqual({ level: 1, word: "MODERATE", recognised: true });
    expect(normRating("HIGH")).toMatchObject({ level: 2, word: "HIGH" });
    expect(normRating("extreme")).toMatchObject({ level: 3, word: "EXTREME" });
    expect(normRating("Catastrophic")).toMatchObject({ level: 4, word: "CATASTROPHIC" });
    expect(normRating("")).toEqual({ level: -1, word: "RATING UNAVAILABLE", recognised: false });
    expect(normRating(null)).toMatchObject({ level: -1, word: "RATING UNAVAILABLE" });
    expect(normRating(undefined)).toMatchObject({ level: -1 });
    expect(normRating("SEVERE")).toEqual({ level: 2, word: "SEVERE", recognised: false });
    expect(normRating("low-moderate")).toEqual({ level: 2, word: "LOW-MODERATE", recognised: false });
    expect(normRating("Catastrophic (Code Red)")).toMatchObject({ level: 4, recognised: false });
  });

  it("uses the AFDRS actions verbatim", () => {
    expect(AFDRS_ACTION).toEqual({
      "NO RATING": "No rating – fires can still start",
      MODERATE: "Plan and prepare",
      HIGH: "Be ready to act",
      EXTREME: "Take action now to protect life and property",
      CATASTROPHIC: "For your survival, leave bushfire risk areas",
    });
  });
});

describe("buildRatings", () => {
  const all27 = () =>
    inputs({
      osom: src("osom", parseOsom(OSOM_JSON)),
      conditions: src("events", ratingsFromConditions(conditionsOf("events-2026-09-27T1656.json"))),
      cfa: src("cfa", parseCfaRss(CFA_XML)),
      bomFdr: src("bom_fdr", parseIdv18555(IDV18555)),
    });

  it("at 17:00 on 27 Sep shows today's MODERATE although BoM's 16:00 issue lacks today", () => {
    const days = buildRatings(all27());
    expect(days[0]).toEqual({
      fdr: { level: 1, word: "MODERATE", action: "Plan and prepare", issued: "" },
      tfb: { state: "none", text: "No TFB · restrictions may apply" },
    });
    expect(days[1]).toEqual({
      fdr: { level: 0, word: "NO RATING", action: "No rating – fires can still start", issued: "FBI 8 · BoM Sun 16:00" },
      tfb: { state: "pending", text: "No TFB declared yet" },
    });
    withinBudgets(days);
  });

  it("reads NO FORECAST as NO RATING when BoM says No Rating", () => {
    const [, tomorrow] = buildRatings(inputs({ osom: src("osom", parseOsom(OSOM_JSON)), bomFdr: src("bom_fdr", parseIdv18555(IDV18555)) }));
    expect(tomorrow.fdr).toMatchObject({ level: 0, word: "NO RATING", issued: "FBI 8 · BoM Sun 16:00" });
  });

  it("reads NO FORECAST as NO RATING when CFA says NO RATING and BoM has no value", () => {
    const [, tomorrow] = buildRatings(inputs({ osom: src("osom", parseOsom(OSOM_JSON)), cfa: src("cfa", parseCfaRss(CFA_XML)) }));
    expect(tomorrow.fdr).toMatchObject({ level: 0, word: "NO RATING", issued: "" });
  });

  it("says NO RATING ISSUED for NO FORECAST alone with BoM unavailable", () => {
    const days = buildRatings(
      inputs({
        osom: src("osom", parseOsom(OSOM_JSON)),
        conditions: src("events", ratingsFromConditions(conditionsOf("events-2026-09-27T1656.json"))),
      }),
    );
    expect(days[1].fdr).toEqual({ level: 0, word: "NO RATING ISSUED", action: "No rating – fires can still start", issued: "" });
    withinBudgets(days);
  });

  it("says RATING UNAVAILABLE for an unknown district, never a guess", () => {
    const days = buildRatings({ ...all27(), district: null });
    for (const d of days) {
      expect(d.fdr).toEqual({ level: -1, word: "RATING UNAVAILABLE", action: "District unknown – set it in plugin settings", issued: "" });
      expect(d.tfb).toEqual({ state: "unknown", text: "TFB status unavailable" });
    }
    withinBudgets(days);
  });

  it("says RATING UNAVAILABLE when every source failed", () => {
    const days = buildRatings(inputs());
    expect(days[0].fdr).toEqual({ level: -1, word: "RATING UNAVAILABLE", action: "Check emergency.vic.gov.au or VicEmergency app", issued: "" });
    expect(days[0].tfb).toEqual({ state: "unknown", text: "TFB status unavailable" });
  });

  it("ignores values for a date the source has not covered", () => {
    const osom = parseOsom(OSOM_JSON)!;
    const days = buildRatings(inputs({ osom: src("osom", osom), dates: ["2026-10-01", "2026-10-02"] }));
    expect(days[0].fdr.word).toBe("RATING UNAVAILABLE");
    const cfa = parseCfaRss(CFA_XML)!;
    cfa.notYet.push("2026-10-01");
    expect(buildRatings(inputs({ cfa: src("cfa", cfa), dates: ["2026-10-01", "2026-10-02"] }))[0].fdr.word).toBe("RATING UNAVAILABLE");
  });

  it("shows the higher rating with a note when sources disagree", () => {
    const days = buildRatings(
      inputs({
        osom: src("osom", parseOsom(OSOM_JSON)),
        bomFdr: src("bom_fdr", bom({ central: { [TODAY]: { rating: "High", fbi: 30 } } })),
      }),
    );
    expect(days[0].fdr.level).toBe(2);
    expect(days[0].fdr.word).toBe("HIGH");
    expect(days[0].fdr.action).toBe("Be ready to act");
    expect(days[0].fdr.issued).toBe("BoM: HIGH · EMV: MOD · FBI 30");
    withinBudgets(days);

    const lower = buildRatings(
      inputs({
        osom: src("osom", parseOsom(OSOM_JSON)),
        cfa: src("cfa", parseCfaRss(CFA_XML)),
        bomFdr: src("bom_fdr", bom({ central: { [TODAY]: { rating: "No Rating", fbi: 5 } } })),
      }),
    );
    expect(lower[0].fdr).toMatchObject({ level: 1, word: "MODERATE", issued: "EMV/CFA: MOD · BoM: NO RATING" });
  });

  it("shows an unrecognised rating raw, ranked at least High", () => {
    const days = buildRatings(inputs({ osom: src("osom", feed({ [TODAY]: { central: "SEVERE" } })) }));
    expect(days[0].fdr).toEqual({ level: 2, word: "SEVERE", action: "Check emergency.vic.gov.au or VicEmergency app", issued: "" });
    const long = buildRatings(inputs({ osom: src("osom", feed({ [TODAY]: { central: "CATASTROPHIC FIRE DANGER DAY" } })) }));
    expect(long[0].fdr).toMatchObject({ level: 4, word: "CATASTROPHIC FIRE…" });
    withinBudgets(long);
    expect(buildRatings(inputs({ osom: src("osom", feed({ [TODAY]: { central: "EXTREMELY SEVERE" } })) }))[0].fdr.level).toBe(2);
  });

  it("declares a TFB when any source says YES", () => {
    const osom = feed({}, { [TODAY]: { central: "NO - RESTRICTIONS MAY APPLY" }, [TOMORROW]: { central: "NO - RESTRICTIONS MAY APPLY" } });
    const cfa = feed({}, { [TOMORROW]: { central: "YES - TOTAL FIRE BAN IN FORCE" } });
    const days = buildRatings(inputs({ osom: src("osom", osom), cfa: src("cfa", cfa) }));
    expect(days[0].tfb).toEqual({ state: "none", text: "No TFB · restrictions may apply" });
    expect(days[1].tfb).toEqual({ state: "declared", text: "TOTAL FIRE BAN" });
  });

  it("never calls tomorrow's NO an all-clear, and shows unclear values as unclear", () => {
    const days = buildRatings(inputs({ osom: src("osom", feed({}, { [TODAY]: { central: "PENDING" }, [TOMORROW]: { central: "NO - RESTRICTIONS MAY APPLY" } })) }));
    expect(days[0].tfb).toEqual({ state: "unknown", text: "TFB status unclear" });
    expect(days[1].tfb).toEqual({ state: "pending", text: "No TFB declared yet" });
  });

  it("uses a stale source for alarms only", () => {
    const calm = feed({ [TODAY]: { central: "MODERATE" } }, { [TODAY]: { central: "NO - RESTRICTIONS MAY APPLY" } });
    const stale = buildRatings(inputs({ osom: src("osom", calm, "stale") }));
    expect(stale[0].fdr.word).toBe("RATING UNAVAILABLE");
    expect(stale[0].tfb).toEqual({ state: "unknown", text: "TFB status unavailable" });

    const alarm = feed({ [TODAY]: { central: "EXTREME" } }, { [TODAY]: { central: "YES - TOTAL FIRE BAN IN FORCE" } });
    const hot = buildRatings(inputs({ osom: src("osom", alarm, "stale") }));
    expect(hot[0].fdr).toMatchObject({ level: 3, word: "EXTREME" });
    expect(hot[0].tfb.state).toBe("declared");

    // A stale all-clear never outvotes a fresh source either way.
    const mixed = buildRatings(inputs({ osom: src("osom", calm, "stale"), cfa: src("cfa", feed({ [TODAY]: { central: "HIGH" } })) }));
    expect(mixed[0].fdr).toMatchObject({ level: 2, word: "HIGH", issued: "" });
    const bomStale = buildRatings(inputs({ bomFdr: src("bom_fdr", bom({ central: { [TODAY]: { rating: "Moderate", fbi: 14 } } }), "stale") }));
    expect(bomStale[0].fdr.word).toBe("RATING UNAVAILABLE");
  });

  it("never uses North Central values for Central", () => {
    const nc = feed({ [TODAY]: { north_central: "CATASTROPHIC" } }, { [TODAY]: { north_central: "YES - TOTAL FIRE BAN IN FORCE" } });
    const days = buildRatings(
      inputs({
        osom: src("osom", nc),
        cfa: src("cfa", nc),
        bomFdr: src("bom_fdr", bom({ north_central: { [TODAY]: { rating: "Catastrophic", fbi: 120 } } })),
      }),
    );
    expect(days[0].fdr.word).toBe("RATING UNAVAILABLE");
    expect(days[0].tfb.text).toBe("TFB status unavailable");
    expect(parseOsom({ results: [{ issueFor: "27/09/2026", issueAt: "27/09/2026", declareList: [{ name: "NORTH CENTRAL", status: "EXTREME" }] }] })!.fdr).toEqual({
      "2026-09-27": { north_central: "EXTREME" },
    });
  });

  it("shows 9 Jan 2026 as EXTREME with a Total Fire Ban", () => {
    const now = Date.parse("2026-01-09T07:55:00Z");
    const today = localDate(now);
    expect(today).toBe("2026-01-09");
    const osom = parseOsom(osomFrom(forecasts("events-2026-01-09.json")))!;
    expect(osom.fdr["2026-01-09"]?.central).toBe("EXTREME");
    const i = inputs({ now, dates: [today, addDays(today, 1)], osom: src("osom", osom) });
    const days = buildRatings(i);
    expect(days[0]).toEqual({
      fdr: { level: 3, word: "EXTREME", action: "Take action now to protect life and property", issued: "" },
      tfb: { state: "declared", text: "TOTAL FIRE BAN" },
    });
    expect(days[1].fdr).toMatchObject({ level: 2, word: "HIGH" });
    expect(days[1].tfb.state).toBe("declared");
    withinBudgets(days);
    expect(neighbourLine("north_central", today, i)).toBe("North Central: CATASTROPHIC · TFB");

    // Kinglake is in North Central: its own district is CATASTROPHIC.
    expect(buildRatings({ ...i, district: "north_central" })[0].fdr).toMatchObject({ level: 4, word: "CATASTROPHIC" });
  });

  it("raises the rating to an area product containing home, with a note", () => {
    const now = Date.parse("2026-01-09T07:55:00Z");
    const osom = parseOsom(osomFrom(forecasts("events-2026-01-09.json")))!;
    const i = inputs({ now, dates: ["2026-01-09", "2026-01-10"], osom: src("osom", osom), areaStatuses: ["CATASTROPHIC", "TOTAL FIRE BAN IN FORCE"] });
    const days = buildRatings(i);
    expect(days[0].fdr).toEqual({ level: 4, word: "CATASTROPHIC", action: "For your survival, leave bushfire risk areas", issued: "CFA area: CAT · EMV: EXT" });
    // Area products describe today only.
    expect(days[1].fdr.word).toBe("HIGH");
    withinBudgets(days);

    // Even with no district and no rating feed, an area product over home is shown.
    const bare = buildRatings(inputs({ district: null, areaStatuses: ["CATASTROPHIC", "TOTAL FIRE BAN IN FORCE"] }));
    expect(bare[0].fdr).toMatchObject({ level: 4, word: "CATASTROPHIC", issued: "CFA area: CAT" });
    expect(bare[0].tfb.state).toBe("declared");
    expect(bare[1].fdr.word).toBe("RATING UNAVAILABLE");

    // Never lowers the rating, never supplies an all-clear.
    const lower = buildRatings({ ...i, areaStatuses: ["HIGH", "NO RATING"] });
    expect(lower[0].fdr).toMatchObject({ level: 3, word: "EXTREME", issued: "" });
    expect(buildRatings(inputs({ areaStatuses: ["NO RATING", "Fire Danger Rating"] }))[0].fdr.word).toBe("RATING UNAVAILABLE");
  });
});

describe("neighbourLine", () => {
  it("summarises a neighbouring district in one line", () => {
    const i = inputs({ osom: src("osom", parseOsom(OSOM_JSON)), bomFdr: src("bom_fdr", parseIdv18555(IDV18555)) });
    expect(neighbourLine("north_central", TODAY, i)).toBe("North Central: MODERATE · No TFB");
    expect(neighbourLine("north_central", TOMORROW, i)).toBe("North Central: NO RATING · No TFB yet");
    expect(neighbourLine("central", TODAY, { ...i, district: "north_central" })).toBe("Central: MODERATE · No TFB");
    expect(neighbourLine("north_central", TODAY, inputs())).toBe("");
  });

  it("fits 38 characters for the longest names", () => {
    const f = feed(
      { [TODAY]: { west_and_south_gippsland: "CATASTROPHIC" }, [TOMORROW]: { west_and_south_gippsland: "NO FORECAST" } },
      { [TODAY]: { west_and_south_gippsland: "YES - TOTAL FIRE BAN IN FORCE" }, [TOMORROW]: { west_and_south_gippsland: "MAYBE" } },
    );
    const i = inputs({ osom: src("osom", f) });
    const a = neighbourLine("west_and_south_gippsland", TODAY, i);
    expect(a).toBe("W&S Gippsland: CATASTROPHIC · TFB");
    const b = neighbourLine("west_and_south_gippsland", TOMORROW, i);
    expect(b.length).toBeLessThanOrEqual(38);
    expect(b.startsWith("W&S Gippsland: NO RATING ISSUED")).toBe(true);
  });
});
