/**
 * Fetch and cache for every upstream. Each source is kept as its normalised, PII-free model in isolate
 * memory and KV, revalidated with a conditional GET, and aged by the source's own timestamp — so a
 * frozen feed served fresh from a CDN still goes stale. A failure never becomes a reassuring value:
 * the caller gets the last good copy with its true age, or `unavailable` with no data.
 */
import type { Deps, SourceId, SourceResult, SourceState } from "./types.js";

/** CFA's CloudFront answers 403 without a User-Agent, and Workers send none by default. */
export const UA = "trmnl-fire-risk/0.1 (personal, non-commercial)";

export interface SourceSpec<T> {
  id: SourceId;
  key: string;
  url: string;
  /** Don't refetch within this long of the last fetch or revalidation. */
  refreshMs: number;
  /** Data age (now − asOf, or now − fetchedAt when asOf is null) up to which the state is 'ok'. */
  okAgeMs: number;
  /** Up to which it is 'stale'; beyond, 'unavailable' (data still returned, for alarm-only use). */
  staleAgeMs: number;
  timeoutMs: number;
  /** reg.bom.gov.au ignores If-None-Match, so BoM specs use 'last-modified'. */
  validator: "etag" | "last-modified" | "none";
  accept?: string;
  /** Default 8 MB; a larger body is a failure. */
  maxBytes?: number;
  /** undefined = schema drift = failure. A throw is a failure too. */
  parse(body: string, res: Response): T | undefined;
  /**
   * The source's own timestamp (feed lastUpdated, BoM issue time, Last-Modified), epoch ms. Called
   * with the 304's response too: a time from its headers renews asOf, one from our data cannot.
   */
  asOf?(data: T, res: Response | null): number | null;
  /** e.g. keep BoM's morning 'today' after the 16:00 issue drops it. */
  merge?(prev: T | null, next: T, now: number): T;
  /**
   * The normalised model's shape. A stored copy that fails it (an older model a previous deploy left
   * in KV) is treated as absent: refetched, never handed to code that expects today's model.
   */
  valid?(data: unknown): data is T;
  /**
   * Absolute caps on okAgeMs/staleAgeMs, epoch ms, when the data says when it is superseded (BoM's
   * next routine issue). null = the age limits alone.
   */
  until?(data: T): { ok: number; stale: number } | null;
}

interface Entry<T> {
  v: 1;
  data: T;
  fetchedAt: number;
  asOf: number | null;
  etag: string | null;
  lastModified: string | null;
}

interface Slot {
  e: Entry<unknown>;
  /** fetchedAt of the copy last written to KV, or null when KV has none from us. */
  kvAt: number | null;
}

const MEM_CAP = 50;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const KV_TTL_S = 7 * 24 * 3600;
/** A 304 only moves fetchedAt; writing that every poll would burn KV writes for nothing. */
const KV_TOUCH_MS = 5 * 60_000;
/** KV has no abort signal; a slow read must not eat the upstream's time budget. */
const KV_READ_MS = 1500;
/** Nor does a write: without waitUntil we stop waiting for it (it may still land). */
const KV_WRITE_MS = 1500;
/** An unrequested 304's retry needs at least this long to be worth sending. */
const RETRY_MIN_MS = 1000;
/** getSource's backstop waits this long past the deadline for a step that ignored it. */
const LATE_MS = 100;

const mem = new Map<string, Slot>();
const records = new Map<string, unknown>();

