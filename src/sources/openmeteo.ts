/**
 * Open-Meteo hourly forecast, the numbers behind the weather columns. Requested with
 * timeformat=unixtime because Open-Meteo applies one fixed UTC offset to the whole response (it
 * emits a local 02:00 on 4 Oct that never exists in Melbourne); instants are grouped into Melbourne
 * dates later, via Intl. Coordinates go out at 2 dp (about 1 km), never at full precision.
 * `models=bom_access_global` is never requested: that model stopped updating in June 2025.
 */
import { TZ } from "../time.js";
import type { Home, Weather, WxHour } from "../types.js";

const VARS = [
  "temperature_2m",
  "relative_humidity_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "precipitation",
  "precipitation_probability",
  "weather_code",
].join(",");

export function openMeteoUrl(home: Home): string {
  const q = new URLSearchParams({
    latitude: home.lat.toFixed(2),
    longitude: home.lon.toFixed(2),
    timezone: TZ,
    timeformat: "unixtime",
    wind_speed_unit: "kmh",
    past_days: "7",
    forecast_days: "3",
    hourly: VARS,
    current: VARS,
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** Only a finite number is a value; null, strings and NaN are missing, never 0. */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Units we format as °C, %, km/h. A declared different unit is drift, not something to relabel. */
const UNITS: Record<string, string> = {
  time: "unixtime",
  temperature_2m: "°C",
  relative_humidity_2m: "%",
  wind_speed_10m: "km/h",
  wind_gusts_10m: "km/h",
  precipitation: "mm",
};

function unitsOk(u: unknown): boolean {
  if (u === undefined) return true;
  if (!isObj(u)) return false;
  return Object.entries(UNITS).every(([k, want]) => u[k] === undefined || u[k] === want);
}

function hourAt(block: Obj, i: number | null, t: number): WxHour {
  const pick = (k: string): number | null => {
    const v = block[k];
    if (i === null) return num(v);
    return Array.isArray(v) ? num(v[i]) : null;
  };
  return {
    t,
    temp: pick("temperature_2m"),
    rh: pick("relative_humidity_2m"),
    wspd: pick("wind_speed_10m"),
    wdir: pick("wind_direction_10m"),
    gust: pick("wind_gusts_10m"),
    precip: pick("precipitation"),
    pop: pick("precipitation_probability"),
    code: pick("weather_code"),
  };
}

/**
 * Open-Meteo JSON → Weather, or undefined on schema drift (no hourly.time array, a time that is not
 * a UNIX-seconds number, or a declared unit we would mislabel). A missing variable leaves its values
 * null rather than failing the whole forecast.
 */
export function parseOpenMeteo(json: unknown): Weather | undefined {
  if (!isObj(json) || !isObj(json.hourly)) return undefined;
  const h = json.hourly;
  if (!Array.isArray(h.time)) return undefined;
  if (!unitsOk(json.hourly_units) || !unitsOk(json.current_units)) return undefined;

  const hours: WxHour[] = [];
  for (let i = 0; i < h.time.length; i++) {
    const s = num(h.time[i]);
    if (s === null) return undefined;
    hours.push(hourAt(h, i, s * 1000));
  }
  hours.sort((a, b) => a.t - b.t);

  let current: WxHour | null = null;
  if (isObj(json.current)) {
    const s = num(json.current.time);
    if (s !== null) current = hourAt(json.current, null, s * 1000);
  }
  return { currentAt: current?.t ?? null, current, hours };
}
