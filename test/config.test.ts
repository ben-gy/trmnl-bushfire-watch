import { describe, expect, it } from "vitest";
import { FIXTURE_HOME, parseRequest, tokenMatches, type Env, type RequestConfig } from "../src/config.js";

const TOKEN = "test-token-not-a-secret";
const ENV: Env = { BRIEF_TOKEN: TOKEN };
const DEV: Env = { BRIEF_TOKEN: TOKEN, ALLOW_QUERY_LOCATION: "1" };

function req(headers: Record<string, string> = {}, query = ""): Request {
  return new Request(`https://w.test/v1/brief.json${query}`, { headers: { "x-brief-token": TOKEN, ...headers } });
}

const parse = (headers: Record<string, string> = {}, query = "", env: Env = ENV) => parseRequest(req(headers, query), env);

function ok(c: RequestConfig) {
  if (!c.ok) throw new Error(`expected ok, got ${c.error}: ${c.message}`);
  return c;
}

describe("tokenMatches", () => {
  it("compares exactly and fails closed", async () => {
    expect(await tokenMatches("abc", "abc")).toBe(true);
    expect(await tokenMatches("abd", "abc")).toBe(false);
    expect(await tokenMatches("abc ", "abc")).toBe(false);
    expect(await tokenMatches("", "abc")).toBe(false);
    expect(await tokenMatches(null, "abc")).toBe(false);
    expect(await tokenMatches("", "")).toBe(false);
    expect(await tokenMatches(null, "")).toBe(false);
    expect(await tokenMatches("abc", undefined)).toBe(false);
  });
});

describe("parseRequest: auth", () => {
  it("is not_configured without BRIEF_TOKEN, whatever the request says", async () => {
    for (const env of [{}, { BRIEF_TOKEN: "" }] as Env[]) {
      expect(await parse({ "x-home-secret": "-37.73,145.22" }, "", env)).toEqual({
        ok: false,
        error: "not_configured",
        message: "BRIEF_TOKEN is not set on the Worker",
      });
    }
  });

  it("checks the token before anything else", async () => {
    const bad = [
      new Request("https://w.test/v1/brief.json", { headers: { "x-home-secret": "-37.73,145.22" } }),
      new Request("https://w.test/v1/brief.json", { headers: { "x-brief-token": "wrong", "x-home-secret": "-37.73,145.22" } }),
      new Request("https://w.test/v1/brief.json", { headers: { "x-brief-token": "wrong", "x-home-secret": "145.22,-37.73" } }),
      new Request("https://w.test/v1/brief.json", { headers: { "x-brief-token": "wrong" } }),
      new Request("https://w.test/v1/brief.json?fixture=quiet", { headers: { "x-brief-token": "wrong" } }),
      new Request("https://w.test/v1/brief.json?lat=-37.73&lon=145.22&token=" + TOKEN),
    ];
    for (const r of bad) {
      const c = await parseRequest(r, DEV);
      expect(c).toMatchObject({ ok: false, error: "auth" });
      if (!c.ok) expect(c.message).not.toContain(TOKEN);
    }
  });
});

