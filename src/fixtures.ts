/**
 * ?fixture= scenarios: the real pipeline run over bundled, scrubbed snapshots with a frozen clock.
 * They make no network calls, use their own cache namespace and are always marked sample data, so a
 * device left pointing at one can never show a stale warning as current.
 *
 * quiet            27 Sep 2026 17:00, North Warrandyte (suburb point): the live snapshots.
 * busy-warrandyte  9 Jan 2026 18:55, suburb point: Extreme + Total Fire Ban, a Watch and Act 21 km N.
 * catastrophic     9 Jan 2026, Kinglake: North Central Catastrophic, inside a Watch and Act.
 * horsham-inside   9 Jan 2026, Horsham: inside a Watch and Act with no fire within 30 km.
 * outage           27 Sep 2026, every upstream down.
 */
import events0109 from "../fixtures/events-2026-01-09.json";
import events0927 from "../fixtures/events-2026-09-27T1656.json";
import osom0927 from "../fixtures/osom-fdrtfb-2026-09-27T1656.json";
import openMeteo0927 from "../fixtures/open-meteo-2026-09-27T1656.json";
import cfa0927 from "../fixtures/cfa-tfbfdr-2026-09-27T1656.xml";
// BoM products are personal-use only, so the repo carries synthetic files in their shape.
import idv18555 from "../fixtures/IDV18555-sample.xml";
import idv18560 from "../fixtures/IDV18560-sample.xml";
import type { DistrictResult } from "./gather.js";
import { IDV18555_URL } from "./sources/bom-fdr.js";
import { IDV18560_URL } from "./sources/bom-fw.js";
import { CFA_URL } from "./sources/cfa-rss.js";
import { OSOM_URL } from "./sources/fdrtfb.js";
import { EVENTS_URL } from "./sources/vicemergency.js";
import { addDays, localDate } from "./time.js";
import type { DistrictKey, Home } from "./types.js";

export interface Scenario {
  name: string;
  now: number;
  home: Home;
  district: DistrictResult;
  /** URL prefix → body; anything else answers 404. Undefined means the network is down. */
  routes?: Record<string, { body: string; headers?: Record<string, string> }>;
}

const SUBURB: Home = { lat: -37.73, lon: 145.22 };
const KINGLAKE: Home = { lat: -37.53, lon: 145.34 };
const HORSHAM: Home = { lat: -36.7167, lon: 142.1997 };

const district = (key: DistrictKey, lga: string, neighbours: DistrictKey[]): DistrictResult => ({ lookup: { key, lga, neighbours }, state: "ok", source: "vicmap" });

// ---------------------------------------------------------------------------------------------
// Synthetic pieces for the 9 Jan day (the archive has events only)

type Conditions = { forecasts?: { date?: string; fdr?: Record<string, string>; tfb?: Record<string, string> }[] };

/** osom-fdrtfb.json rebuilt from the events feed's conditions, as VicEmergency publishes it. */
function osomFrom(events: { properties?: { conditions?: Conditions } }): string {
  const results: unknown[] = [];
  const fdr: unknown[] = [];
  for (const f of events.properties?.conditions?.forecasts ?? []) {
    const t = Date.parse(f.date ?? "");
    if (!Number.isFinite(t)) continue;
    const [y, m, d] = localDate(t).split("-");
    const issueFor = `${d}/${m}/${y}`;
    const tfbList = Object.entries(f.tfb ?? {}).map(([name, status]) => ({ name, status }));
    const any = tfbList.some((x) => /^YES/i.test(x.status));
    results.push({ issueFor, status: any ? "Y" : "N", declaration: any ? "A Total Fire Ban has been declared." : "Not currently a day of Total Fire Ban.", declareList: tfbList });
    fdr.push({ issueFor, issueAt: issueFor, imgUrl: null, declareList: Object.entries(f.fdr ?? {}).map(([name, status]) => ({ name, status })) });
  }
  return JSON.stringify({ results: [...results, ...fdr] });
}

/**
 * An Open-Meteo response for a hot north-westerly day with a south-westerly change mid-afternoon,
 * then a milder day, after a dry week — the pattern behind Victoria's worst fire days.
 */
