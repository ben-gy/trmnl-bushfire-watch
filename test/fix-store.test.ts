/**
 * The store fixes from the adversarial review: a 304 renews asOf from the response's own headers (0),
 * one wall-clock deadline bounds every KV read, fetch, retry and write (9), a cached copy of an old
 * model shape is treated as absent (12), and the rating sources' age limits end at the 6 h alarm cap
 * (5). Deadlines are real time, so the budgets here are small.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_MS, gather } from "../src/gather.js";
import { isBomFdr, isBomFw, isEventsFeed, isRatingsFeed, isWeather, specs } from "../src/sources/specs.js";
import { lookupDistrict } from "../src/sources/vicmap.js";
import { clearMemory, fetchText, getSource, lastKnown, type SourceSpec } from "../src/store.js";
import type { Deps } from "../src/types.js";
import { FX, hang, HOUR, MIN, ok, type Responder, SUBURB, T_QUIET, upstream } from "./helpers.js";

beforeEach(() => {
  clearMemory();
});

const iso = (ms: number) => new Date(ms).toISOString();
const notModified = (headers: Record<string, string> = {}) => new Response(null, { status: 304, headers });
const down = () => new Response("down", { status: 503 });
/** An upstream that never answers and ignores its abort signal. */
const deaf: Responder = () => new Promise<Response>(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What may pass after a deadline: the 100/250 ms backstops plus scheduling. Without the fixes these took 4 s or forever. */
const SLACK = 450;
const header = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];

type Fetch = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** An in-memory KV whose reads and writes can be slowed or stalled. */
function kvStub(o: { getMs?: number; putHangs?: boolean; getHangs?: boolean } = {}) {
  const data = new Map<string, string>();
  const gets: string[] = [];
  const puts: string[] = [];
  const kv = {
    async get(key: string, type?: string) {
      gets.push(key);
      if (o.getHangs) await new Promise(() => {});
      if (o.getMs) await sleep(o.getMs);
      const v = data.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    put(key: string, value: string) {
      puts.push(key);
      if (o.putHangs) return new Promise<void>(() => {});
      data.set(key, value);
      return Promise.resolve();
    },
  };
  return { kv: kv as unknown as KVNamespace, data, gets, puts };
}

function mkDeps(f: Fetch, kv: KVNamespace | null = null, t = T_QUIET) {
  const clock = { now: t };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => f(url, init));
  const logs: Record<string, unknown>[] = [];
  const deps: Deps = { fetch: fetch as unknown as typeof globalThis.fetch, now: () => clock.now, kv, log: (l) => logs.push(l) };
  return { deps, fetch, clock, logs };
}

const S = specs(SUBURB, "k");

// ---------------------------------------------------------------------------------------------

