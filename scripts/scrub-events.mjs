/**
 * Scrubs a VicEmergency GeoJSON document before it is committed as a fixture:
 *  - deletes every `contact` key (warnings carry a named officer's email in cap.contact),
 *  - drops the `webBody` HTML and the full warning `text`,
 *  - redacts anything that still looks like an email address,
 *  - optionally keeps only incidents near the test points (warnings, statewide and area-sized
 *    features are always kept, because they are what the distance tests exercise).
 *
 * Usage as a module: scrubEvents(doc, { keepWithinKm, points }) -> doc (mutated copy).
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function scrubValue(v) {
  if (typeof v === "string") return v.replace(EMAIL, "[redacted]");
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "contact" || k === "webBody" || k === "text") continue;
      out[k] = scrubValue(val);
    }
    return out;
  }
  return v;
}

function points(geom, acc = []) {
  if (!geom || typeof geom !== "object") return acc;
  if (geom.type === "Point") acc.push(geom.coordinates);
  else if (geom.type === "GeometryCollection") for (const g of geom.geometries ?? []) points(g, acc);
  else if (geom.type === "Polygon") for (const r of geom.coordinates ?? []) acc.push(...r);
  else if (geom.type === "MultiPolygon") for (const p of geom.coordinates ?? []) for (const r of p) acc.push(...r);
  return acc;
}

function km(a, b) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function scrubEvents(doc, { keepWithinKm = Infinity, points: keepPoints = [] } = {}) {
  const out = scrubValue(doc);
  if (Number.isFinite(keepWithinKm) && keepPoints.length) {
    out.features = (out.features ?? []).filter((f) => {
      const p = f.properties ?? {};
      if (p.feedType !== "incident" && p.feedType !== "burn-area") return true; // warnings etc.
      if (p.statewide === "Y") return true;
      const pts = points(f.geometry);
      if (pts.length !== 1) return true; // collections and polygons: area products, RFS perimeters
      return keepPoints.some((q) => km([q[1], q[0]], pts[0]) <= keepWithinKm);
    });
  }
  return out;
}

export function assertNoEmail(text, label) {
  const m = String(text).match(EMAIL);
  if (m) throw new Error(`${label}: email-like string survived scrubbing: ${m[0].replace(/^[^@]*/, "***")}`);
}
