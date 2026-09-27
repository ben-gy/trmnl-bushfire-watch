/**
 * buildPayload over gather(), with injected deps: a fake upstream serving the scrubbed snapshots by
 * URL, a frozen clock and, where the case needs one, an in-memory KV. Covers the plan's must-pass
 * cases that span fetching, caching and judgement: staleness and last-good copies (9), the
 * statewide/Catastrophic band (2), per-minute freshness, and the budget under a 2,000-feature feed
 * (11). Each built payload is also rendered through the real template.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fixtureFetch, SCENARIOS } from "../src/fixtures.js";
import { type DistrictResult, gather } from "../src/gather.js";
import { BUDGET_BYTES as PAYLOAD_BUDGET, buildPayload } from "../src/payload.js";
import { specs } from "../src/sources/specs.js";
import { clearMemory } from "../src/store.js";
import type { DistrictKey, Home } from "../src/types.js";
import {
  at,
  band,
  baseFeatures,
  BUDGET_BYTES,
  budgetViolations,
  bytes,
  eventsBody,
  fakeKv,
  FX,
  HOUR,
  type LogLine,
  MIN,
  ok,
  render,
  RENDER_ERROR,
  type Responder,
  type SourceKey,
  square,
  statesFrom,
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

async function build(
  o: {
    now?: number;
    over?: Partial<Record<SourceKey, Responder>>;
    bodies?: Partial<Record<SourceKey, string>>;
    kv?: KVNamespace | null;
    home?: Home;
    district?: DistrictKey | null;
  } = {},
) {
  const now = o.now ?? T_QUIET;
  const up = upstream(now, o.over, o.bodies);
  const logs: LogLine[] = [];
  const g = await gather(
    { home: o.home ?? SUBURB, district: o.district ?? null, radiusKm: 30 },
    { fetch: up.fetch, now: () => now, kv: o.kv ?? null, log: (l) => logs.push(l) },
  );
  const p = buildPayload(g);
  expect(up.unknown).toEqual([]);
  expect(budgetViolations(p)).toEqual([]);
  expect(bytes(p)).toBeLessThanOrEqual(BUDGET_BYTES);
  const html = render(p);
  expect(html).not.toMatch(RENDER_ERROR);
  return { g, p, html, up, logs };
}

/** A Watch and Act whose polygon covers the suburb point, as VicEmergency publishes one. */
function houseWarning(t: number, level = "Watch and Act", action = "Prepare to leave") {
  return {
    type: "Feature",
    properties: {
      feedType: "warning",
      sourceOrg: "EMV",
      sourceFeed: "cop-cap",
      id: "T-HOUSE-1",
      category1: level,
      category2: "Fire",
      status: "Moderate",
      action,
      statewide: "N",
      location: "North Warrandyte, Warrandyte, Wonga Park, Park Orchards",
      cap: { event: "Bushfire" },
      created: iso(t - 40 * MIN),
      updated: iso(t - 10 * MIN),
    },
    geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: at(SUBURB, 8, 8) }, square(SUBURB, 0, 0, 3)] },
  };
}

const down503: Responder = () => new Response("Service Unavailable", { status: 503, headers: { "content-type": "text/html" } });

// ---------------------------------------------------------------------------------------------

