/**
 * The real Worker, end to end: app.fetch() with the exported `deps` pointed at a fake upstream that
 * serves the scrubbed snapshots by URL. Covers the plan's must-pass cases that need the whole route:
 * fixture scenarios, the fault matrix (8), configuration and privacy (10), budgets (11) and the
 * other routes. A family may read this screen on a Catastrophic day, so every failure here is
 * checked for looking like good news: always HTTP 200 with valid JSON, never a 0 from a source
 * that could not be read.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import app, { deps } from "../src/index.js";
import { specs } from "../src/sources/specs.js";
import { clearMemory } from "../src/store.js";
import type { Deps, PayloadV1 } from "../src/types.js";
import {
  band,
  BUDGET_BYTES,
  budgetViolations,
  bytes,
  EMAIL,
  fakeKv,
  FX,
  goodBody,
  hang,
  LOG_ID,
  type LogLine,
  ok,
  render,
  RENDER_ERROR,
  type Responder,
  SOURCE_KEYS,
  sourceOf,
  type SourceKey,
  statesFrom,
  T_QUIET,
  text,
  type Upstream,
  upstream,
  ZERO_CLAIM,
} from "./helpers.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const TOKEN = "t";
const ENV: Env = { BRIEF_TOKEN: TOKEN };
const ORIGIN = "https://trmnl-fire-risk.test";
const RATING_WORDS = /\b(NO RATING|MODERATE|HIGH|EXTREME|CATASTROPHIC|TOTAL FIRE BAN)\b/;

const original: Deps = { ...deps };
let logs: LogLine[] = [];
let up: Upstream;

function use(u: Upstream, now = T_QUIET): void {
  up = u;
  deps.fetch = u.fetch;
  deps.now = () => now;
}

beforeEach(() => {
  clearMemory();
  logs = [];
  deps.log = (o) => logs.push(o);
  deps.kv = null;
  use(upstream(T_QUIET));
});

afterEach(() => {
  Object.assign(deps, original);
});

async function call(path: string, o: { headers?: Record<string, string>; env?: Env; method?: string } = {}) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: o.method ?? "GET", headers: o.headers }), o.env ?? ENV, ctx);
  await Promise.allSettled(pending);
  return { res, body: await res.text() };
}

const LIVE = (home = "-37.73,145.22", district = "auto"): Record<string, string> => ({
  "x-brief-token": TOKEN,
  "x-home-secret": home,
  "x-district": district,
  "x-radius-km": "30",
});

/** GET /v1/brief.json, checking what TRMNL needs of every answer: 200, JSON, no-store, contract v1. */
async function brief(headers: Record<string, string> = LIVE(), env: Env = ENV, query = "") {
  const { res, body } = await call(`/v1/brief.json${query}`, { headers, env });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const p = JSON.parse(body) as PayloadV1;
  expect(p.v).toBe(1);
  expect(Object.keys(p)).not.toContain("trmnl");
  expect(Object.keys(p).filter((k) => k.startsWith("IDX_"))).toEqual([]);
  return { res, body, p };
}

// ---------------------------------------------------------------------------------------------