function hotDay(today: string): string {
  const H = 3600;
  const start = Date.parse(`${addDays(today, -7)}T00:00:00+11:00`) / 1000;
  const time: number[] = [], temp: number[] = [], rh: number[] = [], wspd: number[] = [], wdir: number[] = [], gust: number[] = [], precip: number[] = [], pop: number[] = [], code: number[] = [];
  for (let i = 0; i < 10 * 24; i++) {
    const t = start + i * H;
    const day = localDate(t * 1000);
    const hr = Number(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", hourCycle: "h23" }).format(t * 1000)) % 24;
    const diurnal = Math.sin(((hr - 9) / 24) * 2 * Math.PI);
    let T = 24 + 6 * diurnal, R = 45 - 15 * diurnal, S = 12 + 6 * diurnal, D = 200, P = 0, POP = 5, C = 1;
    if (day === today) {
      if (hr < 15) {
        T = 32 + 10 * Math.max(0, diurnal);
        R = 22 - 14 * Math.max(0, diurnal);
        S = 30 + 18 * Math.max(0, diurnal);
        D = 315;
      } else {
        T = 27 - (hr - 15) * 0.6;
        R = 35 + (hr - 15) * 3;
        S = 38 - (hr - 15) * 2;
        D = 225;
        POP = 20;
        C = 3;
      }
    } else if (day === addDays(today, 1)) {
      T = 23 + 7 * diurnal;
      R = 45 - 20 * diurnal;
      S = 15 + 8 * Math.max(0, diurnal);
      D = 190;
    } else if (day === addDays(today, -4) && hr >= 13 && hr <= 16) {
      P = 1.5;
      POP = 70;
      C = 61;
    }
    time.push(t);
    temp.push(Math.round(T * 10) / 10);
    rh.push(Math.round(R));
    wspd.push(Math.round(S * 10) / 10);
    wdir.push(D);
    gust.push(Math.round(S * 1.7 * 10) / 10);
    precip.push(P);
    pop.push(POP);
    code.push(C);
  }
  const units = { time: "unixtime", temperature_2m: "°C", relative_humidity_2m: "%", wind_speed_10m: "km/h", wind_direction_10m: "°", wind_gusts_10m: "km/h", precipitation: "mm", precipitation_probability: "%", weather_code: "wmo code" };
  return JSON.stringify({
    latitude: -37.75,
    longitude: 145.25,
    timezone: "Australia/Melbourne",
    utc_offset_seconds: 39600,
    hourly_units: units,
    hourly: { time, temperature_2m: temp, relative_humidity_2m: rh, wind_speed_10m: wspd, wind_direction_10m: wdir, wind_gusts_10m: gust, precipitation: precip, precipitation_probability: pop, weather_code: code },
  });
}

// ---------------------------------------------------------------------------------------------

const QUIET_NOW = Date.parse("2026-09-27T07:00:00Z");
const BUSY_NOW = Date.parse("2026-01-09T07:55:00Z");

function quietRoutes(now: number): Scenario["routes"] {
  const fresh = { "x-amz-meta-lastupdated": new Date(now - 60_000).toISOString() };
  return {
    [EVENTS_URL]: { body: JSON.stringify(events0927) },
    [OSOM_URL]: { body: JSON.stringify(osom0927), headers: fresh },
    [CFA_URL]: { body: cfa0927, headers: { "last-modified": new Date(now - 5 * 60_000).toUTCString() } },
    [IDV18555_URL]: { body: idv18555 },
    [IDV18560_URL]: { body: idv18560 },
    "https://api.open-meteo.com/": { body: JSON.stringify(openMeteo0927) },
  };
}

function busyRoutes(now: number): Scenario["routes"] {
  return {
    [EVENTS_URL]: { body: JSON.stringify(events0109) },
    [OSOM_URL]: { body: osomFrom(events0109), headers: { "x-amz-meta-lastupdated": new Date(now - 60_000).toISOString() } },
    "https://api.open-meteo.com/": { body: hotDay(localDate(now)) },
  };
}

export const SCENARIOS: Record<string, () => Scenario> = {
  quiet: () => ({ name: "quiet", now: QUIET_NOW, home: SUBURB, district: district("central", "nillumbik", ["north_central"]), routes: quietRoutes(QUIET_NOW) }),
  "busy-warrandyte": () => ({ name: "busy-warrandyte", now: BUSY_NOW, home: SUBURB, district: district("central", "nillumbik", ["north_central"]), routes: busyRoutes(BUSY_NOW) }),
  catastrophic: () => ({ name: "catastrophic", now: BUSY_NOW, home: KINGLAKE, district: district("north_central", "murrindindi", ["central"]), routes: busyRoutes(BUSY_NOW) }),
  "horsham-inside": () => ({ name: "horsham-inside", now: BUSY_NOW, home: HORSHAM, district: district("wimmera", "horsham", []), routes: busyRoutes(BUSY_NOW) }),
  outage: () => ({ name: "outage", now: QUIET_NOW, home: SUBURB, district: district("central", "nillumbik", ["north_central"]) }),
};

/** A fetch that serves the scenario's routes (longest matching prefix), 404 otherwise, or fails outright. */
export function fixtureFetch(s: Scenario): typeof fetch {
  const routes = s.routes;
  return (async (input: RequestInfo | URL) => {
    if (!routes) throw new TypeError("network down (fixture)");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = Object.keys(routes)
      .filter((p) => url.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    if (!match) return new Response("not found", { status: 404 });
    const r = routes[match]!;
    return new Response(r.body, { status: 200, headers: r.headers });
  }) as typeof fetch;
}