describe("staleness is measured by the feed's own clock", () => {
  it("a feed fetched fine but last updated 50 min ago is unavailable: no counts, no all-clear", async () => {
    const { g, p, html, logs } = await build({ bodies: { events: eventsBody({ lastUpdated: T_QUIET - 50 * MIN }) } });
    expect(g.events).toMatchObject({ state: "unavailable", error: null });
    expect(g.events.data).not.toBeNull();
    expect(statesFrom(logs)).toMatchObject({ events: "unavailable", osom: "ok", cfa: "ok", weather: "ok", district: "ok" });
    expect(p.ok).toBe(true);
    expect(p.house).toEqual({ status: "unknown" });
    expect(p.incidents.ok).toBe(false);
    expect(p.incidents.counts).toBeUndefined();
    expect(p.incidents.rows).toBeUndefined();
    expect(p.incidents.empty_text).toBeUndefined();
    expect(p.incidents.error_text).toBe("The VicEmergency feed could not be read since Sun 16:10.");
    // The licence's "last received" time is the feed's own, not ours.
    expect(p.feed_received_local).toBe("Sun 16:10");
    expect(p.days[0].fdr.word).toBe("MODERATE");

    const t = text(html);
    expect(t).not.toMatch(ZERO_CLAIM);
    expect(html).not.toContain("fw-count");
    expect(t).toContain("INCIDENTS & WARNINGS UNAVAILABLE");
    expect(band(html)).toContain("WARNINGS UNAVAILABLE");
    expect(t).toContain("VicEmergency data received Sun 16:10");
  });

  it("falls back to Last-Modified when the feed carries no lastUpdated", async () => {
    const { g, p } = await build({
      over: { events: () => ok(eventsBody({ lastUpdated: null }), { "last-modified": new Date(T_QUIET - 50 * MIN).toUTCString() }) },
    });
    expect(g.events.state).toBe("unavailable");
    expect(p.incidents.ok).toBe(false);
    expect(p.incidents.counts).toBeUndefined();
  });

  it("a 20 min old feed keeps its counts under an OLD DATA chip, but never says nothing is around", async () => {
    const stale = await build({ bodies: { events: eventsBody({ lastUpdated: T_QUIET - 20 * MIN }) } });
    expect(stale.g.events.state).toBe("stale");
    expect(stale.p.incidents).toMatchObject({ ok: true, stale: true, as_at: "OLD DATA · 16:40" });
    expect(stale.html).toContain('label--filled" data-clamp="1">OLD DATA · 16:40</span>');

    clearMemory();
    const empty = await build({ bodies: { events: eventsBody({ lastUpdated: T_QUIET - 20 * MIN, features: [] }) } });
    expect(empty.p.incidents).toMatchObject({ ok: true, stale: true, rows: [] });
    expect(empty.p.incidents.empty_text).toBeUndefined();
    expect(text(empty.html)).toContain("Old data. Check the VicEmergency app");
    expect(text(empty.html)).not.toMatch(/No warnings, fires or burns/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("last-good copies in KV: alarms survive a failed fetch, all-clears do not", () => {
  /** Poll once `age` before T_QUIET with this feed, then again at T_QUIET from a fresh isolate with the feed down. */
  async function lastGoodThenDown(features: unknown[], age: number, over: Partial<Record<SourceKey, Responder>> = {}) {
    const kv = fakeKv();
    const t1 = T_QUIET - age;
    const first = await build({ now: t1, kv: kv.kv, bodies: { events: eventsBody({ lastUpdated: t1, features }) } });
    expect(first.g.events.state).toBe("ok");
    // The key is versioned by the model (store contract): ask the spec rather than spell it.
    expect(kv.data.has(specs(SUBURB, "").events.key)).toBe(true);
    clearMemory(); // a new isolate: only KV remembers
    const second = await build({ now: T_QUIET, kv: kv.kv, over: { events: down503, ...over } });
    expect(second.g.events).toMatchObject({ state: "unavailable", error: "http 503", asOf: t1 });
    expect(second.g.events.data).not.toBeNull();
    return { first, second };
  }

  it("a 2 h old copy with a warning over the house shows it as LAST KNOWN, with incidents unavailable", async () => {
    const { first, second } = await lastGoodThenDown([...baseFeatures(), houseWarning(T_QUIET - 2 * HOUR)], 2 * HOUR);
    expect(first.p.house).toMatchObject({ status: "in_warning", level: "WATCH AND ACT", issued: "Issued 14:50" });

    const { p, html } = second;
    expect(p.ok).toBe(true);
    expect(p.house).toMatchObject({ status: "in_warning", rank: 2, level: "WATCH AND ACT", issued: "LAST KNOWN 15:00" });
    expect(p.house.action).toMatch(/^PREPARE TO LEAVE/);
    expect(p.incidents.ok).toBe(false);
    expect(p.incidents.counts).toBeUndefined();
    expect(p.incidents.rows).toBeUndefined();
    expect(p.incidents.error_text).toBe("The VicEmergency feed could not be read since Sun 15:00.");

    const b = band(html);
    expect(b).toContain("WATCH AND ACT");
    expect(b).toContain("LAST KNOWN 15:00");
    expect(b).toContain("Today: MODERATE");
    const t = text(html);
    expect(t).toContain("INCIDENTS & WARNINGS UNAVAILABLE");
    expect(t).not.toMatch(ZERO_CLAIM);
    expect(html).not.toContain("fw-count");
  });

  it("keeps that LAST KNOWN warning on screen when every other source is down too", async () => {
    const all503 = { osom: down503, cfa: down503, bom_fdr: down503, bom_fw: down503, weather: down503, vicmap: down503 };
    const { second } = await lastGoodThenDown([houseWarning(T_QUIET - 2 * HOUR)], 2 * HOUR, all503);
    expect(second.p.ok).toBe(true);
    expect(second.p.house).toMatchObject({ status: "in_warning", issued: "LAST KNOWN 15:00" });
    expect(band(second.html)).toContain("WATCH AND ACT");
  });

  it("drops a warning copy older than 6 h: warnings unavailable, never clear", async () => {
    const { second } = await lastGoodThenDown([houseWarning(T_QUIET - 7 * HOUR)], 7 * HOUR);
    expect(second.p.house).toEqual({ status: "unknown" });
    expect(second.p.incidents.ok).toBe(false);
    expect(band(second.html)).toContain("WARNINGS UNAVAILABLE");
    expect(band(second.html)).not.toContain("WATCH AND ACT");
  });

  it("a 2 h old copy with no fires or warnings shows no counts: UNAVAILABLE, never 0", async () => {
    const { first, second } = await lastGoodThenDown([], 2 * HOUR);
    // Fresh, the same feed is an honest set of zeros.
    expect(first.p.incidents.counts!.map((c) => c.n)).toEqual(["0", "0", "0", "0", "0"]);
    expect(first.p.house.status).toBe("clear");

    const { p, html } = second;
    expect(p.house).toEqual({ status: "unknown" });
    expect(p.incidents.ok).toBe(false);
    expect(p.incidents.counts).toBeUndefined();
    expect(p.incidents.empty_text).toBeUndefined();
    const t = text(html);
    expect(html).not.toMatch(ZERO_CLAIM);
    expect(t).not.toMatch(ZERO_CLAIM);
    expect(t).not.toMatch(/No warnings, fires or burns/);
    expect(html).toContain("UNAVAILABLE");
    expect(band(html)).toContain("WARNINGS UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------------------------

describe("last-good ratings: a stale alarm may stay, labelled, for up to 6 h; a stale all-clear may not", () => {
  /** osom-fdrtfb.json with Central's 27 Sep rating and TFB replaced. */
  function osomWith(fdr: string, tfb: string): string {
    const j = JSON.parse(FX.osom) as { results: { issueFor: string; issueAt?: string; declareList: { name: string; status: string }[] }[] };
    for (const r of j.results) {
      if (r.issueFor !== "27/09/2026") continue;
      for (const d of r.declareList) if (d.name === "Central") d.status = "issueAt" in r ? fdr : tfb;
    }
    return JSON.stringify(j);
  }

  /** A good poll `age` ago, then every rating source (and the events feed's conditions) down, from a fresh isolate. */
  async function ratingsThenDown(fdr: string, tfb: string, age: number) {
    const kv = fakeKv();
    const first = await build({ now: T_QUIET - age, kv: kv.kv, district: "central", bodies: { osom: osomWith(fdr, tfb) } });
    clearMemory();
    const second = await build({ now: T_QUIET, kv: kv.kv, district: "central", over: { osom: down503, cfa: down503, bom_fdr: down503, events: down503 } });
    expect(second.g.osom.state).not.toBe("ok");
    return { first, second };
  }

  it("keeps a 2 h old EXTREME and Total Fire Ban", async () => {
    const { first, second } = await ratingsThenDown("EXTREME", "YES - TOTAL FIRE BAN IN FORCE", 2 * HOUR);
    expect(first.p.days[0].fdr.word).toBe("EXTREME");
    expect(second.p.days[0].fdr).toMatchObject({ level: 3, word: "EXTREME" });
    expect(second.p.days[0].tfb.state).toBe("declared");
    expect(band(second.html)).toContain("EXTREME");
  });

  it("labels that 2 h old EXTREME as LAST KNOWN", async () => {
    const { second } = await ratingsThenDown("EXTREME", "YES - TOTAL FIRE BAN IN FORCE", 2 * HOUR);
    // Plan, safety semantics: stale alarms (TFB YES, Extreme or above) show as "LAST KNOWN hh:mm".
    expect(text(second.html)).toMatch(/LAST KNOWN \d{1,2}:\d{2}|\bas of \d{1,2}:\d{2}/i);
  });

  it("drops an EXTREME copied more than 6 h ago", async () => {
    const { second } = await ratingsThenDown("EXTREME", "YES - TOTAL FIRE BAN IN FORCE", 8 * HOUR);
    expect(second.p.days[0].fdr).toMatchObject({ level: -1, word: "RATING UNAVAILABLE" });
  });

  it("never shows a 2 h old MODERATE or 'no TFB' as current", async () => {
    const { first, second } = await ratingsThenDown("MODERATE", "NO - RESTRICTIONS MAY APPLY", 2 * HOUR);
    expect(first.p.days[0].fdr.word).toBe("MODERATE");
    expect(second.p.days[0].fdr).toMatchObject({ level: -1, word: "RATING UNAVAILABLE" });
    expect(second.p.days[0].tfb).toEqual({ state: "unknown", text: "TFB status unavailable" });
    expect(text(second.html)).not.toMatch(/\bMODERATE\b|No TFB/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("statewide warnings and a Catastrophic rating (9 Jan 2026)", () => {
  it("Bendigo: the band shows CATASTROPHIC, not the statewide Advice trio, which stays on its own line", async () => {
    const s = SCENARIOS.catastrophic!();
    const BENDIGO: Home = { lat: -36.757, lon: 144.279 };
    const district: DistrictResult = { lookup: { key: "north_central", lga: "greater_bendigo", neighbours: [] }, state: "ok", source: "vicmap" };
    const g = await gather(
      { home: BENDIGO, district: "north_central", radiusKm: 30 },
      { fetch: fixtureFetch({ ...s, home: BENDIGO, district }), now: () => s.now, kv: null, log: () => {} },
      { district, prefix: "t:" },
    );
    const p = buildPayload(g);
    expect(p.house.status).toBe("clear");
    expect(p.days[0].fdr).toMatchObject({ level: 4, word: "CATASTROPHIC" });
    expect(p.days[0].tfb.state).toBe("declared");
    expect(p.statewide).toMatch(/^Statewide: .*\(Advice\)/);
    expect(budgetViolations(p)).toEqual([]);

    const html = render(p);
    const b = band(html);
    expect(b).toMatch(/fw-band fw-f4 p--1[\s\S]*inverse px--2 py--1/);
    expect(b).toContain("CATASTROPHIC");
    expect(b).toContain("For your survival, leave bushfire risk areas");
    expect(b).not.toMatch(/ADVICE|STATEWIDE/);
    expect(html).toContain(p.statewide);
  });
});

// ---------------------------------------------------------------------------------------------

describe("freshness", () => {
  it("is byte-identical within a minute and changes every minute, so TRMNL re-renders every poll", async () => {
    const a = await build({ now: T_QUIET + 10_000 });
    const b = await build({ now: T_QUIET + 50_000 });
    expect(JSON.stringify(b.p)).toBe(JSON.stringify(a.p));
    const c = await build({ now: T_QUIET + 70_000 });
    expect(c.p.generated_epoch).toBe(a.p.generated_epoch + 60);
    expect(c.p.checked_local).toBe("Sun 17:01");
    expect(c.html).toContain("Checked Sun 17:01");
  });
});

// ---------------------------------------------------------------------------------------------

describe("budget: a synthetic 2,000-feature feed around the suburb", () => {
  const PLACES = "Kangaroo Ground, Panton Hill, St Andrews, Smiths Gully, Watsons Creek, Christmas Hills, Yarra Glen and Wonga Park";

  /** Deterministic: warnings with polygons, fires of every status and agency, burns, other calls, unclassified. */
  function synth(n: number): unknown[] {
    let seed = 20260109;
    const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const out: unknown[] = [];
    const WARN: [string, string][] = [
      ["Emergency Warning", "Leave immediately"],
      ["Watch and Act", "Prepare to leave"],
      ["Advice", "Stay informed"],
      ["Community Update", "Monitor conditions"],
    ];
    const FIRE_STATUS = ["Going", "Not Yet Under Control", "Under Control", "Safe", "Responding", "Being Controlled", "Escalating", ""];
    const FIRE_C2 = ["Bushfire", "Grass Fire", "Structure Fire", "Car Fire", "Other", "Scrub Fire"];
    const AGENCY: [string, string][] = [
      ["VIC/CFA", "cfa-incident"],
      ["VIC/DEECA", "deeca-incident"],
      ["VIC/ESTA", "mfb-incident"],
    ];
    const OTHER: [string, string, string][] = [
      ["Tree Down", "VIC/SES", "ses-incident"],
      ["Rescue", "VIC/CFA", "cfa-incident"],
      ["Other", "VIC/CFA", "cfa-incident"],
      ["Flooding", "VIC/SES", "ses-incident"],
    ];
    for (let i = 0; i < n; i++) {
      const north = (r() * 2 - 1) * 45;
      const east = (r() * 2 - 1) * 45;
      const c = at(SUBURB, north, east);
      const common = { id: `SYN${i}`, created: iso(T_QUIET - r() * 6 * HOUR), updated: iso(T_QUIET - r() * HOUR), location: `${i} Long Road, ${PLACES}` };
      const k = i % 20;
      if (k === 0) {
        const [category1, action] = WARN[Math.floor(i / 20) % 4]!;
        // Never over the house: the in-area case adds its own.
        const [wn, we] = Math.hypot(north, east) < 6 ? [north + 8, east + 8] : [north, east];
        out.push({
          type: "Feature",
          properties: { ...common, feedType: "warning", sourceOrg: "EMV", sourceFeed: "cop-cap", category1, category2: "Fire", action, statewide: "N", status: "Moderate", cap: { event: "Bushfire" } },
          geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: at(SUBURB, wn, we) }, square(SUBURB, wn, we, 0.5 + r() * 2)] },
        });
      } else if (k < 12) {
        const [sourceOrg, sourceFeed] = AGENCY[i % 3]!;
        out.push({
          type: "Feature",
          properties: { ...common, feedType: "incident", sourceOrg, sourceFeed, category1: "Fire", category2: FIRE_C2[i % FIRE_C2.length], status: FIRE_STATUS[i % FIRE_STATUS.length] },
          geometry: { type: "Point", coordinates: c },
        });
      } else if (k < 15) {
        out.push({
          type: "Feature",
          properties: { ...common, feedType: "incident", sourceOrg: "VIC/DEECA", sourceFeed: "deeca-burns", category1: "Planned Burn", category2: "Planned Burn", status: "Under Control" },
          geometry: { type: "Point", coordinates: c },
        });
      } else if (k < 19) {
        const [cat, sourceOrg, sourceFeed] = OTHER[i % 4]!;
        out.push({ type: "Feature", properties: { ...common, feedType: "incident", sourceOrg, sourceFeed, category1: cat, category2: cat, status: "Responding" }, geometry: { type: "Point", coordinates: c } });
      } else {
        out.push({ type: "Feature", properties: { ...common, feedType: "hazard", category1: "Unknown", category2: "Unknown" }, geometry: { type: "Point", coordinates: c } });
      }
    }
    return out;
  }

  it("stays within 6 KB and every string budget, with 5 rows, +N more and the house warning first", async () => {
    // An Advice over the house: lower than the nearby Emergency Warnings, still listed first.
    const features = [...synth(2000), houseWarning(T_QUIET, "Advice", "Stay informed")];
    expect(features).toHaveLength(2001);
    const { p, html } = await build({ bodies: { events: eventsBody({ lastUpdated: T_QUIET - MIN, features }) } });
    expect(bytes(p)).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(p.house).toMatchObject({ status: "in_warning", level: "ADVICE" });
    const rows = p.incidents.rows!;
    expect(rows).toHaveLength(5);
    expect(p.incidents.more).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ kind: "warning", sev: 3, line1: "IN AREA · ADVICE" });
    // Then the Watch and Act / Emergency Warning areas nearby, nearest first.
    expect(rows[1]).toMatchObject({ kind: "warning", sev: 3 });
    expect(rows[1]!.line1).toMatch(/ · (EMERGENCY WARNING|WATCH AND ACT)$/);
    expect(p.incidents.as_at).toMatch(/\+\d+ more$/);
    for (const c of p.incidents.counts!) expect(c.n).toMatch(/^(\d{1,2}|99\+)$/);
    expect(html.match(/class="fw-bar /g)).toHaveLength(5);
  });

  it("without a house warning, the most severe nearby warning leads", async () => {
    const { p } = await build({ bodies: { events: eventsBody({ lastUpdated: T_QUIET - MIN, features: synth(2000) }) } });
    expect(bytes(p)).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(p.house.status).toBe("clear");
    expect(p.incidents.rows).toHaveLength(5);
    expect(p.incidents.rows![0]).toMatchObject({ kind: "warning", sev: 3 });
    expect(p.incidents.rows![0]!.line1).toMatch(/^\d+(\.\d)? km [NESW]{1,3} · (EMERGENCY WARNING|WATCH AND ACT)$/);
    expect(p.incidents.more).toBeGreaterThan(0);
  });

  it("over the byte budget, rows go from the bottom, the in-area warning stays, and as_at counts what is hidden", async () => {
    const features = [...synth(2000), houseWarning(T_QUIET, "Advice", "Stay informed")];
    const { g, p } = await build({ bodies: { events: eventsBody({ lastUpdated: T_QUIET - MIN, features }) } });
    expect(PAYLOAD_BUDGET).toBe(BUDGET_BYTES);
    const more = p.incidents.more!;
    const tight = buildPayload(g, { budgetBytes: bytes(p) - 150 });
    const rows = tight.incidents.rows!;
    expect(rows.length).toBeLessThan(5);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.line1).toBe("IN AREA · ADVICE");
    expect(tight.incidents.more).toBe(more + (5 - rows.length));
    expect(tight.incidents.as_at).toContain(`+${tight.incidents.more} more`);
    expect(budgetViolations(tight)).toEqual([]);
    const tiniest = buildPayload(g, { budgetBytes: 100 });
    expect(tiniest.incidents.rows).toHaveLength(1);
    expect(tiniest.incidents.rows![0]!.line1).toBe("IN AREA · ADVICE");
    expect(tiniest.incidents.as_at).toContain(`+${tiniest.incidents.more} more`);
  });

  it("a feed of 3-byte text still fits, and as_at still counts every hidden row", async () => {
    const wide = (x: string) => "火山灰".repeat(Math.ceil(x.length / 3) + 40);
    const features = [...synth(2000), houseWarning(T_QUIET, "Emergency Warning", "Leave immediately")].map((f) => {
      const q = structuredClone(f) as { properties: Record<string, unknown> };
      for (const k of ["location", "action", "category2", "status"]) if (typeof q.properties[k] === "string" && q.properties[k]) q.properties[k] = wide(q.properties[k] as string);
      q.properties.cap = { event: wide("Bushfire") };
      return q;
    });
    const { p } = await build({ bodies: { events: eventsBody({ lastUpdated: T_QUIET - MIN, features }) } });
    expect(bytes(p)).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(p.incidents.more).toBeGreaterThan(0);
    expect(p.incidents.as_at).toContain(`+${p.incidents.more} more`);
  });
});