describe("a healthy live poll (27 Sep, 17:00, suburb point)", () => {
  it("reads every source, stays within budget and renders the checked time", async () => {
    const kv = fakeKv();
    const { body, p } = await brief(LIVE(), { ...ENV, FIRE_KV: kv.kv });
    const states = statesFrom(logs);
    for (const s of SOURCE_KEYS) expect(states[LOG_ID[s]], s).toBe("ok");
    expect(up.unknown).toEqual([]);
    expect(p.ok).toBe(true);
    expect(p.sample).toBeUndefined();
    expect(p.district).toBe("Central");
    expect(p.checked_local).toBe("Sun 17:00");
    expect(p.generated_epoch).toBe(T_QUIET / 1000);
    expect(p.house.status).toBe("clear");
    expect(p.days[0].fdr).toMatchObject({ level: 1, word: "MODERATE" });
    expect(p.incidents.ok).toBe(true);
    expect(p.incidents.counts).toHaveLength(5);
    expect(bytes(body)).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(budgetViolations(p)).toEqual([]);
    // The last-good copies went to KV (through waitUntil).
    // Keys are versioned by the model (store contract), so they come from the specs.
    const s = specs({ lat: -37.73, lon: 145.22 }, "");
    expect([...kv.data.keys()].sort()).toEqual(expect.arrayContaining([s.events.key, s.osom.key, s.cfa.key, s.bomFdr.key, s.bomFw.key]));
    expect(s.events.key).toMatch(/^src:v\d+:events$/);

    const html = render(p);
    expect(html).not.toMatch(RENDER_ERROR);
    expect(html).toContain("Checked Sun 17:00");
    expect(html).not.toContain("SAMPLE");
    expect(html).toContain("State of Victoria");
    expect(html).toContain(p.disclaimer);
  });

  it("is OUT OF DATE, without ratings or counts, when rendered more than an hour after it was made", async () => {
    const { p } = await brief();
    const t = text(render(p, 3700));
    expect(t).toContain("OUT OF DATE");
    expect(t).not.toMatch(RATING_WORDS);
    expect(t).not.toMatch(ZERO_CLAIM);
    expect(text(render(p, 3500))).not.toContain("OUT OF DATE");
  });

  it("answers 200 DATA UNAVAILABLE when the Worker itself fails", async () => {
    deps.now = () => {
      throw new Error("boom");
    };
    const { p } = await brief();
    expect(p.ok).toBe(false);
    expect(p.down_title).toBe("DATA UNAVAILABLE");
    expect(logs).toContainEqual({ route: "/v1/brief.json", error: "internal" });
    expect(text(render(p))).not.toMatch(RATING_WORDS);
  });
});

// ---------------------------------------------------------------------------------------------

