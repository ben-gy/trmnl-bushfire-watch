import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openMeteoUrl, parseOpenMeteo } from "../src/sources/openmeteo.js";
import { fmtTime, localDate } from "../src/time.js";
import type { FireWx, Weather, WxHour } from "../src/types.js";
import { dayWeather, isUpwind, rainHistory, upwindFrom, windChange, wxStrings, type WxDay } from "../src/weather.js";

const RAW = JSON.parse(readFileSync(new URL("../fixtures/open-meteo-2026-09-27T1656.json", import.meta.url), "utf8")) as {
  current: Record<string, number>;
  hourly: Record<string, number[]>;
};
const W = parseOpenMeteo(RAW)!;
const NOW = Date.parse("2026-09-27T06:56:00Z"); // 16:56 AEST, when the fixture was captured
const HOUR = 3_600_000;

/**
 * Independent oracle: before 4 Oct Melbourne is a constant UTC+10, so a local date is the UTC window
 * [date−1 14:00Z, date 14:00Z). Reads the raw JSON arrays, not the parser's output.
 */
function rawDay(y: number, m: number, d: number) {
  const lo = Date.UTC(y, m - 1, d - 1, 14), hi = lo + 24 * HOUR;
  const idx = RAW.hourly.time!.map((t, i) => [t * 1000, i] as const).filter(([t]) => t >= lo && t < hi).map(([, i]) => i);
  const col = (k: string) => idx.map((i) => RAW.hourly[k]![i]!);
  const temp = col("temperature_2m"), rh = col("relative_humidity_2m"), spd = col("wind_speed_10m");
  const peakI = idx[spd.indexOf(Math.max(...spd))]!;
  const rhI = idx[rh.indexOf(Math.min(...rh))]!;
  return {
    n: idx.length,
    tmax: Math.max(...temp),
    tmin: Math.min(...temp),
    rhMin: Math.min(...rh),
    rhMinAt: RAW.hourly.time![rhI]! * 1000,
    wspdMax: Math.max(...spd),
    gustMax: Math.max(...col("wind_gusts_10m")),
    dirAtPeak: RAW.hourly.wind_direction_10m![peakI]!,
    popMax: Math.max(...col("precipitation_probability")),
    precipSum: col("precipitation").reduce((a, b) => a + b, 0),
  };
}

const hour = (t: number, o: Partial<WxHour> = {}): WxHour => ({
  t,
  temp: 20,
  rh: 50,
  wspd: 20,
  wdir: 0,
  gust: 30,
  precip: 0,
  pop: 0,
  code: 0,
  ...o,
});

/** Hourly series starting at `start`, one wind (dir, speed) per hour. */
const winds = (start: number, seq: [number, number][]): WxHour[] =>
  seq.map(([wdir, wspd], i) => hour(start + i * HOUR, { wdir, wspd }));

const T0 = Date.parse("2026-11-10T02:00:00Z"); // 13:00 AEDT

