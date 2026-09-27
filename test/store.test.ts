import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDistrict } from "../src/gather.js";
import { districtUrl, lgaUrl, lookupDistrict, neighboursUrl, parseDistrict, parseLga, parseNeighbours } from "../src/sources/vicmap.js";
import { clearMemory, fetchText, getSource, UA, type SourceSpec } from "../src/store.js";
import type { Deps } from "../src/types.js";

const T0 = Date.parse("2026-09-27T06:00:00Z");
const MIN = 60_000;

interface Doc {
  n: number;
  updated: string;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

function fakeKv() {
  const data = new Map<string, string>();
  const puts: { key: string; value: string; opts: unknown }[] = [];
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const v = data.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (key: string, value: string, opts?: unknown) => {
      data.set(key, value);
      puts.push({ key, value, opts });
    }),
  };
  return { kv: kv as unknown as KVNamespace, raw: kv, data, puts };
}

const logs: Record<string, unknown>[] = [];

function mkDeps(fetchImpl: FetchFn, kv: KVNamespace | null = null) {
  const clock = { now: T0 };
  const fetch = vi.fn(fetchImpl);
  const deps: Deps = { fetch: fetch as unknown as typeof globalThis.fetch, now: () => clock.now, kv, log: (o) => logs.push(o) };
  return { deps, fetch, clock };
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const notModified = () => new Response(null, { status: 304 });
const header = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];

/** The weather URL carries 2-dp coordinates: logs must never see it. */
const URL_WITH_COORDS = "https://feed.example.test/v1/forecast?latitude=-37.73&longitude=145.22";

function spec(over: Partial<SourceSpec<Doc>> = {}): SourceSpec<Doc> {
  return {
    id: "events",
    key: "src:test",
    url: URL_WITH_COORDS,
    refreshMs: MIN,
    okAgeMs: 10 * MIN,
    staleAgeMs: 45 * MIN,
    timeoutMs: 40,
    validator: "etag",
    accept: "application/json",
    parse(body) {
      const j = JSON.parse(body) as Partial<Doc> | null;
      return typeof j?.n === "number" && typeof j.updated === "string" ? (j as Doc) : undefined;
    },
    asOf: (d) => Date.parse(d.updated),
    ...over,
  };
}

const doc = (n: number, ageMin = 0): Doc => ({ n, updated: new Date(T0 - ageMin * MIN).toISOString() });

beforeEach(() => {
  clearMemory();
});