describe("?fixture= scenarios", () => {
  const NAMES = ["quiet", "busy-warrandyte", "catastrophic", "horsham-inside", "outage"] as const;
  const scenario = async (name: string) => {
    const kv = fakeKv();
    const r = await brief({ "x-brief-token": TOKEN }, { ...ENV, FIRE_KV: kv.kv }, `?fixture=${name}`);
    return { ...r, kv, html: render(r.p) };
  };

  for (const name of NAMES) {
    it(`${name}: 200, sample data, within 6 KB and every character budget, no upstream call or cache write`, async () => {
      const { body, p, kv, html } = await scenario(name);
      expect(p.sample).toBe(true);
      expect(bytes(body)).toBeLessThanOrEqual(BUDGET_BYTES);
      expect(budgetViolations(p)).toEqual([]);
      expect(up.calls).toEqual([]);
      expect(kv.puts).toEqual([]);
      expect(kv.gets).toEqual([]);
      expect(body).not.toMatch(EMAIL);
      expect(html).not.toMatch(RENDER_ERROR);
      expect(html).toContain("SAMPLE DATA · NOT LIVE");
      expect(html).toContain("State of Victoria");
      expect(html).toContain("If you see fire, call 000.");
      // A sample left on the device is watermarked, never aged into looking live.
      expect(render(p, 7 * 24 * 3600)).toContain("SAMPLE DATA · NOT LIVE");
    });
  }

  it("quiet: Moderate, no TFB, house clear, counts from the live snapshot", async () => {
    const { p, html } = await scenario("quiet");
    expect(p.ok).toBe(true);
    expect(p.district).toBe("Central");
    expect(p.house.status).toBe("clear");
    expect(p.days[0].fdr).toMatchObject({ level: 1, word: "MODERATE", action: "Plan and prepare" });
    expect(p.days[0].tfb.state).toBe("none");
    expect(p.incidents.ok).toBe(true);
    expect(p.incidents.counts!.map((c) => c.n)).toEqual(["0", "1", "0", "0", "0"]);
    expect(band(html)).toContain("MODERATE");
    expect(band(html)).not.toContain("WARNINGS UNAVAILABLE");
  });

  it("busy-warrandyte: Extreme and a Total Fire Ban, the Kinglake Watch and Act 21 km away listed first", async () => {
    const { p, html } = await scenario("busy-warrandyte");
    expect(p.house.status).toBe("clear");
    expect(p.days[0].fdr).toMatchObject({ level: 3, word: "EXTREME" });
    expect(p.days[0].tfb).toEqual({ state: "declared", text: "TOTAL FIRE BAN" });
    expect(p.incidents.rows![0]).toMatchObject({ kind: "warning", line1: "21 km N · WATCH AND ACT" });
    expect(p.incidents.counts![0]!.n).toBe("1");
    expect(p.statewide).toMatch(/^Statewide: /);
    expect(band(html)).toContain("fw-band inverse p--2");
    expect(band(html)).toContain("TOTAL FIRE BAN");
  });

  it("catastrophic: Kinglake inside a Watch and Act, an Emergency Warning 9.7 km away, CATASTROPHIC and TFB kept in the band", async () => {
    const { p, html } = await scenario("catastrophic");
    expect(p.ok).toBe(true);
    expect(p.district).toBe("North Central");
    expect(p.house).toMatchObject({ status: "in_warning", rank: 2, level: "WATCH AND ACT" });
    expect(p.house.action).toMatch(/^PREPARE TO LEAVE/);
    expect(p.days[0].fdr).toMatchObject({ level: 4, word: "CATASTROPHIC", action: "For your survival, leave bushfire risk areas" });
    expect(p.days[0].tfb.state).toBe("declared");
    const rows = p.incidents.rows!;
    expect(rows[0]).toMatchObject({ kind: "warning", line1: "IN AREA · WATCH AND ACT" });
    const ew = rows.find((r) => /EMERGENCY WARNING$/.test(r.line1))!;
    expect(ew.line1).toMatch(/^9\.7 km [NESW]{1,3} · EMERGENCY WARNING$/);
    expect(ew.sev).toBe(3);
    expect(p.incidents.more).toBeGreaterThan(0);

    const b = band(html);
    expect(b).toContain("WATCH AND ACT");
    expect(b).toContain("Today: CATASTROPHIC");
    expect(b).toContain("TOTAL FIRE BAN");
    expect(html).toContain('<span class="fw-f2 p--0.5 flex"><span class="label label--filled">CATASTROPHIC</span></span>');
    expect(html).toContain(ew.line1);
  });

  it("horsham-inside: the house banner shows although no fire is going within 30 km", async () => {
    const { p, html } = await scenario("horsham-inside");
    expect(p.house).toMatchObject({ status: "in_warning", level: "WATCH AND ACT" });
    expect(p.incidents.counts![1]).toMatchObject({ label: "going", n: "0" });
    expect(p.incidents.rows![0]!.line1).toBe("IN AREA · WATCH AND ACT");
    expect(band(html)).toContain("WATCH AND ACT");
    expect(band(html)).toContain("IN A WARNING AREA");
  });

  it("outage: DATA UNAVAILABLE across the screen, no ratings, no counts", async () => {
    const { p, html } = await scenario("outage");
    expect(p.ok).toBe(false);
    expect(p.down_title).toBe("DATA UNAVAILABLE");
    expect(p.incidents.ok).toBe(false);
    expect(p.incidents.counts).toBeUndefined();
    const t = text(html);
    expect(t).toContain("DATA UNAVAILABLE");
    expect(t).not.toMatch(RATING_WORDS);
    expect(t).not.toMatch(ZERO_CLAIM);
    expect(html).not.toContain("fw-count");
  });

  it("an unknown fixture is a configuration error, not live data", async () => {
    const { res, p } = await brief({ "x-brief-token": TOKEN }, ENV, "?fixture=nope");
    expect(p.ok).toBe(false);
    expect(p.sample).toBe(true);
    expect(p.down_title).toBe("CONFIGURATION ERROR");
    expect(res.headers.get("x-brief-error")).toBe("fixture");
    expect(up.calls).toEqual([]);
  });

  it("still needs the token", async () => {
    const { p } = await brief({}, ENV, "?fixture=catastrophic");
    expect(p.ok).toBe(false);
    expect(p.down_title).toBe("CONFIGURATION ERROR");
    expect(p.sample).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Fault matrix: one source broken, everything else healthy.

type Fault = (src: SourceKey, url: string) => Response | Promise<Response>;

const WAF_PAGE =
  "<!DOCTYPE html><html><head><title>Request Rejected</title></head><body>The requested URL was rejected. " +
  "Please consult with your administrator.<br><br>Your support ID is: 1234567890123456789</body></html>";

/** Well-formed documents of the wrong shape: what a schema change or a wrong product looks like. */
const WRONG_SHAPE: Record<SourceKey, string> = {
  events: JSON.stringify({ type: "FeatureCollection", properties: { lastUpdated: new Date(T_QUIET).toISOString() }, features: { count: 0 } }),
  osom: JSON.stringify({ results: { status: "N" } }),
  cfa: '<?xml version="1.0"?><rss version="2.0"><channel><title>CFA</title><description>Down for maintenance</description></channel></rss>',
  // Each BoM product served in place of the other.
  bom_fdr: FX.idv18560,
  bom_fw: FX.idv18555,
  weather: JSON.stringify({ latitude: -37.75, longitude: 145.25, hourly: { time: "unavailable" } }),
  vicmap: JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "CENTRAL" } }] }),
};