describe("parseRequest: location", () => {
  it("reads lat,lon from x-home-secret in the formats TRMNL's lat_lon may send", async () => {
    for (const s of ["-37.73,145.22", "-37.73, 145.22", " -37.73 , 145.22 ", "-37.73 145.22", "(-37.73, 145.22)", "[-37.73,145.22]", "-37.73%2C145.22", "-37.73,+145.22", "%E2%88%9237.73, 145.22"]) {
      const c = ok(await parse({ "x-home-secret": s }));
      expect(c.home, s).toEqual({ lat: -37.73, lon: 145.22 });
      expect(c.fixture).toBeNull();
    }
    expect(ok(await parse({ "x-home-secret": "-36.7167,142.1997" })).home).toEqual({ lat: -36.7167, lon: 142.1997 });
  });

  it("errors when the location is missing, and never falls back to a default city", async () => {
    for (const h of [{}, { "x-home-secret": "" }, { "x-home-secret": "   " }] as Record<string, string>[]) {
      expect(await parse(h)).toMatchObject({ ok: false, error: "location_missing" });
    }
  });

  it("rejects what isn't a coordinate pair", async () => {
    for (const s of ["abc", "-37.73", "-37.73,", ",145.22", "-37.73,145.22,10", "{{ lat_lon }}", "-37,73,145,22", "-95,145.22", "-37.73,200", "NaN,NaN", "%E0%A4%A"]) {
      expect(await parse({ "x-home-secret": s }), s).toMatchObject({ ok: false, error: "location_invalid" });
    }
  });

  it("calls a swapped pair swapped, and never fixes it", async () => {
    const c = await parse({ "x-home-secret": "145.22,-37.73" });
    expect(c).toMatchObject({ ok: false, error: "location_invalid" });
    if (!c.ok) expect(c.message).toMatch(/swapped/i);
  });

  it("calls a positive latitude out rather than moving the house", async () => {
    const c = await parse({ "x-home-secret": "37.73,145.22" });
    expect(c).toMatchObject({ ok: false, error: "location_invalid" });
    if (!c.ok) expect(c.message).toMatch(/negative/i);
  });

  it("rejects points outside Victoria", async () => {
    for (const s of ["-33.87,151.21" /* Sydney */, "-34.93,138.60" /* Adelaide */, "-42.88,147.33" /* Hobart */, "0,0"]) {
      expect(await parse({ "x-home-secret": s }), s).toMatchObject({ ok: false, error: "outside_vic" });
    }
    // The box edges are inclusive.
    expect(ok(await parse({ "x-home-secret": "-39.3,140.9" })).home).toEqual({ lat: -39.3, lon: 140.9 });
  });

  it("never echoes the coordinates in a message", async () => {
    for (const s of ["145.22,-37.73", "37.73,145.22", "-33.87,151.21", "-37.73", "abc -37.73,145.22"]) {
      const c = await parse({ "x-home-secret": s });
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.message).not.toMatch(/37\.7|145\.2|33\.8|151\.2/);
    }
  });

  it("ignores ?lat=&lon= unless ALLOW_QUERY_LOCATION is '1'", async () => {
    const q = "?lat=-37.73&lon=145.22";
    expect(await parse({}, q)).toMatchObject({ ok: false, error: "location_missing" });
    expect(await parse({}, q, { ...ENV, ALLOW_QUERY_LOCATION: "true" })).toMatchObject({ ok: false, error: "location_missing" });
    expect(ok(await parse({}, q, DEV)).home).toEqual({ lat: -37.73, lon: 145.22 });
    expect(ok(await parse({}, "?lat=%E2%88%9237.73&lon=145.22", DEV)).home).toEqual({ lat: -37.73, lon: 145.22 });
    expect(ok(await parse({ "x-home-secret": "-37.53,145.34" }, q, DEV)).home).toEqual({ lat: -37.53, lon: 145.34 });
    expect(await parse({}, "?lat=-37.73", DEV)).toMatchObject({ ok: false, error: "location_invalid" });
    expect(await parse({}, "?lat=145.22&lon=-37.73", DEV)).toMatchObject({ ok: false, error: "location_invalid" });
    expect(await parse({}, "?lat=-33.87&lon=151.21", DEV)).toMatchObject({ ok: false, error: "outside_vic" });
  });
});

describe("parseRequest: district, radius, fixture", () => {
  const home = { "x-home-secret": "-37.73,145.22" };

  it("reads x-district: auto/empty/missing/unknown → null (look it up), else the key", async () => {
    const cases: [string | undefined, string | null][] = [
      [undefined, null],
      ["", null],
      ["auto", null],
      ["AUTO", null],
      ["nowhere", null],
      ["{{ district }}", null],
      ["central", "central"],
      ["Central", "central"],
      ["north_central", "north_central"],
      ["NORTH CENTRAL", "north_central"],
      ["West and South Gippsland", "west_and_south_gippsland"],
      ["VIC_FW008", "north_central"],
    ];
    for (const [v, want] of cases) {
      const h = v === undefined ? home : { ...home, "x-district": v };
      expect(ok(await parse(h)).district, String(v)).toBe(want);
    }
    expect(ok(await parse(home, "?district=central")).district).toBeNull();
    expect(ok(await parse(home, "?district=central", DEV)).district).toBe("central");
    expect(ok(await parse({ ...home, "x-district": "mallee" }, "?district=central", DEV)).district).toBe("mallee");
  });

  it("reads x-radius-km as whole km, clamped to 5–100, default 30", async () => {
    const cases: [string | undefined, number][] = [
      [undefined, 30],
      ["", 30],
      ["abc", 30],
      ["30", 30],
      ["50", 50],
      ["12.6", 13],
      ["2", 5],
      ["-10", 5],
      ["500", 100],
      ["1e9", 100],
    ];
    for (const [v, want] of cases) {
      const h = v === undefined ? home : { ...home, "x-radius-km": v };
      expect(ok(await parse(h)).radiusKm, String(v)).toBe(want);
    }
    expect(ok(await parse(home, "?radius_km=50")).radiusKm).toBe(30);
    expect(ok(await parse(home, "?radius_km=50", DEV)).radiusKm).toBe(50);
  });

  it("serves ?fixture= with the token but without a location", async () => {
    const c = ok(await parse({}, "?fixture=busy-warrandyte"));
    expect(c).toEqual({ ok: true, home: FIXTURE_HOME, district: null, radiusKm: 30, fixture: "busy-warrandyte" });
    expect(ok(await parse({ "x-district": "north_central", "x-radius-km": "40" }, "?fixture=quiet"))).toMatchObject({
      district: "north_central",
      radiusKm: 40,
      fixture: "quiet",
    });
  });

  it("ignores a malformed fixture name, so a location is required again", async () => {
    for (const q of ["?fixture=Busy", "?fixture=../x", "?fixture=a_b", "?fixture=", `?fixture=${"a".repeat(33)}`]) {
      expect(await parse({}, q), q).toMatchObject({ ok: false, error: "location_missing" });
    }
    expect(ok(await parse({}, `?fixture=${"a".repeat(32)}`)).fixture).toBe("a".repeat(32));
  });
});