function remember<V>(map: Map<string, V>, key: string, v: V): void {
  map.delete(key);
  map.set(key, v);
  while (map.size > MEM_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Test hook. */
export function clearMemory(): void {
  mem.clear();
  records.clear();
}

/** `p`, or undefined once `ms` has passed. */
export function withTimeout<V>(p: Promise<V>, ms: number): Promise<V | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Milliseconds a step may take: `cap`, cut to what is left before `deadline`, never negative.
 * Deadlines are wall-clock (Date.now()): deps.now() is the data clock, which fixtures freeze.
 */
export function budget(cap: number, deadline?: number): number {
  return deadline === undefined ? cap : Math.max(0, Math.min(cap, deadline - Date.now()));
}

export type WaitUntil = (p: Promise<unknown>) => void;

async function kvRead(deps: Deps, key: string, deadline?: number): Promise<unknown> {
  if (!deps.kv) return null;
  try {
    const kv = deps.kv;
    return (await withTimeout(Promise.resolve().then(() => kv.get(key, "json")), budget(KV_READ_MS, deadline))) ?? null;
  } catch {
    return null;
  }
}

/** Hands the write to waitUntil, or waits for it no longer than KV_WRITE_MS and the deadline allow. */
async function kvWrite(deps: Deps, key: string, value: unknown, ttlS: number, o: { waitUntil?: WaitUntil; deadline?: number } = {}): Promise<void> {
  const kv = deps.kv;
  if (!kv) return;
  const p = Promise.resolve()
    .then(() => kv.put(key, JSON.stringify(value), { expirationTtl: ttlS }))
    .catch(() => undefined);
  if (o.waitUntil) {
    try {
      o.waitUntil(p);
      return;
    } catch {
      /* fall through and wait, bounded */
    }
  }
  await withTimeout(p, budget(KV_WRITE_MS, o.deadline));
}

/** Memory, then KV, for small records outside getSource (the district lookup). Never throws. */
export async function readRecord<T>(key: string, deps: Deps, valid: (x: unknown) => x is T, o: { deadline?: number } = {}): Promise<T | null> {
  const m = records.get(key);
  if (m !== undefined && valid(m)) return m;
  const raw = await kvRead(deps, key, o.deadline);
  if (!valid(raw)) return null;
  remember(records, key, raw);
  return raw;
}

export async function writeRecord(key: string, value: unknown, deps: Deps, ttlS: number, o: { waitUntil?: WaitUntil; deadline?: number } = {}): Promise<void> {
  remember(records, key, value);
  await kvWrite(deps, key, value, ttlS, o);
}

// ---------------------------------------------------------------------------------------------

export interface FetchTextResult {
  /** 0 when no response arrived. */
  status: number;
  /** The body of a 2xx within maxBytes; null otherwise (including 304). */
  body: string | null;
  res: Response | null;
  /** "timeout" | "network" | "http 503" | "too large" | "read error"; null for 2xx and 304. Never a URL. */
  error: string | null;
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

async function readLimited(res: Response, max: number): Promise<string | null> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let n = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    n += chunk.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    out += dec.decode(chunk, { stream: true });
  }
  return out + dec.decode();
}

/**
 * One GET with our User-Agent, a timeout covering headers and body, and a size cap. Bypasses
 * Cloudflare's edge cache so our own revalidation sees the origin. Never throws.
 */
export async function fetchText(
  url: string,
  deps: Deps,
  init: { timeoutMs: number; headers?: Record<string, string>; maxBytes?: number },
): Promise<FetchTextResult> {
  // No time left (the deadline passed): don't start a request nobody will wait for.
  if (!(init.timeoutMs > 0)) return { status: 0, body: null, res: null, error: "timeout" };
  let res: Response;
  try {
    // `cache` is supported from compatibility_date 2024-11-11; the pinned workers-types predate it.
    const req = {
      headers: { ...init.headers, "User-Agent": UA },
      signal: AbortSignal.timeout(init.timeoutMs),
      cache: "no-store",
    } as RequestInit;
    res = await deps.fetch(url, req);
  } catch (e) {
    return { status: 0, body: null, res: null, error: isTimeout(e) ? "timeout" : "network" };
  }
  const status = res.status;
  if (status === 304) {
    await res.body?.cancel().catch(() => undefined);
    return { status, body: null, res, error: null };
  }
  if (status < 200 || status > 299) {
    await res.body?.cancel().catch(() => undefined);
    return { status, body: null, res, error: `http ${status}` };
  }
  try {
    const body = await readLimited(res, init.maxBytes ?? DEFAULT_MAX_BYTES);
    return body === null ? { status, body: null, res, error: "too large" } : { status, body, res, error: null };
  } catch (e) {
    return { status, body: null, res, error: isTimeout(e) ? "timeout" : "read error" };
  }
}

// ---------------------------------------------------------------------------------------------

const finiteOrNull = (x: unknown): x is number | null => x === null || (typeof x === "number" && Number.isFinite(x));
const strOrNull = (x: unknown): x is string | null => x === null || typeof x === "string";

function isEntry(x: unknown): x is Entry<unknown> {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    e.v === 1 &&
    e.data !== undefined &&
    e.data !== null &&
    typeof e.fetchedAt === "number" &&
    Number.isFinite(e.fetchedAt) &&
    finiteOrNull(e.asOf) &&
    strOrNull(e.etag) &&
    strOrNull(e.lastModified)
  );
}