const FAULTS: Record<string, Fault> = {
  "network error": () => Promise.reject(new TypeError("fetch failed")),
  "timeout (aborted)": () => Promise.reject(new DOMException("The operation was aborted due to timeout", "AbortError")),
  "HTTP 500": () => new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } }),
  "403 HTML": () => new Response("<html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>", { status: 403, headers: { "content-type": "text/html" } }),
  "200 WAF HTML": () => ok(WAF_PAGE, {}, "text/html"),
  "200 empty": () => ok(""),
  "200 truncated": (src, url) => {
    const b = goodBody(src, url);
    return ok(b.slice(0, Math.floor(b.length / 2)));
  },
  "200 wrong shape": (src) => ok(WRONG_SHAPE[src]),
  "304 with nothing stored": () => new Response(null, { status: 304 }),
};

let baseline: PayloadV1;

beforeAll(async () => {
  clearMemory();
  use(upstream(T_QUIET));
  deps.log = () => {};
  baseline = (await brief()).p;
  Object.assign(deps, original);
  clearMemory();
});

/** Incidents as far as the weather can't change them: the UPWIND chips need a wind. */
const windless = (i: PayloadV1["incidents"]) => ({ ...i, rows: i.rows?.map(({ kind, sev, line2 }) => ({ kind, sev, line2 })) });

/** What each source's failure must (and must not) change, against the healthy baseline. */
const EFFECTS: Record<SourceKey, (p: PayloadV1, html: string) => void> = {
  events: (p, html) => {
    expect(p.ok).toBe(true);
    expect(p.house).toEqual({ status: "unknown" });
    expect(p.incidents.ok).toBe(false);
    expect(p.incidents.counts).toBeUndefined();
    expect(p.incidents.rows).toBeUndefined();
    expect(p.incidents.empty_text).toBeUndefined();
    expect(p.incidents.error_text).toMatch(/could not be read/);
    expect(p.feed_received_local).toBe("unknown");
    // The rating is never hidden: OSOM and CFA still give today's.
    expect(p.days[0].fdr).toEqual(baseline.days[0].fdr);
    expect(html).not.toMatch(ZERO_CLAIM);
    expect(text(html)).not.toMatch(ZERO_CLAIM);
    expect(html).toContain("UNAVAILABLE");
    expect(html).not.toContain("fw-count");
    expect(text(html)).toContain("INCIDENTS & WARNINGS UNAVAILABLE");
    expect(band(html)).toContain("WARNINGS UNAVAILABLE");
    expect(band(html)).toContain("MODERATE");
  },
  osom: (p) => {
    expect(p.incidents).toEqual(baseline.incidents);
    expect(p.days[0].fdr.word).toBe("MODERATE");
    expect(p.days.map((d) => d.wx)).toEqual(baseline.days.map((d) => d.wx));
  },
  cfa: (p) => {
    expect(p.incidents).toEqual(baseline.incidents);
    expect(p.days[0].fdr.word).toBe("MODERATE");
    expect(p.days.map((d) => d.wx)).toEqual(baseline.days.map((d) => d.wx));
  },
  bom_fdr: (p) => {
    expect(p.incidents).toEqual(baseline.incidents);
    expect(p.days[0].fdr.word).toBe("MODERATE");
    expect(p.days.map((d) => d.fdr.issued).join(" ")).not.toMatch(/FBI|BoM/);
    expect(p.days.map((d) => d.wx)).toEqual(baseline.days.map((d) => d.wx));
  },
  bom_fw: (p) => {
    expect(p.incidents).toEqual(baseline.incidents);
    expect(p.days[0].fdr).toEqual(baseline.days[0].fdr);
    expect(p.days.every((d) => d.wx.ok)).toBe(true);
    expect(p.days.map((d) => d.wx.src).join(" ")).not.toContain("BoM");
  },
  weather: (p, html) => {
    // No wind, no UPWIND claim; everything else about the incidents is untouched.
    expect(windless(p.incidents)).toEqual(windless(baseline.incidents));
    expect(p.incidents.rows!.every((r) => !r.upwind)).toBe(true);
    expect(p.days.map((d) => d.fdr)).toEqual(baseline.days.map((d) => d.fdr));
    expect(p.days.map((d) => d.wx.ok)).toEqual([false, false]);
    expect(p.days.map((d) => d.wx.temps)).toEqual([undefined, undefined]);
    expect(html.match(/Forecast unavailable/g)).toHaveLength(2);
    expect(text(html)).not.toMatch(/\b0°|\b0%/);
  },
  vicmap: (p, html) => {
    // Auto district and no answer: never guessed, so the ratings can't be picked.
    expect(p.incidents).toEqual(baseline.incidents);
    expect(p.district).toBe("District unknown");
    expect(p.neighbours).toBe("");
    expect(p.days[0].fdr).toMatchObject({ level: -1, word: "RATING UNAVAILABLE" });
    expect(p.days[0].tfb.state).toBe("unknown");
    expect(band(html)).toContain("RATING UNAVAILABLE");
    expect(band(html)).toContain("DISTRICT UNKNOWN");
  },
};

