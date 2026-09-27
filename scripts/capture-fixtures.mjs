#!/usr/bin/env node
/**
 * Captures fixture material: live snapshots of every upstream, plus two archived VicEmergency days
 * (github.com/jamesmstone/vicemergency). Events are scrubbed (scrub-events.mjs) before writing.
 *
 *   node scripts/capture-fixtures.mjs            # live captures into fixtures/local/, then the archives
 *   node scripts/capture-fixtures.mjs --archives # archives only
 *
 * Live captures go to fixtures/local/, which git ignores, under dated names (events-<date>T<hhmm>.json
 * and so on), so a capture never changes what the tests and ?fixture= read. To update a committed
 * snapshot, copy the scrubbed capture into fixtures/, point src/fixtures.ts, test/helpers.ts FX and
 * the tests that read the file directly at the new name (grep for the old one), update THIRD_PARTY.md
 * and delete the old file. The frozen test clocks (QUIET_NOW, T_QUIET) and some expectations follow
 * the snapshot's time and content, so expect to revisit them.
 *
 * BoM products (IDV18555, IDV18560) are licensed for personal use only and this repo is public, so
 * a capture of them is never copied into fixtures/. The committed IDV185*-sample.xml files are
 * synthetic: when BoM changes its schema, update them by hand from a local capture, keeping the
 * structure and inventing the values.
 *
 * The archives are pinned to commits and written to fixtures/ under their committed names, so
 * rerunning them changes those files only when the scrubbing changes.
 *
 * Coordinates used here are suburb-level test points, never a real house.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoEmail, scrubEvents } from "./scrub-events.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "fixtures");
const local = join(out, "local");
mkdirSync(local, { recursive: true });

const UA = { "User-Agent": "trmnl-fire-risk/0.1 (personal, non-commercial; fixture capture)" };
// North Warrandyte (suburb), Kinglake, Macedon, Horsham.
const POINTS = [[-37.73, 145.22], [-37.53, 145.34], [-37.42, 144.56], [-36.7167, 142.1997]];
const SUBURB = POINTS[0];
const ARCHIVES = [
  { sha: "f46fb4fc4e02777f7df69fecab5e0ad586b1e8f4", name: "events-2026-01-09.json" },
  { sha: "213da16de7555ddac293e6f61eacb033907195cb", name: "events-2025-03-31.json" },
];

async function get(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

function write(name, text, dir) {
  if (name.startsWith("events")) assertNoEmail(text, name);
  writeFileSync(join(dir, name), text);
  console.log(`${(dir === out ? name : `local/${name}`).padEnd(36)} ${String(text.length).padStart(8)} B`);
}

function stamp() {
  const d = new Date();
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const v = (t) => p.find((x) => x.type === t)?.value;
  return `${v("year")}-${v("month")}-${v("day")}T${v("hour")}${v("minute")}`;
}

/** Every live capture goes to fixtures/local/: nothing here replaces a committed fixture. */
async function live() {
  const s = stamp();
  const events = JSON.parse(await get("https://emergency.vic.gov.au/public/events-geojson.json"));
  write(`events-${s}.json`, JSON.stringify(scrubEvents(events)), local);
  write(`osom-fdrtfb-${s}.json`, await get("https://emergency.vic.gov.au/public/osom-fdrtfb.json"), local);
  write(`cfa-tfbfdr-${s}.xml`, await get("https://www.cfa.vic.gov.au/cfa/rssfeed/tfbfdrforecast_rss.xml"), local);
  // Personal use only: never copied into the committed fixtures.
  write(`IDV18555-${s}.xml`, await get("https://reg.bom.gov.au/fwo/IDV18555.xml"), local);
  write(`IDV18560-${s}.xml`, await get("https://reg.bom.gov.au/fwo/IDV18560.xml"), local);
  const hourly = "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,precipitation_probability,weather_code";
  const q = new URLSearchParams({
    latitude: SUBURB[0].toFixed(2), longitude: SUBURB[1].toFixed(2), timezone: "Australia/Melbourne", timeformat: "unixtime",
    wind_speed_unit: "kmh", past_days: "7", forecast_days: "3", hourly, current: hourly,
  });
  write(`open-meteo-${s}.json`, await get(`https://api.open-meteo.com/v1/forecast?${q}`), local);
  const wfs = (layer, prop) =>
    `https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=open-data-platform:${layer}&outputFormat=application/json&propertyName=${prop}&cql_filter=${encodeURIComponent(`INTERSECTS(geom,SRID=4283;POINT(${SUBURB[1]} ${SUBURB[0]}))`)}`;
  write(`vicmap-district-${s}.json`, await get(wfs("cfa_tfb_district", "tfb_district")), local);
  write(`vicmap-lga-${s}.json`, await get(wfs("vmlite_lga", "lga_name")), local);
}

async function archives() {
  for (const a of ARCHIVES) {
    const doc = JSON.parse(await get(`https://raw.githubusercontent.com/jamesmstone/vicemergency/${a.sha}/events.json`));
    write(a.name, JSON.stringify(scrubEvents(doc, { keepWithinKm: 110, points: POINTS })), out);
  }
}

if (!process.argv.includes("--archives")) await live();
await archives();