/** The spec's model guard; a throwing guard fails. */
function fits<T>(spec: SourceSpec<T>, e: Entry<unknown>): e is Entry<T> {
  try {
    return !spec.valid || spec.valid(e.data);
  } catch {
    return false;
  }
}

async function load<T>(spec: SourceSpec<T>, deps: Deps, deadline?: number): Promise<Entry<T> | null> {
  const s = mem.get(spec.key);
  if (s) {
    if (fits(spec, s.e)) {
      remember(mem, spec.key, s);
      return s.e;
    }
    mem.delete(spec.key);
  }
  const raw = await kvRead(deps, spec.key, deadline);
  if (!isEntry(raw) || !fits(spec, raw)) return null;
  remember(mem, spec.key, { e: raw, kvAt: raw.fetchedAt });
  return raw;
}

function stateOf<T>(spec: SourceSpec<T>, e: Entry<T>, now: number): SourceState {
  const ref = Math.min(e.asOf ?? e.fetchedAt, now);
  const age = now - ref;
  if (!Number.isFinite(age)) return "unavailable";
  let cap: { ok: number; stale: number } | null = null;
  try {
    cap = spec.until?.(e.data) ?? null;
  } catch {
    cap = null;
  }
  const okUntil = cap && Number.isFinite(cap.ok) ? cap.ok : Infinity;
  const staleUntil = cap && Number.isFinite(cap.stale) ? cap.stale : Infinity;
  if (age <= spec.okAgeMs && now <= okUntil) return "ok";
  if (age <= spec.staleAgeMs && now <= staleUntil) return "stale";
  return "unavailable";
}

function result<T>(spec: SourceSpec<T>, e: Entry<T> | null, now: number, error: string | null): SourceResult<T> {
  if (!e) return { id: spec.id, state: "unavailable", data: null, asOf: null, fetchedAt: null, error };
  return { id: spec.id, state: stateOf(spec, e, now), data: e.data, asOf: e.asOf, fetchedAt: e.fetchedAt, error };
}

/**
 * The copy in isolate memory, aged, with no KV read and no fetch: what gather() answers for a source
 * still unfinished at its deadline. Never throws.
 */
export function lastKnown<T>(spec: SourceSpec<T>, now: number, error: string): SourceResult<T> {
  try {
    const s = mem.get(spec.key);
    return result(spec, s && fits(spec, s.e) ? s.e : null, now, error);
  } catch {
    return { id: spec.id, state: "unavailable", data: null, asOf: null, fetchedAt: null, error };
  }
}

/**
 * asOf after a 304. The upstream still serves our copy, so a newer time from the 304's own headers
 * (S3's x-amz-meta-lastupdated, Last-Modified) renews it; a time read from our unchanged data proves
 * nothing new, so a frozen feed (events lastUpdated, BoM issue time) still ages.
 */
function revalidatedAsOf<T>(spec: SourceSpec<T>, prev: Entry<T>, res: Response | null, now: number): number | null {
  if (!spec.asOf || !res) return prev.asOf;
  try {
    const t = spec.asOf(prev.data, res);
    if (typeof t !== "number" || !Number.isFinite(t) || t === spec.asOf(prev.data, null)) return prev.asOf;
    const fresh = Math.min(t, now);
    return prev.asOf === null || fresh > prev.asOf ? fresh : prev.asOf;
  } catch {
    return prev.asOf;
  }
}

type Refresh<T> = { http: number | null; entry: Entry<T>; changed: boolean } | { http: number | null; error: string };