describe("[0] a 304 renews asOf from the response's own headers", () => {
  it("keeps osom 'ok' at +61 min when the 304 carries a newer x-amz-meta-lastupdated", async () => {
    const kv = kvStub();
    let first = true;
    const { deps, fetch, clock } = mkDeps((_u, init) => {
      if (first) {
        first = false;
        return ok(FX.osom, { etag: '"os1"', "x-amz-meta-lastupdated": iso(T_QUIET - MIN) });
      }
      expect(header(init, "If-None-Match")).toBe('"os1"');
      return notModified({ etag: '"os1"', "x-amz-meta-lastupdated": iso(clock.now - MIN) });
    }, kv.kv);
    expect(await getSource(S.osom, deps)).toMatchObject({ state: "ok", asOf: T_QUIET - MIN });
    clock.now = T_QUIET + 61 * MIN;
    const r = await getSource(S.osom, deps);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ state: "ok", asOf: T_QUIET + 60 * MIN, fetchedAt: T_QUIET + 61 * MIN, error: null });
    // A renewed asOf is a change: KV gets it, so a fresh isolate agrees.
    expect(JSON.parse(kv.data.get(S.osom.key)!).asOf).toBe(T_QUIET + 60 * MIN);
    clearMemory();
    expect(await getSource(S.osom, mkDeps(() => down(), kv.kv, T_QUIET + 62 * MIN).deps)).toMatchObject({ state: "ok", asOf: T_QUIET + 60 * MIN });
  });

  it("without a newer header time a 304 renews nothing: osom goes stale after an hour", async () => {
    const older: Record<string, string>[] = [{}, { "x-amz-meta-lastupdated": iso(T_QUIET - 3 * HOUR) }, { "x-amz-meta-lastupdated": "garbage" }];
    for (const h of older) {
      clearMemory();
      const { deps, fetch, clock } = mkDeps(() => ok(FX.osom, { etag: '"os1"', "x-amz-meta-lastupdated": iso(T_QUIET - MIN) }));
      await getSource(S.osom, deps);
      fetch.mockImplementation(async () => notModified(h));
      clock.now = T_QUIET + 61 * MIN;
      expect(await getSource(S.osom, deps), JSON.stringify(h)).toMatchObject({ state: "stale", asOf: T_QUIET - MIN });
    }
  });

  it("clamps a 304's future header time to now", async () => {
    const { deps, fetch, clock } = mkDeps(() => ok(FX.osom, { etag: '"os1"', "x-amz-meta-lastupdated": iso(T_QUIET - MIN) }));
    await getSource(S.osom, deps);
    fetch.mockImplementation(async () => notModified({ "x-amz-meta-lastupdated": iso(T_QUIET + 5 * HOUR) }));
    clock.now = T_QUIET + 10 * MIN;
    expect(await getSource(S.osom, deps)).toMatchObject({ state: "ok", asOf: T_QUIET + 10 * MIN });
  });

  it("renews CFA from the 304's Last-Modified", async () => {
    const { deps, fetch, clock } = mkDeps(() => ok(FX.cfa, { etag: '"cf1"', "last-modified": new Date(T_QUIET - 5 * MIN).toUTCString() }, "application/rss+xml"));
    expect(await getSource(S.cfa, deps)).toMatchObject({ state: "ok" });
    clock.now = T_QUIET + 90 * MIN;
    fetch.mockImplementation(async () => notModified({ "last-modified": new Date(T_QUIET + 80 * MIN).toUTCString() }));
    expect(await getSource(S.cfa, deps)).toMatchObject({ state: "ok", asOf: T_QUIET + 80 * MIN });
  });

  it("leaves a data-derived asOf alone, so a frozen events feed or BoM issue still ages", async () => {
    const { deps, fetch, clock } = mkDeps(() => ok(FX.events, { etag: '"ev1"' }));
    const first = await getSource(S.events, deps);
    expect(first.state).toBe("ok");
    fetch.mockImplementation(async () => notModified({ "x-amz-meta-lastupdated": iso(T_QUIET + 11 * MIN), "last-modified": new Date(T_QUIET + 11 * MIN).toUTCString() }));
    clock.now = T_QUIET + 11 * MIN;
    expect(await getSource(S.events, deps)).toMatchObject({ state: "stale", asOf: first.asOf });

    const bom = mkDeps(() => ok(FX.idv18555, { "last-modified": new Date(T_QUIET - HOUR).toUTCString() }, "application/xml"));
    const b1 = await getSource(S.bomFdr, bom.deps);
    expect(b1.asOf).toBe(Date.parse("2026-09-27T06:00:00Z"));
    bom.fetch.mockImplementation(async () => notModified({ "last-modified": new Date(T_QUIET + HOUR).toUTCString() }));
    bom.clock.now = T_QUIET + HOUR;
    expect(await getSource(S.bomFdr, bom.deps)).toMatchObject({ asOf: b1.asOf, fetchedAt: T_QUIET + HOUR });
  });
});

// ---------------------------------------------------------------------------------------------