describe("getSource: caching and revalidation", () => {
  it("fetches once, then serves memory within refreshMs without fetching", async () => {
    const { kv, puts } = fakeKv();
    const { deps, fetch, clock } = mkDeps(async () => json(doc(1), { etag: '"a"' }), kv);
    const r1 = await getSource(spec(), deps);
    expect(r1).toMatchObject({ id: "events", state: "ok", data: doc(1), fetchedAt: T0, asOf: T0, error: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(URL_WITH_COORDS);
    expect(header(init, "User-Agent")).toBe(UA);
    expect(header(init, "Accept")).toBe("application/json");
    expect(header(init, "If-None-Match")).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.opts).toEqual({ expirationTtl: 7 * 24 * 3600 });
    expect(JSON.parse(puts[0]!.value)).toEqual({ v: 1, data: doc(1), fetchedAt: T0, asOf: T0, etag: '"a"', lastModified: null });

    clock.now = T0 + 59_000;
    const r2 = await getSource(spec(), deps);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r2.data).toEqual(doc(1));
    expect(r2.fetchedAt).toBe(T0);
  });

  it("revalidates with If-None-Match after refreshMs; 304 keeps the data and moves fetchedAt", async () => {
    const { kv, puts } = fakeKv();
    let first = true;
    const { deps, fetch, clock } = mkDeps(async () => {
      if (first) {
        first = false;
        return json(doc(1), { etag: '"a"', "last-modified": "Sun, 27 Sep 2026 06:00:00 GMT" });
      }
      return notModified();
    }, kv);
    await getSource(spec(), deps);
    clock.now = T0 + 2 * MIN;
    const r = await getSource(spec(), deps);
    expect(fetch).toHaveBeenCalledTimes(2);
    const init = fetch.mock.calls[1]![1];
    expect(header(init, "If-None-Match")).toBe('"a"');
    expect(header(init, "If-Modified-Since")).toBeUndefined();
    expect(r).toMatchObject({ state: "ok", data: doc(1), fetchedAt: T0 + 2 * MIN, asOf: T0, error: null });
    // Only fetchedAt changed: KV is not rewritten within 5 minutes of the last write…
    expect(puts).toHaveLength(1);
    // …but is after that.
    clock.now = T0 + 6 * MIN;
    await getSource(spec(), deps);
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[1]!.value).fetchedAt).toBe(T0 + 6 * MIN);
  });

  it("sends If-Modified-Since, never If-None-Match, for last-modified specs (reg.bom.gov.au ignores ETags)", async () => {
    const { deps, fetch, clock } = mkDeps(async () => json(doc(1), { etag: '"a"', "last-modified": "Sun, 27 Sep 2026 05:59:00 GMT" }));
    const s = spec({ validator: "last-modified" });
    await getSource(s, deps);
    clock.now = T0 + 2 * MIN;
    fetch.mockImplementationOnce(async () => notModified());
    const r = await getSource(s, deps);
    const init = fetch.mock.calls[1]![1];
    expect(header(init, "If-Modified-Since")).toBe("Sun, 27 Sep 2026 05:59:00 GMT");
    expect(header(init, "If-None-Match")).toBeUndefined();
    expect(r.fetchedAt).toBe(T0 + 2 * MIN);
  });

  it("sends no validator for 'none' specs", async () => {
    const { deps, fetch, clock } = mkDeps(async () => json(doc(1), { etag: '"a"', "last-modified": "x" }));
    const s = spec({ validator: "none" });
    await getSource(s, deps);
    clock.now = T0 + 2 * MIN;
    await getSource(s, deps);
    const init = fetch.mock.calls[1]![1];
    expect(header(init, "If-None-Match")).toBeUndefined();
    expect(header(init, "If-Modified-Since")).toBeUndefined();
  });

  it("refetches unconditionally once after a 304 it has no data for", async () => {
    const { deps, fetch } = mkDeps(async () => json(doc(2), { etag: '"b"' }));
    fetch.mockImplementationOnce(async () => notModified());
    const r = await getSource(spec(), deps);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(header(fetch.mock.calls[1]![1], "If-None-Match")).toBeUndefined();
    expect(r).toMatchObject({ state: "ok", data: doc(2) });
  });

  it("is unavailable when every answer is a 304 it has no data for", async () => {
    const { deps, fetch } = mkDeps(async () => notModified());
    const r = await getSource(spec(), deps);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ state: "unavailable", data: null, error: "304 without data" });
  });

  it("refetches when forced", async () => {
    const { deps, fetch } = mkDeps(async () => json(doc(1)));
    await getSource(spec(), deps);
    await getSource(spec(), deps, { force: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("restores from KV in a new isolate, and stores via waitUntil when given", async () => {
    const { kv, puts } = fakeKv();
    const a = mkDeps(async () => json(doc(1), { etag: '"a"' }), kv);
    const pending: Promise<unknown>[] = [];
    await getSource(spec(), a.deps, { waitUntil: (p) => pending.push(p) });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(puts).toHaveLength(1);

    clearMemory();
    const b = mkDeps(async () => notModified(), kv);
    b.clock.now = T0 + 30_000;
    expect(await getSource(spec(), b.deps)).toMatchObject({ state: "ok", data: doc(1) });
    expect(b.fetch).not.toHaveBeenCalled();
    b.clock.now = T0 + 2 * MIN;
    expect(await getSource(spec(), b.deps)).toMatchObject({ state: "ok", data: doc(1), fetchedAt: T0 + 2 * MIN });
    expect(header(b.fetch.mock.calls[0]![1], "If-None-Match")).toBe('"a"');
  });

  it("ignores a KV record of the wrong shape", async () => {
    const { kv, data } = fakeKv();
    data.set("src:test", JSON.stringify({ v: 2, stuff: true }));
    const { deps, fetch } = mkDeps(async () => json(doc(1)), kv);
    expect(await getSource(spec(), deps)).toMatchObject({ state: "ok", data: doc(1) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("swallows KV failures", async () => {
    const { kv, raw } = fakeKv();
    raw.get.mockImplementation(async () => {
      throw new Error("kv down");
    });
    raw.put.mockImplementation(() => {
      throw new Error("kv down");
    });
    const { deps } = mkDeps(async () => json(doc(1)), kv);
    expect(await getSource(spec(), deps)).toMatchObject({ state: "ok", data: doc(1) });
  });

  it("caps isolate memory", async () => {
    const { deps, fetch } = mkDeps(async () => json(doc(1)));
    for (let i = 0; i < 60; i++) await getSource(spec({ key: `k${i}` }), deps);
    expect(fetch).toHaveBeenCalledTimes(60);
    await getSource(spec({ key: "k59" }), deps);
    expect(fetch).toHaveBeenCalledTimes(60);
    await getSource(spec({ key: "k0" }), deps);
    expect(fetch).toHaveBeenCalledTimes(61);
  });
});

describe("getSource: failures", () => {
  const hang: FetchFn = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("times out to unavailable with no data", async () => {
    const { deps } = mkDeps(hang);
    const r = await getSource(spec({ timeoutMs: 20 }), deps);
    expect(r).toEqual({ id: "events", state: "unavailable", data: null, asOf: null, fetchedAt: null, error: "timeout" });
  });

  it("times out to the previous copy, aged by its own timestamp", async () => {
    const { deps, fetch, clock } = mkDeps(async () => json(doc(1)));
    await getSource(spec({ timeoutMs: 20 }), deps);
    fetch.mockImplementation(hang);
    clock.now = T0 + 20 * MIN;
    const r = await getSource(spec({ timeoutMs: 20 }), deps);
    expect(r).toMatchObject({ state: "stale", data: doc(1), fetchedAt: T0, asOf: T0, error: "timeout" });
    clock.now = T0 + 50 * MIN;
    expect(await getSource(spec({ timeoutMs: 20 }), deps)).toMatchObject({ state: "unavailable", data: doc(1), error: "timeout" });
  });

  const faults: [string, () => Response | Promise<Response>, string][] = [
    ["500", () => json("oops", {}, 500), "http 500"],
    ["403 HTML", () => new Response("<html><body>Forbidden</body></html>", { status: 403, headers: { "content-type": "text/html" } }), "http 403"],
    ["200 WAF HTML", () => new Response("<html><body>Request blocked</body></html>", { status: 200, headers: { "content-type": "text/html" } }), "parse error"],
    ["200 empty", () => new Response("", { status: 200 }), "parse error"],
    ["200 truncated", () => json('{"n": 1, "upd'), "parse error"],
    ["200 wrong shape", () => json({ features: [] }), "bad document"],
    ["network", () => Promise.reject(new TypeError("fetch failed https://feed.example.test/?latitude=-37.73")), "network"],
  ];
  for (const [name, respond, error] of faults) {
    it(`treats ${name} as a failure`, async () => {
      const { deps } = mkDeps(async () => respond());
      expect(await getSource(spec(), deps)).toEqual({ id: "events", state: "unavailable", data: null, asOf: null, fetchedAt: null, error });
    });
    it(`keeps the last good copy through ${name}`, async () => {
      const { deps, fetch, clock } = mkDeps(async () => json(doc(1), { etag: '"a"' }));
      await getSource(spec(), deps);
      fetch.mockImplementation(async () => respond());
      clock.now = T0 + 5 * MIN;
      expect(await getSource(spec(), deps)).toMatchObject({ state: "ok", data: doc(1), fetchedAt: T0, error });
    });
  }

  it("rejects bodies over maxBytes, by header or by counting", async () => {
    const big = JSON.stringify({ ...doc(1), pad: "x".repeat(500) });
    const counted = mkDeps(async () => new Response(big, { status: 200 }));
    expect(await getSource(spec({ maxBytes: 100 }), counted.deps)).toMatchObject({ state: "unavailable", error: "too large" });
    const declared = mkDeps(async () => new Response(big, { status: 200, headers: { "content-length": String(big.length) } }));
    expect(await getSource(spec({ maxBytes: 100 }), declared.deps)).toMatchObject({ state: "unavailable", error: "too large" });
  });

  it("never throws: a throwing parse, merge, asOf, fetch or logger each become a failure", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    for (const over of [{ parse: boom }, { merge: boom }, { asOf: boom }] as Partial<SourceSpec<Doc>>[]) {
      clearMemory();
      const { deps } = mkDeps(async () => json(doc(1)));
      expect(await getSource(spec(over), deps)).toMatchObject({ state: "unavailable", data: null, error: "parse error" });
    }
    const sync = mkDeps(async () => json(doc(1)));
    sync.fetch.mockImplementation(boom);
    expect(await getSource(spec(), sync.deps)).toMatchObject({ state: "unavailable", error: "network" });
    const loud = mkDeps(async () => json(doc(1)));
    loud.deps.log = boom;
    expect(await getSource(spec(), loud.deps)).toMatchObject({ state: "ok" });
    const clockless = mkDeps(async () => json(doc(1)));
    clockless.deps.now = boom;
    expect(await getSource(spec(), clockless.deps)).toMatchObject({ state: "unavailable", error: "internal error" });
  });
});

describe("getSource: age policy", () => {
  it("states ok / stale / unavailable from the source's own timestamp, still returning old data", async () => {
    for (const [ageMin, state] of [
      [5, "ok"],
      [10, "ok"],
      [20, "stale"],
      [45, "stale"],
      [50, "unavailable"],
    ] as const) {
      clearMemory();
      const { deps } = mkDeps(async () => json(doc(1, ageMin)));
      const r = await getSource(spec(), deps);
      expect(r.state, `${ageMin} min`).toBe(state);
      expect(r.data).toEqual(doc(1, ageMin));
      expect(r.fetchedAt).toBe(T0);
    }
  });

  it("clamps a future timestamp to now, so a frozen feed still ages", async () => {
    const future: Doc = { n: 1, updated: new Date(T0 + 3 * MIN).toISOString() };
    const { deps, fetch, clock } = mkDeps(async () => json(future, { etag: '"a"' }));
    expect(await getSource(spec(), deps)).toMatchObject({ state: "ok", asOf: T0 });
    fetch.mockImplementation(async () => notModified());
    clock.now = T0 + 11 * MIN;
    expect(await getSource(spec(), deps)).toMatchObject({ state: "stale", asOf: T0, fetchedAt: T0 + 11 * MIN });
  });

  it("ages by fetchedAt when the source has no timestamp; a 304 renews it", async () => {
    const s = spec({ asOf: undefined, okAgeMs: 90 * MIN, staleAgeMs: 360 * MIN });
    const { deps, fetch, clock } = mkDeps(async () => json(doc(1), { etag: '"a"' }));
    expect(await getSource(s, deps)).toMatchObject({ state: "ok", asOf: null, fetchedAt: T0 });
    fetch.mockImplementation(async () => json("down", {}, 503));
    clock.now = T0 + 120 * MIN;
    expect(await getSource(s, deps)).toMatchObject({ state: "stale", error: "http 503" });
    fetch.mockImplementation(async () => notModified());
    expect(await getSource(s, deps)).toMatchObject({ state: "ok", fetchedAt: T0 + 120 * MIN, error: null });
  });

  it("calls merge with the previous data", async () => {
    const merge = vi.fn((prev: Doc | null, next: Doc) => ({ ...next, n: (prev?.n ?? 0) + next.n }));
    let n = 0;
    const { deps, clock } = mkDeps(async () => json(doc(++n * 10), { etag: `"${n}"` }));
    const s = spec({ merge });
    expect((await getSource(s, deps)).data?.n).toBe(10);
    expect(merge).toHaveBeenLastCalledWith(null, doc(10), T0);
    clock.now = T0 + 2 * MIN;
    expect((await getSource(s, deps)).data?.n).toBe(30);
    expect(merge).toHaveBeenLastCalledWith(doc(10), doc(20), T0 + 2 * MIN);
  });

  it("writes KV whenever the data changes", async () => {
    const { kv, puts } = fakeKv();
    let n = 0;
    const { deps, clock } = mkDeps(async () => json(doc(++n)), kv);
    await getSource(spec({ validator: "none" }), deps);
    clock.now = T0 + 2 * MIN;
    await getSource(spec({ validator: "none" }), deps);
    expect(puts.map((p) => JSON.parse(p.value).data.n)).toEqual([1, 2]);
  });
});

describe("fetchText", () => {
  it("sends our User-Agent and returns 2xx bodies only", async () => {
    const { deps, fetch } = mkDeps(async () => new Response("hello", { status: 200 }));
    expect(await fetchText("https://a.test/", deps, { timeoutMs: 100, headers: { "User-Agent": "other", Accept: "text/xml" } })).toMatchObject({
      status: 200,
      body: "hello",
      error: null,
    });
    expect(header(fetch.mock.calls[0]![1], "User-Agent")).toBe(UA);
    expect(header(fetch.mock.calls[0]![1], "Accept")).toBe("text/xml");
    fetch.mockImplementation(async () => new Response("nope", { status: 404 }));
    expect(await fetchText("https://a.test/", deps, { timeoutMs: 100 })).toMatchObject({ status: 404, body: null, error: "http 404" });
  });
});

// ---------------------------------------------------------------------------------------------

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as unknown;
const DISTRICT_FX = fixture("vicmap-district-2026-09-27T1656.json");
const LGA_FX = fixture("vicmap-lga-2026-09-27T1656.json");
const fc = (...names: string[]) => ({
  type: "FeatureCollection",
  features: names.map((n, i) => ({ type: "Feature", id: `f.${i}`, geometry: null, properties: { tfb_district: n } })),
});
/** As returned live for the suburb at 30 km (27 Sep 2026). */
const NEIGHBOURS_FX = fc("CENTRAL", "NORTH CENTRAL");
const SUBURB = { lat: -37.73, lon: 145.22 };
const filterOf = (url: string) => new URL(url).searchParams.get("cql_filter");

describe("vicmap", () => {
  it("builds WFS point queries in lon-lat order at 3 dp with SRID=4283", () => {
    const home = { lat: -37.84461, lon: 144.97234 }; // Albert Park Lake: water, nobody's house
    const d = new URL(districtUrl(home));
    expect(d.origin + d.pathname).toBe("https://opendata.maps.vic.gov.au/geoserver/wfs");
    expect(d.searchParams.get("typeNames")).toBe("open-data-platform:cfa_tfb_district");
    expect(d.searchParams.get("propertyName")).toBe("tfb_district");
    expect(d.searchParams.get("outputFormat")).toBe("application/json");
    expect(d.searchParams.get("cql_filter")).toBe("INTERSECTS(geom,SRID=4283;POINT(144.972 -37.845))");
    expect(districtUrl(home)).toContain("cql_filter=INTERSECTS(geom%2CSRID%3D4283%3BPOINT(144.972%20-37.845))");
    const l = new URL(lgaUrl({ lat: -37.53, lon: 145.34 }));
    expect(l.searchParams.get("typeNames")).toBe("open-data-platform:vmlite_lga");
    expect(l.searchParams.get("propertyName")).toBe("lga_name");
    expect(l.searchParams.get("cql_filter")).toBe("INTERSECTS(geom,SRID=4283;POINT(145.340 -37.530))");
    expect(filterOf(neighboursUrl(SUBURB, 30))).toBe("DWITHIN(geom,SRID=4283;POINT(145.220 -37.730),30000,meters)");
    expect(filterOf(neighboursUrl(SUBURB, 7.5))).toBe("DWITHIN(geom,SRID=4283;POINT(145.220 -37.730),7500,meters)");
  });

  it("parses the district, LGA and neighbours", () => {
    expect(parseDistrict(DISTRICT_FX)).toBe("central");
    expect(parseLga(LGA_FX)).toBe("nillumbik");
    expect(parseNeighbours(NEIGHBOURS_FX)).toEqual(["central", "north_central"]);
    expect(parseDistrict(fc("NORTH CENTRAL"))).toBe("north_central");
    expect(parseDistrict(fc("WEST AND SOUTH GIPPSLAND"))).toBe("west_and_south_gippsland");
  });

  it("returns null for no single district and undefined for a bad document", () => {
    expect(parseDistrict(fc())).toBeNull();
    expect(parseDistrict(fc("CENTRAL", "NORTH CENTRAL"))).toBeNull();
    expect(parseNeighbours(fc())).toEqual([]);
    expect(parseLga({ type: "FeatureCollection", features: [] })).toBeNull();
    for (const bad of [null, "<ows:ExceptionReport/>", {}, { type: "FeatureCollection" }, { type: "FeatureCollection", features: [{}] }, fc("ATLANTIS")]) {
      expect(parseDistrict(bad)).toBeUndefined();
      expect(parseNeighbours(bad)).toBeUndefined();
    }
    expect(parseLga({ type: "FeatureCollection", features: [{ properties: { lga_name: 7 } }] })).toBeUndefined();
  });

  const vicmap: FetchFn = async (url) => {
    const f = filterOf(url) ?? "";
    if (url.includes("vmlite_lga")) return json(LGA_FX);
    if (f.startsWith("DWITHIN")) return json(NEIGHBOURS_FX);
    return json(DISTRICT_FX);
  };

  it("a district picked in the settings wins, with Vicmap's council, and Vicmap's district as a neighbour", async () => {
    const { deps, fetch } = mkDeps(vicmap);
    expect(await resolveDistrict(SUBURB, 30, "north_central", deps)).toEqual({
      lookup: { key: "north_central", lga: "nillumbik", neighbours: ["central"] },
      state: "ok",
      source: "override",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("looks up the district, LGA and neighbours, and caches them under a hashed key", async () => {
    const { kv, puts } = fakeKv();
    const { deps, fetch } = mkDeps(vicmap, kv);
    const want = { lookup: { key: "central", lga: "nillumbik", neighbours: ["north_central"] }, state: "ok", source: "vicmap" };
    expect(await lookupDistrict(SUBURB, 30, deps)).toEqual(want);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) expect(header(init, "User-Agent")).toBe(UA);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(/^district:[0-9a-f]{64}$/);
    expect(puts[0]!.opts).toEqual({ expirationTtl: 90 * 24 * 3600 });
    expect(puts[0]!.value).not.toMatch(/37\.7|145\.2/);

    expect(await lookupDistrict(SUBURB, 30, deps)).toEqual(want);
    clearMemory();
    expect(await lookupDistrict(SUBURB, 30, deps)).toEqual(want);
    expect(fetch).toHaveBeenCalledTimes(3);
    // Another radius is another question.
    await lookupDistrict(SUBURB, 60, deps);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("never guesses: no district → unknown and unavailable, and nothing cached", async () => {
    const { kv, puts } = fakeKv();
    const down = mkDeps(async () => json("busy", {}, 503), kv);
    expect(await lookupDistrict(SUBURB, 30, down.deps)).toEqual({ lookup: { key: null, lga: null, neighbours: [] }, state: "unavailable", source: "none" });
    const empty = mkDeps(async () => json(fc()), kv);
    expect(await lookupDistrict(SUBURB, 30, empty.deps)).toMatchObject({ lookup: { key: null }, state: "unavailable" });
    expect(puts).toHaveLength(0);
  });

  it("keeps a partial answer without caching it", async () => {
    const { kv, puts } = fakeKv();
    const { deps, fetch } = mkDeps(async (url) => (url.includes("vmlite_lga") ? json("x", {}, 500) : vicmap(url, {})), kv);
    expect(await lookupDistrict(SUBURB, 30, deps)).toEqual({ lookup: { key: "central", lga: null, neighbours: ["north_central"] }, state: "ok", source: "vicmap" });
    expect(puts).toHaveLength(0);
    await lookupDistrict(SUBURB, 30, deps);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("refreshes after 30 days and falls back to the old lookup as stale when Vicmap is down", async () => {
    const { kv } = fakeKv();
    const { deps, fetch, clock } = mkDeps(vicmap, kv);
    await lookupDistrict(SUBURB, 30, deps);
    fetch.mockImplementation(async () => json("down", {}, 503));
    clock.now = T0 + 29 * 24 * 3600_000;
    expect(await lookupDistrict(SUBURB, 30, deps)).toMatchObject({ lookup: { key: "central" }, state: "ok" });
    expect(fetch).toHaveBeenCalledTimes(3);
    clock.now = T0 + 31 * 24 * 3600_000;
    expect(await lookupDistrict(SUBURB, 30, deps)).toMatchObject({ lookup: { key: "central", lga: "nillumbik" }, state: "stale", source: "vicmap" });
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});

describe("logging", () => {
  it("never logs a URL or coordinates", () => {
    expect(logs.length).toBeGreaterThan(20);
    const text = JSON.stringify(logs);
    expect(text).not.toMatch(/https?:|latitude|longitude|37\.7|145\.2|POINT/);
    for (const l of logs) expect(Object.keys(l).sort()).toEqual(expect.arrayContaining(["error", "http", "ms", "src", "state"]));
  });
});