async function refresh<T>(spec: SourceSpec<T>, deps: Deps, prev: Entry<T> | null, now: number, deadline?: number): Promise<Refresh<T>> {
  const base: Record<string, string> = spec.accept ? { Accept: spec.accept } : {};
  const cond: Record<string, string> = { ...base };
  if (prev && spec.validator === "etag" && prev.etag) cond["If-None-Match"] = prev.etag;
  if (prev && spec.validator === "last-modified" && prev.lastModified) cond["If-Modified-Since"] = prev.lastModified;
  const conditional = Object.keys(cond).length > Object.keys(base).length;
  const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES;

  let r = await fetchText(spec.url, deps, { timeoutMs: budget(spec.timeoutMs, deadline), maxBytes, headers: cond });
  // A 304 we didn't ask for proves nothing about our copy: ask once more, unconditionally, if there's time.
  if (r.status === 304 && !conditional && budget(RETRY_MIN_MS, deadline) >= RETRY_MIN_MS) {
    r = await fetchText(spec.url, deps, { timeoutMs: budget(spec.timeoutMs, deadline), maxBytes, headers: base });
  }
  if (r.status === 304) {
    if (!prev || !conditional) return { http: 304, error: "304 without data" };
    const h = r.res?.headers;
    const asOf = revalidatedAsOf(spec, prev, r.res, now);
    return {
      http: 304,
      entry: { ...prev, fetchedAt: now, asOf, etag: h?.get("etag") ?? prev.etag, lastModified: h?.get("last-modified") ?? prev.lastModified },
      changed: asOf !== prev.asOf,
    };
  }
  const http = r.status || null;
  if (r.error !== null || r.body === null || !r.res) return { http, error: r.error ?? "empty" };

  let data: T;
  let asOf: number | null;
  try {
    const parsed = spec.parse(r.body, r.res);
    if (parsed === undefined) return { http, error: "bad document" };
    data = spec.merge ? spec.merge(prev?.data ?? null, parsed, now) : parsed;
    const t = spec.asOf ? spec.asOf(data, r.res) : null;
    // A clock ahead of ours must not keep a frozen feed 'ok' until real time catches up.
    asOf = typeof t === "number" && Number.isFinite(t) ? Math.min(t, now) : null;
  } catch {
    return { http, error: "parse error" };
  }
  const entry: Entry<T> = {
    v: 1,
    data,
    fetchedAt: now,
    asOf,
    etag: r.res.headers.get("etag"),
    lastModified: r.res.headers.get("last-modified"),
  };
  const changed =
    !prev ||
    prev.asOf !== entry.asOf ||
    prev.etag !== entry.etag ||
    prev.lastModified !== entry.lastModified ||
    JSON.stringify(prev.data) !== JSON.stringify(entry.data);
  return { http, entry, changed };
}

async function save<T>(spec: SourceSpec<T>, deps: Deps, e: Entry<T>, changed: boolean, o: { waitUntil?: WaitUntil; deadline?: number }): Promise<void> {
  const kvAt = mem.get(spec.key)?.kvAt ?? null;
  const write = deps.kv !== null && (changed || kvAt === null || e.fetchedAt - kvAt >= KV_TOUCH_MS);
  remember(mem, spec.key, { e, kvAt: write ? e.fetchedAt : kvAt });
  if (write) await kvWrite(deps, spec.key, e, KV_TTL_S, o);
}

export interface GetOpts {
  force?: boolean;
  waitUntil?: WaitUntil;
  /**
   * Wall-clock epoch ms by which to answer. Every KV read, fetch (the unrequested-304 retry included)
   * and awaited KV write is cut to fit; a step that overruns anyway leaves the last good copy.
   */
  deadline?: number;
}

/**
 * Memory → KV → conditional GET. Returns the freshest copy we have with a state from its own age,
 * and an error string when the latest attempt failed. Never throws.
 */
export async function getSource<T>(spec: SourceSpec<T>, deps: Deps, opts: GetOpts = {}): Promise<SourceResult<T>> {
  const t0 = Date.now();
  // Shared with the deadline fallback below, which may answer while work() is still running.
  const st: { now: number; prev: Entry<T> | null; http: number | null; hit: boolean } = { now: t0, prev: null, http: null, hit: false };
  const work = async (): Promise<SourceResult<T>> => {
    try {
      st.now = deps.now();
      const now = st.now;
      const prev = (st.prev = await load(spec, deps, opts.deadline));
      if (prev && !opts.force && prev.fetchedAt <= now && now - prev.fetchedAt < spec.refreshMs) {
        st.hit = true;
        return result(spec, prev, now, null);
      }
      const r = await refresh(spec, deps, prev, now, opts.deadline);
      st.http = r.http;
      if ("error" in r) return result(spec, prev, now, r.error);
      await save(spec, deps, r.entry, r.changed, opts);
      return result(spec, r.entry, now, null);
    } catch {
      return result(spec, st.prev, st.now, "internal error");
    }
  };
  // Every step is already cut to the deadline; this catches one that ignores it (a fetch deaf to its abort).
  const out =
    opts.deadline === undefined
      ? await work()
      : ((await withTimeout(work(), budget(Infinity, opts.deadline) + LATE_MS)) ?? result(spec, st.prev, st.now, "timeout"));
  try {
    deps.log({ src: spec.id, http: st.http, ms: Date.now() - t0, state: out.state, error: out.error, ...(st.hit ? { hit: st.hit } : {}) });
  } catch {
    /* logging must not break a poll */
  }
  return out;
}