describe("[9] one wall-clock deadline bounds every step", () => {
  function spec(over: Partial<SourceSpec<{ n: number }>> = {}): SourceSpec<{ n: number }> {
    return {
      id: "osom",
      key: "src:deadline",
      url: "https://feed.example.test/x.json",
      refreshMs: MIN,
      okAgeMs: 10 * MIN,
      staleAgeMs: 45 * MIN,
      timeoutMs: 10_000,
      validator: "etag",
      parse: (b) => JSON.parse(b) as { n: number },
      ...over,
    };
  }

  it("an unrequested 304 then a hung retry: the retry is cut to the time left", async () => {
    const { deps, fetch, logs } = mkDeps(async (url, init) => {
      if (fetch.mock.calls.length === 1) {
        await sleep(100);
        return notModified();
      }
      return hang(url, init);
    });
    const t0 = Date.now();
    const r = await getSource(spec(), deps, { deadline: t0 + 1500 });
    const took = Date.now() - t0;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1]!.signal!.aborted).toBe(true);
    expect(r).toMatchObject({ state: "unavailable", data: null, error: "timeout" });
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(1500 + SLACK);
    expect(logs.at(-1)).toMatchObject({ src: "osom", state: "unavailable", error: "timeout" });
  });

  it("skips the retry when under a second remains", async () => {
    const { deps, fetch } = mkDeps(async () => {
      await sleep(100);
      return notModified();
    });
    const t0 = Date.now();
    const r = await getSource(spec(), deps, { deadline: t0 + 700 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ state: "unavailable", error: "304 without data" });
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("a slow KV read, an unrequested 304 and a hung retry together still end at the deadline", async () => {
    const kv = kvStub({ getMs: 300 });
    const { deps, fetch } = mkDeps(async (url, init) => {
      if (fetch.mock.calls.length === 1) {
        await sleep(200);
        return notModified();
      }
      return hang(url, init);
    }, kv.kv);
    const t0 = Date.now();
    const r = await getSource(spec(), deps, { deadline: t0 + 1600 });
    const took = Date.now() - t0;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r.error).toBe("timeout");
    expect(took).toBeLessThan(1600 + SLACK);
  });

  it("a stalled KV read is cut to the deadline, and no request starts with no time left", async () => {
    const kv = kvStub({ getHangs: true });
    const { deps, fetch } = mkDeps(() => ok('{"n":1}'), kv.kv);
    const t0 = Date.now();
    const r = await getSource(spec(), deps, { deadline: t0 + 300 });
    expect(Date.now() - t0).toBeLessThan(300 + SLACK);
    expect(fetch).not.toHaveBeenCalled();
    expect(r).toMatchObject({ state: "unavailable", error: "timeout" });
    expect(await fetchText("https://feed.example.test/", deps, { timeoutMs: 0 })).toMatchObject({ status: 0, error: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a fetch deaf to its abort leaves the last good copy, aged, at the deadline", async () => {
    const { deps, fetch, clock } = mkDeps(() => ok('{"n":1}', { etag: '"a"' }));
    await getSource(spec(), deps);
    fetch.mockImplementation(async () => deaf(""));
    clock.now = T_QUIET + 2 * MIN;
    const t0 = Date.now();
    const r = await getSource(spec(), deps, { deadline: t0 + 300 });
    expect(Date.now() - t0).toBeLessThan(300 + SLACK);
    expect(r).toMatchObject({ state: "ok", data: { n: 1 }, fetchedAt: T_QUIET, error: "timeout" });
  });

  it("a stalled KV write doesn't hold the answer: bounded without waitUntil, handed off with it", async () => {
    const kv = kvStub({ putHangs: true });
    const { deps } = mkDeps(() => ok('{"n":1}'), kv.kv);
    const t0 = Date.now();
    expect(await getSource(spec(), deps, { deadline: t0 + 300 })).toMatchObject({ state: "ok", data: { n: 1 } });
    expect(Date.now() - t0).toBeLessThan(300 + SLACK);
    expect(kv.puts).toEqual(["src:deadline"]);

    clearMemory();
    const pending: Promise<unknown>[] = [];
    const t1 = Date.now();
    expect(await getSource(spec(), deps, { deadline: t1 + 5000, waitUntil: (p) => pending.push(p) })).toMatchObject({ state: "ok" });
    expect(Date.now() - t1).toBeLessThan(200);
    expect(pending).toHaveLength(1);
  });

  it("bounds the district lookup's KV read, queries and cache write", async () => {
    const kv = kvStub({ putHangs: true });
    const up = upstream(T_QUIET);
    const { deps } = mkDeps((u, i) => up.fetch(u, i), kv.kv);
    const t0 = Date.now();
    expect(await lookupDistrict(SUBURB, 30, deps, { deadline: t0 + 400 })).toMatchObject({ lookup: { key: "central" }, state: "ok" });
    expect(Date.now() - t0).toBeLessThan(400 + SLACK);
    expect(kv.puts).toHaveLength(1);

    clearMemory();
    const pending: Promise<unknown>[] = [];
    const t1 = Date.now();
    await lookupDistrict(SUBURB, 30, deps, { deadline: t1 + 5000, waitUntil: (p) => pending.push(p) });
    expect(Date.now() - t1).toBeLessThan(200);
    expect(pending).toHaveLength(1);

    clearMemory();
    const slow = mkDeps(hang, kvStub({ getHangs: true }).kv);
    const t2 = Date.now();
    expect(await lookupDistrict(SUBURB, 30, slow.deps, { deadline: t2 + 300 })).toMatchObject({ state: "unavailable", lookup: { key: null } });
    expect(Date.now() - t2).toBeLessThan(300 + SLACK);
  });
});

describe("[9] gather() answers by its deadline", () => {
  const cfg = { home: SUBURB, district: null, radiusKm: 30 };

  it("defaults to 6.5 s, inside the plan's 7 s", () => {
    expect(BUDGET_MS).toBe(6500);
  });

  it("finishes by its deadline when a source hangs deaf to its abort and every KV put hangs", async () => {
    const kv = kvStub({ putHangs: true });
    const up = upstream(T_QUIET, { events: deaf });
    const t0 = Date.now();
    const g = await gather(cfg, { fetch: up.fetch, now: () => T_QUIET, kv: kv.kv, log: () => {} }, { budgetMs: 800 });
    const took = Date.now() - t0;
    expect(took).toBeLessThan(800 + SLACK);
    expect(g.events).toMatchObject({ state: "unavailable", data: null, error: "timeout" });
    for (const s of [g.osom, g.cfa, g.bomFdr, g.bomFw, g.weather]) expect(s, s.id).toMatchObject({ state: "ok", error: null });
    expect(g.district).toMatchObject({ lookup: { key: "central" }, state: "ok", source: "vicmap" });
    // Every write was attempted, none was waited for past the deadline.
    expect(kv.puts.length).toBeGreaterThanOrEqual(6);
  });

  it("finishes by its deadline when KV reads stall too", async () => {
    const kv = kvStub({ getHangs: true, putHangs: true });
    const up = upstream(T_QUIET, { events: deaf });
    const t0 = Date.now();
    const g = await gather(cfg, { fetch: up.fetch, now: () => T_QUIET, kv: kv.kv, log: () => {} }, { budgetMs: 2200 });
    expect(Date.now() - t0).toBeLessThan(2200 + SLACK);
    expect(g.events.state).toBe("unavailable");
    // KV reads give up after 1.5 s, leaving time to fetch.
    expect(g.osom.state).toBe("ok");
    expect(g.district.state).toBe("ok");
  });

  it("keeps a district picked in the settings when the Vicmap lookup outlives the deadline", async () => {
    const up = upstream(T_QUIET, { vicmap: deaf });
    const t0 = Date.now();
    const g = await gather({ ...cfg, district: "central" }, { fetch: up.fetch, now: () => T_QUIET, kv: null, log: () => {} }, { budgetMs: 400 });
    expect(Date.now() - t0).toBeLessThan(400 + SLACK);
    expect(g.district).toEqual({ lookup: { key: "central", lga: null, neighbours: [] }, state: "ok", source: "override" });
    expect(g.osom.state).toBe("ok");
  });

  it("hands every KV write, the district's included, to waitUntil and doesn't wait for them", async () => {
    const kv = kvStub({ putHangs: true });
    const up = upstream(T_QUIET);
    const pending: Promise<unknown>[] = [];
    const t0 = Date.now();
    const g = await gather(cfg, { fetch: up.fetch, now: () => T_QUIET, kv: kv.kv, log: () => {} }, { waitUntil: (p) => pending.push(p) });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(g.events.state).toBe("ok");
    expect(pending).toHaveLength(7);
    expect(kv.puts.some((k) => k.startsWith("district:"))).toBe(true);
  });

  it("lastKnown answers from memory alone", async () => {
    const { deps } = mkDeps(() => ok(FX.osom, { "x-amz-meta-lastupdated": iso(T_QUIET - MIN) }));
    expect(lastKnown(S.osom, T_QUIET, "timeout")).toMatchObject({ state: "unavailable", data: null, error: "timeout" });
    await getSource(S.osom, deps);
    expect(lastKnown(S.osom, T_QUIET + 2 * HOUR, "timeout")).toMatchObject({ state: "stale", asOf: T_QUIET - MIN, error: "timeout" });
    expect(lastKnown(S.osom, T_QUIET + 2 * HOUR, "timeout").data).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("[12] a cached copy of the wrong model shape is treated as absent", () => {
  const entry = (data: unknown, at = T_QUIET - 10_000) => JSON.stringify({ v: 1, data, fetchedAt: at, asOf: at, etag: null, lastModified: null });
  const OLD_EVENTS = { lastUpdated: T_QUIET - 10_000, items: [] };

  it("versions every cache key by model, after any fixture prefix", () => {
    expect(Object.values(S).map((s) => s.key)).toEqual(["src:v1:events", "src:v1:osom", "src:v1:cfa", "src:v1:bom_fdr", "src:v1:bom_fw", "src:v1:weather:k"]);
    expect(specs(SUBURB, "k", "fx:quiet:").events.key).toBe("fx:quiet:src:v1:events");
  });

  it("refetches over an old-shaped KV copy, and replaces it", async () => {
    const kv = kvStub();
    kv.data.set(S.events.key, entry(OLD_EVENTS));
    const { deps, fetch } = mkDeps(() => ok(FX.events, { etag: '"ev1"' }), kv.kv);
    const r = await getSource(S.events, deps);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.state).toBe("ok");
    expect(isEventsFeed(r.data)).toBe(true);
    expect(isEventsFeed(JSON.parse(kv.data.get(S.events.key)!).data)).toBe(true);
  });

  it("never returns an old-shaped copy, even when the upstream is down", async () => {
    const kv = kvStub();
    kv.data.set(S.events.key, entry(OLD_EVENTS));
    kv.data.set(S.osom.key, entry({ fdr: [], tfb: {} }));
    const { deps } = mkDeps(() => down(), kv.kv);
    expect(await getSource(S.events, deps)).toMatchObject({ state: "unavailable", data: null, error: "http 503" });
    expect(await getSource(S.osom, deps)).toMatchObject({ state: "unavailable", data: null, error: "http 503" });
  });

  it("never reads the unversioned keys an earlier deploy wrote", async () => {
    const kv = kvStub();
    kv.data.set("src:events", entry(OLD_EVENTS));
    const up = upstream(T_QUIET);
    const g = await gather({ home: SUBURB, district: "central", radiusKm: 30 }, { fetch: up.fetch, now: () => T_QUIET, kv: kv.kv, log: () => {} });
    expect(kv.gets).not.toContain("src:events");
    expect(g.events.state).toBe("ok");
    expect(isEventsFeed(g.events.data)).toBe(true);
  });

  it("applies the guard to isolate memory too", async () => {
    const plain: SourceSpec<{ n: number }> = {
      id: "osom",
      key: "src:shared",
      url: "https://feed.example.test/x.json",
      refreshMs: HOUR,
      okAgeMs: HOUR,
      staleAgeMs: HOUR,
      timeoutMs: 1000,
      validator: "none",
      parse: (b) => JSON.parse(b) as { n: number },
    };
    const { deps, fetch } = mkDeps(() => ok('{"n":1}'));
    await getSource(plain, deps);
    const guarded = { ...plain, valid: (d: unknown): d is { n: number } => typeof (d as { n?: unknown }).n === "string" };
    await getSource(guarded, deps);
    expect(fetch).toHaveBeenCalledTimes(2);
    const throwing = { ...plain, valid: (_d: unknown): _d is { n: number } => {
      throw new Error("boom");
    } };
    expect(await getSource(throwing, deps)).toMatchObject({ state: "ok" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  const res = new Response(null);
  const roundTrip = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));

  it("accepts what each parser makes from the real snapshots, after a trip through KV's JSON", () => {
    expect(isEventsFeed(roundTrip(S.events.parse(FX.events, res)))).toBe(true);
    expect(isEventsFeed(roundTrip(S.events.parse(FX.eventsJan, res)))).toBe(true);
    expect(isRatingsFeed(roundTrip(S.osom.parse(FX.osom, res)))).toBe(true);
    expect(isRatingsFeed(roundTrip(S.cfa.parse(FX.cfa, res)))).toBe(true);
    const fdr = S.bomFdr.parse(FX.idv18555, res)!;
    expect(isBomFdr(roundTrip(fdr))).toBe(true);
    expect(isBomFdr(roundTrip(S.bomFdr.merge!(fdr, fdr, T_QUIET)))).toBe(true);
    const fw = S.bomFw.parse(FX.idv18560, res)!;
    expect(isBomFw(roundTrip(fw))).toBe(true);
    expect(isBomFw(roundTrip(S.bomFw.merge!(fw, fw, T_QUIET)))).toBe(true);
    expect(isWeather(roundTrip(S.weather.parse(FX.openMeteo, res)))).toBe(true);
  });

  it("rejects other shapes", () => {
    const events = S.events.parse(FX.events, res)!;
    const badFeature = { ...events, features: [{ ...events.features[0], geo: { coordinates: [] } }] };
    for (const bad of [null, [], {}, OLD_EVENTS, { ...events, conditions: {} }, badFeature, { ...events, lastUpdated: "today" }]) expect(isEventsFeed(bad)).toBe(false);
    const ratings = S.osom.parse(FX.osom, res)!;
    for (const bad of [null, {}, { ...ratings, notYet: {} }, { ...ratings, fdr: [] }, { ...ratings, issued: null }, { ...ratings, tfb: { "2026-09-27": "YES" } }]) expect(isRatingsFeed(bad)).toBe(false);
    for (const bad of [null, {}, { issued: 1, nextIssue: null, days: [] }, { issued: 1, nextIssue: null, days: { central: "Moderate" } }]) expect(isBomFdr(bad)).toBe(false);
    for (const bad of [null, {}, { issued: 1, district: {}, subarea: [] }, { issued: 1, district: { central: {} }, subarea: {} }]) expect(isBomFw(bad)).toBe(false);
    for (const bad of [null, {}, { currentAt: null, current: null, hours: {} }, { currentAt: null, current: null, hours: [{ temp: 20 }] }]) expect(isWeather(bad)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe("[5] rating sources end at the 6 h alarm cap", () => {
  async function agedCopy<T>(spec: SourceSpec<T>, body: string, headers: Record<string, string>, fetchAt: number) {
    const { deps, fetch, clock } = mkDeps(() => ok(body, headers), null, fetchAt);
    expect((await getSource(spec, deps)).state).toBe("ok");
    fetch.mockImplementation(async () => down());
    return async (at: number) => {
      clock.now = at;
      return (await getSource(spec, deps)).state;
    };
  }

  it("OSOM and CFA: ok for an hour, stale to 6 h, then unavailable", async () => {
    const osom = await agedCopy(S.osom, FX.osom, { "x-amz-meta-lastupdated": iso(T_QUIET) }, T_QUIET);
    expect(await osom(T_QUIET + 59 * MIN)).toBe("ok");
    expect(await osom(T_QUIET + 5 * HOUR + 59 * MIN)).toBe("stale");
    expect(await osom(T_QUIET + 6 * HOUR + MIN)).toBe("unavailable");
    clearMemory();
    const cfa = await agedCopy(S.cfa, FX.cfa, { "last-modified": new Date(T_QUIET).toUTCString() }, T_QUIET);
    expect(await cfa(T_QUIET + 5 * HOUR + 59 * MIN)).toBe("stale");
    expect(await cfa(T_QUIET + 6 * HOUR + MIN)).toBe("unavailable");
  });

  it("BoM IDV18555: stale an hour past its next routine issue, unavailable 6 h past it", async () => {
    // Issued 06:00Z (16:00 AEST); next routine issue 19:30Z (05:30 AEST).
    const next = Date.parse("2026-09-27T19:30:00Z");
    const bom = await agedCopy(S.bomFdr, FX.idv18555, {}, Date.parse("2026-09-27T06:30:00Z"));
    expect(await bom(next + 59 * MIN)).toBe("ok");
    expect(await bom(next + 61 * MIN)).toBe("stale");
    expect(await bom(next + 5 * HOUR + 59 * MIN)).toBe("stale");
    // 19.5 h after the issue: within the 24 h age limit, but 6 h past the next issue.
    expect(await bom(next + 6 * HOUR + MIN)).toBe("unavailable");
  });

  it("BoM without a next issue time, and IDV18560: ok to 18 h, stale to 24 h", async () => {
    const issued = Date.parse("2026-09-27T06:00:00Z");
    const noNext = FX.idv18555.replace(/<next-routine-issue-time-utc>[^<]*<\/next-routine-issue-time-utc>/, "");
    for (const [spec, body] of [
      [S.bomFdr, noNext],
      [S.bomFw, FX.idv18560],
    ] as const) {
      clearMemory();
      const at = await agedCopy(spec as SourceSpec<unknown>, body, {}, issued + 30 * MIN);
      expect(await at(issued + 17 * HOUR), spec.id).toBe("ok");
      expect(await at(issued + 23 * HOUR), spec.id).toBe("stale");
      expect(await at(issued + 24 * HOUR + MIN), spec.id).toBe("unavailable");
    }
  });
});
