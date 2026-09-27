/**
 * Bushfire Watch: the Worker a TRMNL Private Plugin polls. Routes:
 *   GET /v1/brief.json  the merge variables (always HTTP 200: TRMNL stops refreshing a plugin whose
 *                       polls keep failing, and the device would then show an old screen forever)
 *   GET /v1/sources     per-upstream reachability from wherever the Worker actually runs
 *   GET /health         liveness, no upstream calls
 *   GET /preview        DEV only: the template rendered over every fixture scenario
 */
import template from "../plugin/src/full.liquid";
import { type Env, FIXTURE_HOME, parseRequest, tokenMatches } from "./config.js";
import { fixtureFetch, SCENARIOS } from "./fixtures.js";
import { gather } from "./gather.js";
import { buildPayload, downPayload } from "./payload.js";
import { previewHtml } from "./preview.js";
import { specs } from "./sources/specs.js";
import { districtUrl } from "./sources/vicmap.js";
import { fetchText } from "./store.js";
import type { Deps, Home, PayloadV1 } from "./types.js";

/** Not exported: the Workers runtime treats every named export of the entry module as an entrypoint. */
const VERSION = "0.1.0";

/** Injection point for tests. */
export const deps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  kv: null,
  log: (o) => console.log(JSON.stringify(o)),
};

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

const CONFIG_TITLE: Record<string, string> = {
  auth: "CONFIGURATION ERROR",
  not_configured: "CONFIGURATION ERROR",
  location_missing: "LOCATION NOT SET",
  location_invalid: "LOCATION NOT VALID",
  outside_vic: "LOCATION OUTSIDE VIC",
};

async function brief(req: Request, env: Env, ctx: ExecutionContext, d: Deps): Promise<Response> {
  const t0 = Date.now();
  const cfg = await parseRequest(req, env);
  if (!cfg.ok) {
    d.log({ route: "brief", config: cfg.error });
    return json(downPayload(d.now(), { title: CONFIG_TITLE[cfg.error] ?? "CONFIGURATION ERROR", reason: cfg.message }), 200, { "x-brief-error": cfg.error });
  }

  let payload: PayloadV1;
  if (cfg.fixture) {
    // Own keys only: "constructor" and friends are names too.
    const make = Object.hasOwn(SCENARIOS, cfg.fixture) ? SCENARIOS[cfg.fixture] : undefined;
    if (!make) return json(downPayload(d.now(), { title: "CONFIGURATION ERROR", reason: `Unknown fixture "${cfg.fixture}".`, sample: true }), 200, { "x-brief-error": "fixture" });
    const s = make();
    const fx: Deps = { fetch: fixtureFetch(s), now: () => s.now, kv: null, log: () => {} };
    const g = await gather({ home: s.home, district: s.district.lookup.key, radiusKm: cfg.radiusKm }, fx, { prefix: `fx:${s.name}:`, district: s.district });
    payload = buildPayload(g, { sample: true });
  } else {
    const g = await gather(cfg, d, { waitUntil: (p) => ctx.waitUntil(p) });
    payload = buildPayload(g);
    d.log({
      route: "brief",
      ms: Date.now() - t0,
      ok: payload.ok,
      district: g.district.source,
      states: { events: g.events.state, osom: g.osom.state, cfa: g.cfa.state, bom_fdr: g.bomFdr.state, bom_fw: g.bomFw.state, weather: g.weather.state },
    });
  }
  return json(payload);
}

/** Melbourne CBD: the probe point, never the house. */
const PROBE: Home = { lat: -37.814, lon: 144.963 };

async function sources(req: Request, env: Env, d: Deps): Promise<Response> {
  if (!(await tokenMatches(req.headers.get("x-brief-token"), env.BRIEF_TOKEN))) return json({ error: "auth" }, 401);
  const s = specs(PROBE, "probe");
  const targets = [
    s.events,
    s.osom,
    s.cfa,
    s.bomFdr,
    s.bomFw,
    s.weather,
    { id: "district", url: districtUrl(PROBE), validator: "none" as const, accept: "application/json" },
  ];
  const report = await Promise.all(
    targets.map(async (t) => {
      const t0 = Date.now();
      const first = await fetchText(t.url, d, { timeoutMs: 6000, headers: t.accept ? { Accept: t.accept } : {} });
      const ms = Date.now() - t0;
      let revalidate: number | null = null;
      const etag = first.res?.headers.get("etag");
      const lm = first.res?.headers.get("last-modified");
      const cond: Record<string, string> | null =
        t.validator === "etag" && etag ? { "If-None-Match": etag } : t.validator === "last-modified" && lm ? { "If-Modified-Since": lm } : null;
      if (cond) revalidate = (await fetchText(t.url, d, { timeoutMs: 6000, headers: cond })).status;
      return { id: t.id, http: first.status, ms, bytes: first.body?.length ?? null, revalidate, error: first.error };
    }),
  );
  let kv: string = "unbound";
  if (d.kv) {
    try {
      await d.kv.put("health:probe", String(d.now()), { expirationTtl: 60 });
      kv = (await d.kv.get("health:probe")) ? "ok" : "write not visible";
    } catch {
      kv = "error";
    }
  }
  const cf = (req as { cf?: { colo?: string } }).cf;
  return json({ version: VERSION, placement: req.headers.get("cf-placement"), colo: cf?.colo ?? null, kv, sources: report });
}

async function preview(req: Request, env: Env, d: Deps): Promise<Response> {
  const url = new URL(req.url);
  const cases: { name: string; payload: unknown }[] = [];
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const s = make();
    const fx: Deps = { fetch: fixtureFetch(s), now: () => s.now, kv: null, log: () => {} };
    const g = await gather({ home: s.home, district: s.district.lookup.key, radiusKm: 30 }, fx, { prefix: `fx:${s.name}:`, district: s.district });
    const p = buildPayload(g, { sample: true });
    // Rendered "now", so the template's out-of-date check doesn't fire on the frozen fixture clock.
    cases.push({ name, payload: { ...p, generated_epoch: Math.floor(Date.now() / 1000) } });
  }
  if (url.searchParams.has("live")) {
    const home = { ...FIXTURE_HOME };
    const g = await gather({ home, district: null, radiusKm: 30 }, d, {});
    cases.unshift({ name: "live (suburb test point)", payload: buildPayload(g) });
  }
  const bits = url.searchParams.get("bits") === "2" ? 2 : 1;
  return new Response(previewHtml(template, cases, { bits }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function route(req: Request, env: Env, ctx: ExecutionContext, d: Deps): Promise<Response> {
  const path = new URL(req.url).pathname;
  try {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET" });
    if (path === "/v1/brief.json") return await brief(req, env, ctx, d);
    if (path === "/health") return json({ ok: true, version: VERSION, schema: 1 });
    if (path === "/v1/sources") return await sources(req, env, d);
    if (path === "/preview" && env.DEV === "1") return await preview(req, env, d);
    return json({ error: "not found" }, 404);
  } catch {
    try {
      d.log({ route: path, error: "internal" });
    } catch {
      /* nothing more to do */
    }
    if (path === "/v1/brief.json") return json(downPayload(Date.now(), { title: "DATA UNAVAILABLE", reason: "The Worker hit an internal error." }));
    return json({ error: "internal" }, 500);
  }
}

export default {
  fetch: (req, env, ctx) => route(req, env, ctx, { ...deps, kv: env.FIRE_KV ?? null }),
} satisfies ExportedHandler<Env>;