for (const src of SOURCE_KEYS) {
  describe(`fault matrix: ${src}`, () => {
    for (const [name, fault] of Object.entries(FAULTS)) {
      it(`${name} → 200, ${src} unavailable, every other source unaffected`, async () => {
        use(upstream(T_QUIET, { [src]: ((url: string) => fault(src, url)) satisfies Responder }));
        const { body, p } = await brief();
        const states = statesFrom(logs);
        expect(states[LOG_ID[src]], `${src} state`).toBe("unavailable");
        for (const other of SOURCE_KEYS) if (other !== src) expect(states[LOG_ID[other]], `${other} state`).toBe("ok");
        expect(up.unknown).toEqual([]);
        expect(bytes(body)).toBeLessThanOrEqual(BUDGET_BYTES);
        expect(budgetViolations(p)).toEqual([]);
        const html = render(p);
        expect(html).not.toMatch(RENDER_ERROR);
        expect(html).toContain("State of Victoria");
        EFFECTS[src](p, html);
      });
    }
  });
}

describe("fault matrix: a district picked in the settings survives a Vicmap outage", () => {
  it("keeps Central's rating when Vicmap is down", async () => {
    use(upstream(T_QUIET, { vicmap: () => new Response("", { status: 503 }) }));
    const { p } = await brief(LIVE("-37.73,145.22", "central"));
    expect(p.district).toBe("Central");
    expect(p.days[0].fdr).toEqual(baseline.days[0].fdr);
  });
});

describe("fault matrix: a cached copy of the wrong shape", () => {
  it("costs only its own source: an old-shaped events record in KV leaves the ratings on screen", async () => {
    // What a deploy that changes the normalised model without bumping its key version leaves behind
    // in KV (the Entry wrapper is still v1), with the live feed down so that record is all there is.
    const kv = fakeKv();
    const fresh = T_QUIET - 10_000;
    const old = JSON.stringify({ v: 1, data: { lastUpdated: fresh, items: [] }, fetchedAt: fresh, asOf: fresh, etag: null, lastModified: null });
    kv.data.set(specs({ lat: -37.73, lon: 145.22 }, "").events.key, old);
    kv.data.set("src:events", old); // and under the pre-versioning key
    use(upstream(T_QUIET, { events: () => new Response("Service Unavailable", { status: 503 }) }));
    const { p } = await brief(LIVE(), { ...ENV, FIRE_KV: kv.kv });
    expect(p.ok).toBe(true);
    expect(p.days[0].fdr).toEqual(baseline.days[0].fdr);
    expect(p.incidents.ok).toBe(false);
    expect(p.incidents.counts).toBeUndefined();
    expect(p.house.status).toBe("unknown");
  });
});