describe("openMeteoUrl", () => {
  const url = openMeteoUrl({ lat: -37.844612, lon: 144.972345 }); // Albert Park Lake
  const q = new URL(url).searchParams;
  it("sends 2 dp coordinates only", () => {
    expect(q.get("latitude")).toBe("-37.84");
    expect(q.get("longitude")).toBe("144.97");
    expect(url).not.toMatch(/37\.844|144\.972/);
  });
  it("asks for unix times in km/h, 7 days back and 3 ahead, and never the dead BoM model", () => {
    expect(new URL(url).origin + new URL(url).pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(q.get("timezone")).toBe("Australia/Melbourne");
    expect(q.get("timeformat")).toBe("unixtime");
    expect(q.get("wind_speed_unit")).toBe("kmh");
    expect(q.get("past_days")).toBe("7");
    expect(q.get("forecast_days")).toBe("3");
    const vars = "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,precipitation_probability,weather_code";
    expect(q.get("hourly")).toBe(vars);
    expect(q.get("current")).toBe(vars);
    expect(q.has("models")).toBe(false);
    expect(url).not.toContain("bom_access_global");
  });
});

describe("parseOpenMeteo", () => {
  it("parses the fixture: 240 hours in epoch ms, and the current reading", () => {
    expect(W.hours).toHaveLength(240);
    expect(W.hours[0]!.t).toBe(RAW.hourly.time![0]! * 1000);
    expect(localDate(W.hours[0]!.t)).toBe("2026-09-20");
    expect(localDate(W.hours[239]!.t)).toBe("2026-09-29");
    expect(W.currentAt).toBe(RAW.current.time! * 1000);
    expect(W.current).toMatchObject({ temp: 15.2, rh: 53, wspd: 15, wdir: 148, gust: 42.5, precip: 0, pop: 0, code: 0 });
    expect(fmtTime(W.currentAt!)).toBe("16:45");
  });

  it("returns undefined on schema drift", () => {
    expect(parseOpenMeteo(null)).toBeUndefined();
    expect(parseOpenMeteo("<html>")).toBeUndefined();
    expect(parseOpenMeteo({ error: true, reason: "bad" })).toBeUndefined();
    expect(parseOpenMeteo({ hourly: {} })).toBeUndefined();
    expect(parseOpenMeteo({ hourly: { time: "x" } })).toBeUndefined();
    // timeformat=iso8601 strings would be fixed-offset local times: refuse rather than guess.
    expect(parseOpenMeteo({ hourly: { time: ["2026-10-04T02:00"], temperature_2m: [10] } })).toBeUndefined();
    expect(parseOpenMeteo({ hourly_units: { wind_speed_10m: "m/s" }, hourly: { time: [1], wind_speed_10m: [5] } })).toBeUndefined();
  });

  it("keeps missing values null, never 0", () => {
    const w = parseOpenMeteo({
      hourly: { time: [1790431200, 1790434800], temperature_2m: [12, null], relative_humidity_2m: [null, "40"] },
    })!;
    expect(w.hours).toHaveLength(2);
    expect(w.hours[0]).toMatchObject({ temp: 12, rh: null, wspd: null, wdir: null, gust: null, precip: null, pop: null });
    expect(w.hours[1]).toMatchObject({ temp: null, rh: null });
    expect(w.current).toBeNull();
    expect(w.currentAt).toBeNull();
  });
});

describe("dayWeather (fixture)", () => {
  for (const [date, y, m, d] of [["2026-09-27", 2026, 9, 27], ["2026-09-28", 2026, 9, 28]] as const) {
    it(`aggregates ${date} from the hours in that Melbourne day`, () => {
      const want = rawDay(y, m, d);
      const got = dayWeather(W, date)!;
      expect(want.n).toBe(24);
      expect(got).toMatchObject({
        date,
        hours: 24,
        fromHour: 0,
        toHour: 23,
        tmax: want.tmax,
        tmin: want.tmin,
        rhMin: want.rhMin,
        rhMinAt: want.rhMinAt,
        wspdMax: want.wspdMax,
        gustMax: want.gustMax,
        dirAtPeak: want.dirAtPeak,
        popMax: want.popMax,
        hotDryWindy: false,
      });
      expect(got.precipSum).toBeCloseTo(want.precipSum, 6);
    });
  }

  it("reads 27 Sep as a mild day and formats it within budget", () => {
    const want = rawDay(2026, 9, 27);
    expect([want.tmax, want.tmin, want.rhMin, want.wspdMax, want.dirAtPeak, want.gustMax]).toEqual([16.1, 6.6, 50, 20.9, 155, 45]);
    const wx = wxStrings(dayWeather(W, "2026-09-27"), { isToday: true, now: NOW, rain: rainHistory(W, "2026-09-27") });
    expect(wx).toEqual({
      ok: true,
      temps: "16° / 7°",
      rh: `RH min 50% @${fmtTime(want.rhMinAt)}`,
      wind: "SSE 21 G45 km/h",
      change: "",
      change_flag: false,
      rain: "Rain 0% · 0.0 mm",
      text: "7 days: 11 mm · wet Sat 26",
      src: "Open-Meteo model",
      src_short: "Model",
    });
  });

  it("finds the real NW→W→SW change on the evening of 20 Sep", () => {
    const d = dayWeather(W, "2026-09-20")!;
    expect(d.change).toMatchObject({ at: Date.parse("2026-09-20T11:00:00Z"), fromDir: "W", toDir: "SW", toDeg: 215 });
    expect(fmtTime(d.change!.at)).toBe("21:00");
    expect(wxStrings(d, { isToday: false, now: NOW })).toMatchObject({ change: "SW change ~21:00", change_flag: true });
  });

  it("returns null for a date with no hours", () => {
    expect(dayWeather(W, "2026-10-15")).toBeNull();
    expect(wxStrings(dayWeather(W, "2026-10-15"), { isToday: false, now: NOW })).toEqual({ ok: false });
  });
});

describe("DST (3–5 Oct 2026)", () => {
  // 3 Oct 00:00 AEST = 2 Oct 14:00Z; 6 Oct 00:00 AEDT = 5 Oct 13:00Z. 71 hourly instants.
  const start = Date.parse("2026-10-02T14:00:00Z"), end = Date.parse("2026-10-05T13:00:00Z");
  const peakT = Date.parse("2026-10-04T06:00:00Z");
  const hours: WxHour[] = [];
  for (let t = start; t < end; t += HOUR) {
    hours.push(hour(t, t === peakT ? { temp: 38, rh: 12, wspd: 45, wdir: 315, gust: 80 } : { temp: 15 + ((t - start) / HOUR) * 0.01 }));
  }
  const w: Weather = { currentAt: null, current: null, hours };

  it("groups by Melbourne date: 4 Oct has 23 hours", () => {
    expect(hours).toHaveLength(71);
    expect(dayWeather(w, "2026-10-03")!.hours).toBe(24);
    expect(dayWeather(w, "2026-10-04")!.hours).toBe(23);
    expect(dayWeather(w, "2026-10-05")!.hours).toBe(24);
    for (const d of ["2026-10-03", "2026-10-04", "2026-10-05"]) {
      expect(dayWeather(w, d)).toMatchObject({ fromHour: 0, toHour: 23 });
    }
  });

  it("puts 17:00 local on 4 Oct at 06:00Z", () => {
    const d = dayWeather(w, "2026-10-04")!;
    expect(d.tmax).toBe(38);
    expect(d.rhMinAt).toBe(peakT);
    expect(fmtTime(peakT)).toBe("17:00");
    expect(d.hotDryWindy).toBe(true);
    const wx = wxStrings(d, { isToday: false, now: start });
    expect(wx.rh).toBe("RH min 12% @17:00");
    expect(wx.wind).toBe("NW 45 G80 km/h");
    // The 5th's first hour is 13:00Z on the 4th (00:00 AEDT), not 14:00Z as a fixed +10 h would say.
    expect(dayWeather(w, "2026-10-05")!.tmin).toBeCloseTo(15 + ((Date.parse("2026-10-04T13:00:00Z") - start) / HOUR) * 0.01, 9);
  });
});

describe("windChange", () => {
  it("NW, NW, W, SW(20) → change at the SW hour", () => {
    const c = windChange(winds(T0, [[315, 25], [315, 25], [270, 20], [225, 20]]));
    expect(c).toMatchObject({ at: T0 + 3 * HOUR, toDir: "SW", speed: 20, toDeg: 225 });
    expect(["NW", "W"]).toContain(c!.fromDir);
  });
  it("W then WSW(20) is drift, not a change", () => {
    expect(windChange(winds(T0, [[270, 25], [247.5, 20]]))).toBeNull();
  });
  it("NW then WSW(20) is a change (67.5°)", () => {
    expect(windChange(winds(T0, [[315, 25], [247.5, 20]]))).toMatchObject({ at: T0 + HOUR, fromDir: "NW", toDir: "WSW" });
  });
  it("a SW onset under 15 km/h is not", () => {
    expect(windChange(winds(T0, [[315, 25], [225, 10], [225, 14]]))).toBeNull();
  });
  it("N, NNE, NE is not", () => {
    expect(windChange(winds(T0, [[0, 30], [22.5, 30], [45, 30]]))).toBeNull();
  });
  it("NNE → WNW only is not", () => {
    expect(windChange(winds(T0, [[22.5, 30], [292.5, 30]]))).toBeNull();
  });
  it("looks back at most 3 h", () => {
    expect(windChange(winds(T0, [[315, 25], [150, 5], [150, 5], [150, 5], [200, 20]]))).toBeNull();
    expect(windChange(winds(T0, [[315, 25], [150, 5], [150, 5], [200, 20]]))).toMatchObject({ at: T0 + 3 * HOUR });
  });
  it("ignores hours with a missing direction or speed", () => {
    expect(windChange(winds(T0, [[315, 25], [225, 20]]).map((h, i) => (i ? { ...h, wspd: null } : h)))).toBeNull();
    expect(windChange(winds(T0, [[315, 25], [225, 20]]).map((h, i) => (i ? h : { ...h, wdir: null })))).toBeNull();
  });
  it("dayWeather sees the previous evening for a change just after midnight", () => {
    const start = Date.parse("2026-11-10T11:00:00Z"); // 22:00 AEDT on the 10th
    const hs = winds(start, [[330, 30], [320, 30], [210, 25], ...Array.from({ length: 23 }, () => [200, 20] as [number, number])]);
    const d = dayWeather({ currentAt: null, current: null, hours: hs }, "2026-11-11")!;
    expect(d.change).toMatchObject({ at: start + 2 * HOUR, toDir: "SSW" });
    expect(fmtTime(d.change!.at)).toBe("00:00");
    // …but never reports a change that belongs to the previous day.
    expect(dayWeather({ currentAt: null, current: null, hours: hs }, "2026-11-10")!.change).toBeNull();
  });
});

describe("indicators and strings", () => {
  const day = (hs: WxHour[]) => dayWeather({ currentAt: null, current: null, hours: hs }, localDate(hs[0]!.t))!;
  const midnight = Date.parse("2026-11-09T13:00:00Z"); // 10 Nov 00:00 AEDT
  const fullDay = (o: (i: number) => Partial<WxHour>) => Array.from({ length: 24 }, (_, i) => hour(midnight + i * HOUR, o(i)));

  it("hotDryWindy for 35° / 15% / 40 km/h, and only when all three hold", () => {
    expect(day(fullDay((i) => (i === 15 ? { temp: 35, rh: 15, wspd: 40 } : {}))).hotDryWindy).toBe(true);
    expect(day(fullDay((i) => (i === 15 ? { temp: 35, rh: 31, wspd: 40 } : {}))).hotDryWindy).toBe(false);
    expect(day(fullDay((i) => (i === 15 ? { temp: 35, rh: 15, wspd: null } : {}))).hotDryWindy).toBe(false);
    const wx = wxStrings(day(fullDay((i) => (i === 15 ? { temp: 35, rh: 15, wspd: 40 } : {}))), {
      isToday: false,
      now: midnight,
      rain: { sum7d: 3, lastWet: null },
    });
    expect(wx.text).toBe("Hot, dry & windy (model)");
  });

  it("a missing RH renders as a dash, never 0%", () => {
    const d = day(fullDay((i) => (i === 14 ? { rh: null } : { rh: 40 })));
    expect(d.rhMin).toBeNull();
    expect(d.rhMinAt).toBeNull();
    const wx = wxStrings(d, { isToday: false, now: midnight });
    expect(wx.rh).toBe("RH min —");
    expect(wx.rh).not.toMatch(/\d/);
  });

  it("missing numbers never become 0 anywhere in the strings", () => {
    const d = day(fullDay((i) => (i === 3 ? { temp: null, wspd: null, gust: null, pop: null, precip: null } : { wdir: 300 })));
    const wx = wxStrings(d, { isToday: false, now: midnight, rain: { sum7d: null, lastWet: null } });
    expect(wx).toMatchObject({ ok: true, temps: "Temp —", wind: "Wind —", rain: "Rain —", text: "" });
    expect(JSON.stringify(wx)).not.toMatch(/\b0(°|%| mm| km)/);
  });

  it("a day with no values at all is unavailable", () => {
    const d = day(fullDay(() => ({ temp: null, rh: null, wspd: null, gust: null, pop: null, precip: null })));
    expect(wxStrings(d, { isToday: true, now: midnight })).toEqual({ ok: false });
  });

  it("labels a partial day's window in the source line, in the short form too", () => {
    const d = day(fullDay(() => ({})).slice(15));
    expect(d).toMatchObject({ fromHour: 15, toHour: 23, hours: 9 });
    expect(wxStrings(d, { isToday: true, now: midnight })).toMatchObject({ src: "Open-Meteo model from 15:00", src_short: "Model from 15:00" });
  });

  it("the official BoM flag for the same date outranks the model, and is labelled", () => {
    const d = day(fullDay(() => ({ wdir: 330 })));
    const fw = (date: string, flag: boolean | null): FireWx => ({
      date, fdr: null, fbi: null, haines: null, lightning: null, wcdi: null, wcdFlag: flag, tmax50: null, rhmin50: null, windDir: null, gust90: null,
    });
    const on = wxStrings(d, { isToday: false, now: midnight, official: fw("2026-11-10", true) });
    expect(on).toMatchObject({ change: "Wind change danger", change_flag: true, src: "Open-Meteo model · BoM", src_short: "Model · BoM" });
    const off = wxStrings(d, { isToday: false, now: midnight, official: fw("2026-11-10", false) });
    expect(off).toMatchObject({ change: "", change_flag: false });
    expect(JSON.stringify(off)).not.toMatch(/no change/i);
    const other = wxStrings(d, { isToday: false, now: midnight, official: fw("2026-11-11", true) });
    expect(other).toMatchObject({ change: "", change_flag: false, src: "Open-Meteo model", src_short: "Model" });
  });

  it("a model change more than an hour past keeps its text on today's column but loses the chip", () => {
    const d = day(fullDay((i) => (i < 14 ? { wdir: 330, wspd: 30 } : { wdir: 220, wspd: 25 })));
    expect(d.change!.at).toBe(midnight + 14 * HOUR);
    const later = wxStrings(d, { isToday: true, now: midnight + 17 * HOUR });
    expect(later).toMatchObject({ change: "SW change ~14:00", change_flag: false });
    expect(wxStrings(d, { isToday: true, now: midnight + 10 * HOUR })).toMatchObject({ change_flag: true });
    expect(wxStrings(d, { isToday: false, now: midnight + 17 * HOUR })).toMatchObject({ change_flag: true });
  });

  it("keeps every string within its budget at the extremes", () => {
    const d: WxDay = {
      date: "2026-11-10", hours: 24, fromHour: 7, toHour: 18,
      tmax: 48.6, tmin: -12.4, rhMin: 100, rhMinAt: midnight + 15 * HOUR,
      wspdMax: 149.6, gustMax: 199.5, dirAtPeak: 247.5, popMax: 100, precipSum: 1234.5,
      change: { at: midnight + 15 * HOUR, fromDir: "NNW", toDir: "WSW", speed: 99, toDeg: 250 }, hotDryWindy: false,
    };
    const wx = wxStrings(d, {
      isToday: false, now: midnight,
      official: { date: "2026-11-10", fdr: null, fbi: null, haines: null, lightning: null, wcdi: null, wcdFlag: null, tmax50: null, rhmin50: null, windDir: null, gust90: null },
      rain: { sum7d: 1234.5, lastWet: "2026-11-09" },
    });
    expect(wx.temps!.length).toBeLessThanOrEqual(11);
    for (const k of ["rh", "wind", "change", "rain"] as const) expect(wx[k]!.length, k).toBeLessThanOrEqual(18);
    for (const k of ["text", "src"] as const) expect(wx[k]!.length, k).toBeLessThanOrEqual(28);
    expect(wx.src_short!.length).toBeLessThanOrEqual(23);
    expect(wx).toMatchObject({ temps: "49° / -12°", rh: "RH min 100% @15:00", wind: "WSW 150 G200 km/h", change: "WSW change ~15:00" });
    // Both source forms keep the model label, the window and the BoM marker.
    expect(wx).toMatchObject({ src: "Model 07:00–18:00 · BoM", src_short: "Model 07:00–18:00 · BoM" });
  });
});

describe("upwind", () => {
  it("is within ±45° of a wind-from direction", () => {
    expect(isUpwind(330, [300])).toBe(true);
    expect(isUpwind(345, [300])).toBe(true);
    expect(isUpwind(10, [340])).toBe(true);
    expect(isUpwind(30, [300])).toBe(false);
    expect(isUpwind(210, [300])).toBe(false);
    expect(isUpwind(null, [300])).toBe(false);
    expect(isUpwind(300, [])).toBe(false);
  });
  it("counts the post-change direction too", () => {
    const midnight = Date.parse("2026-11-09T13:00:00Z");
    const hs = Array.from({ length: 24 }, (_, i) => hour(midnight + i * HOUR, i < 14 ? { wdir: 330, wspd: 40 } : { wdir: 225, wspd: 25 }));
    const d = dayWeather({ currentAt: null, current: null, hours: hs }, "2026-11-10")!;
    const from = upwindFrom(d);
    expect(from).toEqual([330, 225]);
    expect(isUpwind(220, from)).toBe(true);
    expect(isUpwind(90, from)).toBe(false);
    expect(upwindFrom(null)).toEqual([]);
  });
});

describe("rainHistory", () => {
  it("sums the 7 Melbourne days before today from the fixture", () => {
    let want = 0;
    for (let d = 20; d <= 26; d++) want += rawDay(2026, 9, d).precipSum;
    const r = rainHistory(W, "2026-09-27");
    expect(r.sum7d).toBeCloseTo(want, 6);
    expect(r.sum7d).toBeCloseTo(11.4, 6);
    expect(r.lastWet).toBe("2026-09-26");
  });
  it("is null when a day is missing, never a partial sum", () => {
    const r = rainHistory(W, "2026-09-26"); // needs 19 Sep, which the fixture lacks
    expect(r.sum7d).toBeNull();
    const sixAm23 = Date.parse("2026-09-22T20:00:00Z");
    const gap: Weather = { ...W, hours: W.hours.map((h) => (h.t === sixAm23 ? { ...h, precip: null } : h)) };
    const g = rainHistory(gap, "2026-09-27");
    expect(g.sum7d).toBeNull();
    expect(g.lastWet).toBe("2026-09-26");
  });
  it("only reports a wet day it can see past no gap", () => {
    const gap: Weather = { ...W, hours: W.hours.filter((h) => localDate(h.t) !== "2026-09-28") };
    expect(rainHistory(gap, "2026-09-30")).toEqual({ sum7d: null, lastWet: null });
  });
});