describe("hung upstreams", () => {
  it(
    "answers 200 within 7 s when every upstream hangs until its own timeout",
    async () => {
      use(upstream(T_QUIET, Object.fromEntries(SOURCE_KEYS.map((s) => [s, hang]))));
      const t0 = Date.now();
      const { p } = await brief();
      expect(Date.now() - t0).toBeLessThan(7000);
      expect(p.ok).toBe(false);
      expect(p.down_title).toBe("DATA UNAVAILABLE");
      for (const s of SOURCE_KEYS) {
        const line = logs.find((l) => l.src === LOG_ID[s])!;
        expect(line, s).toMatchObject({ state: "unavailable", error: "timeout" });
      }
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------------------------

describe("configuration errors: 200, a titled full screen, and not one upstream call", () => {
  const cases: [string, Record<string, string>, Env, string, string][] = [
    ["a wrong token", { ...LIVE(), "x-brief-token": "wrong-token" }, ENV, "CONFIGURATION ERROR", "auth"],
    ["no token", { "x-home-secret": "-37.73,145.22" }, ENV, "CONFIGURATION ERROR", "auth"],
    ["no BRIEF_TOKEN on the Worker", LIVE(), {}, "CONFIGURATION ERROR", "not_configured"],
    ["a swapped location", LIVE("145.22,-37.73"), ENV, "LOCATION NOT VALID", "location_invalid"],
    ["a missing location", { "x-brief-token": TOKEN }, ENV, "LOCATION NOT SET", "location_missing"],
    ["an empty location", LIVE(""), ENV, "LOCATION NOT SET", "location_missing"],
    ["a Sydney location", LIVE("-33.87,151.21"), ENV, "LOCATION OUTSIDE VIC", "outside_vic"],
    ["a place name for a location", LIVE("North Warrandyte"), ENV, "LOCATION NOT VALID", "location_invalid"],
  ];
  for (const [name, headers, env, title, code] of cases) {
    it(name, async () => {
      const kv = fakeKv();
      const { res, body, p } = await brief(headers, { ...env, FIRE_KV: kv.kv });
      expect(p.ok).toBe(false);
      expect(p.down_title).toBe(title);
      expect(res.headers.get("x-brief-error")).toBe(code);
      expect(up.calls).toHaveLength(0);
      expect(kv.gets).toHaveLength(0);
      expect(kv.puts).toHaveLength(0);
      for (const s of ["37.73", "145.22", "33.87", "151.21", "wrong-token"]) expect(body).not.toContain(s);
      const html = render(p);
      const t = text(html);
      expect(t).toContain(title);
      expect(t).not.toMatch(RATING_WORDS);
      expect(t).not.toMatch(ZERO_CLAIM);
      expect(t).toContain("1800 226 226");
      expect(html).not.toContain("fw-count");
    });
  }

  it("takes ?lat=&lon= only when ALLOW_QUERY_LOCATION is '1'", async () => {
    for (const env of [ENV, { ...ENV, ALLOW_QUERY_LOCATION: "0" }, { ...ENV, ALLOW_QUERY_LOCATION: "true" }]) {
      const { p } = await brief({ "x-brief-token": TOKEN }, env, "?lat=-37.73&lon=145.22");
      expect(p.down_title).toBe("LOCATION NOT SET");
    }
    expect(up.calls).toHaveLength(0);

    const { p } = await brief({ "x-brief-token": TOKEN }, { ...ENV, ALLOW_QUERY_LOCATION: "1" }, "?lat=-37.73&lon=145.22");
    expect(p.ok).toBe(true);
    expect(p.district).toBe("Central");
    expect(up.calls.length).toBeGreaterThan(0);

    const sydney = await brief({ "x-brief-token": TOKEN }, { ...ENV, ALLOW_QUERY_LOCATION: "1" }, "?lat=-33.87&lon=151.21");
    expect(sydney.p.down_title).toBe("LOCATION OUTSIDE VIC");
  });

  it("prefers the header to the query string even in dev", async () => {
    const { p } = await brief(LIVE("-33.87,151.21"), { ...ENV, ALLOW_QUERY_LOCATION: "1" }, "?lat=-37.73&lon=145.22");
    expect(p.down_title).toBe("LOCATION OUTSIDE VIC");
    expect(up.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("privacy: a house at 4 dp (-37.8446, 144.9723, Albert Park Lake)", () => {
  it("sends at most 3 dp upstream (Open-Meteo 2 dp) and keeps the location out of logs, payload and KV", async () => {
    const kv = fakeKv();
    const { body, p } = await brief(LIVE("-37.8446,144.9723"), { ...ENV, FIRE_KV: kv.kv });
    expect(p.ok).toBe(true);
    expect(p.district).toBe("Central");
    expect(up.unknown).toEqual([]);

    for (const { url } of up.calls) {
      const u = decodeURIComponent(url);
      expect(u).not.toMatch(/37\.8446|144\.9723/);
      for (const m of u.matchAll(/-?\d+\.(\d+)/g)) {
        const v = Math.abs(Number(m[0]));
        if (Math.abs(v - 37.8446) < 0.05 || Math.abs(v - 144.9723) < 0.05) expect(m[1]!.length, u).toBeLessThanOrEqual(3);
      }
    }
    const om = up.calls.filter((c) => sourceOf(c.url) === "weather");
    expect(om).toHaveLength(1);
    const q = new URL(om[0]!.url).searchParams;
    expect(q.get("latitude")).toBe("-37.84");
    expect(q.get("longitude")).toBe("144.97");
    const vm = up.calls.filter((c) => sourceOf(c.url) === "vicmap");
    expect(vm).toHaveLength(3);
    for (const c of vm) expect(decodeURIComponent(c.url)).toContain("POINT(144.972 -37.845)");

    // Not at any precision, in anything kept or shown.
    const logText = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(5);
    for (const s of ["37.84", "144.97"]) {
      expect(logText).not.toContain(s);
      expect(body).not.toContain(s);
    }
    expect(logText).not.toMatch(/https?:|latitude|longitude|POINT|secret/i);
    expect(kv.data.size).toBeGreaterThan(0);
    for (const [key, value] of kv.data) {
      expect(key).not.toMatch(/\d\.\d|37\.7|145\.2/);
      expect(value).not.toMatch(/37\.731|145\.223/);
      expect(value).not.toMatch(EMAIL);
    }
    expect(body).not.toMatch(EMAIL);
    expect(logText).not.toMatch(EMAIL);
  });
});

// ---------------------------------------------------------------------------------------------

describe("other routes", () => {
  it("/health answers without a token and calls no upstream", async () => {
    const { res, body } = await call("/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ ok: true, version: VERSION });
    expect(up.calls).toHaveLength(0);
  });

  it("/v1/sources needs the token", async () => {
    for (const headers of [{}, { "x-brief-token": "wrong" }] as Record<string, string>[]) {
      const { res, body } = await call("/v1/sources", { headers });
      expect(res.status).toBe(401);
      expect(JSON.parse(body)).toEqual({ error: "auth" });
    }
    const { res } = await call("/v1/sources", { headers: { "x-brief-token": TOKEN }, env: {} });
    expect(res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("/v1/sources probes Melbourne CBD, never the house", async () => {
    const { res, body } = await call("/v1/sources", { headers: { ...LIVE("-37.8446,144.9723") } });
    expect(res.status).toBe(200);
    const r = JSON.parse(body) as { version: string; kv: string; sources: { id: string; http: number }[] };
    expect(r.version).toBe(VERSION);
    expect(r.kv).toBe("unbound");
    expect(r.sources.map((s) => s.id).sort()).toEqual(["bom_fdr", "bom_fw", "cfa", "district", "events", "osom", "weather"]);
    expect(r.sources.every((s) => s.http === 200)).toBe(true);
    for (const { url } of up.calls) expect(decodeURIComponent(url)).not.toMatch(/37\.73|145\.22/);
    const om = up.calls.find((c) => sourceOf(c.url) === "weather")!;
    expect(new URL(om.url).searchParams.get("latitude")).toBe("-37.81");
    expect(body).not.toMatch(/37\.73|145\.22/);
  });

  it("/preview is 404 unless DEV is '1'", async () => {
    for (const env of [ENV, { ...ENV, DEV: "0" }, { ...ENV, DEV: "true" }]) {
      const { res } = await call("/preview", { env });
      expect(res.status).toBe(404);
    }
    const { res, body } = await call("/preview", { env: { ...ENV, DEV: "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    for (const name of ["quiet", "busy-warrandyte", "catastrophic", "horsham-inside", "outage"]) expect(body).toContain(name);
    expect(up.calls).toHaveLength(0);
  });

  it("answers any method but GET with 405", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const path of ["/v1/brief.json", "/health", "/v1/sources"]) {
        const { res } = await call(path, { method, headers: LIVE() });
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
      }
    }
    expect(up.calls).toHaveLength(0);
  });

  it("404s anything else", async () => {
    const { res } = await call("/v1/brief", { headers: LIVE() });
    expect(res.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });
});
