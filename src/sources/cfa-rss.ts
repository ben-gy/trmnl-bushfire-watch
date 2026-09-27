/**
 * CFA's TFB + FDR forecast RSS: an independent fallback on another host. Items are keyed by the date
 * in their <title>, never by position. Each description is entity-encoded HTML: a declaration, one
 * "District: YES|NO…" line per district, then "Fire Danger Ratings", the BoM issue line and one
 * "District: RATING" line per district. An item without the issue line is a placeholder whose
 * ratings mean nothing yet.
 */
import { clean } from "../classify.js";
import { districtKey } from "../districts.js";
import { fromLongDate, localParts } from "../time.js";
import { all, decodeEntities, docRoot, first, parseXml } from "../xml.js";
import type { LocalDate, RatingsFeed } from "../types.js";
import { emptyRatings, putRating } from "./fdrtfb.js";

export const CFA_URL = "https://www.cfa.vic.gov.au/cfa/rssfeed/tfbfdrforecast_rss.xml";

const FDR_WORD = /^(NO RATING|MODERATE|HIGH|EXTREME|CATASTROPHIC)$/;
const TFB_WORD = /^(YES|NO)\b/;
const ISSUED = /forecast issued at\s*:?\s*(.*)$/i;
const DISTRICT_LINE = /^([A-Za-z][A-Za-z &]*?)\s*:\s*(.+)$/;

export function parseCfaRss(xml: string): RatingsFeed | undefined {
  if (typeof xml !== "string") return undefined;
  // A body cut short could end mid-word ("Central: EXT"), so only a closed <rss>.
  const root = docRoot(parseXml(xml.replace(/^\uFEFF/, "")), "rss");
  if (!root) return undefined;
  const out = emptyRatings();
  let n = 0;
  for (const item of all(root, "item")) {
    const date = fromLongDate(first(item, "title")?.text.trim());
    if (!date) continue;
    const lines = htmlLines(first(item, "description")?.text ?? "");
    let issuedLine = false;
    let inFdr = false;
    const fdr: [string, string][] = [];
    for (const line of lines) {
      const iss = ISSUED.exec(line);
      if (iss) {
        issuedLine = inFdr = true;
        const at = parseIssued(iss[1] ?? "");
        if (at !== null) out.issued[date] = at;
        continue;
      }
      if (/^fire danger ratings?$/i.test(line)) {
        inFdr = true;
        continue;
      }
      const m = DISTRICT_LINE.exec(line);
      if (m && districtKey(m[1])) {
        const v = clean(m[2], 60).toUpperCase();
        // FDR words first ("NO RATING" also starts with NO); an unknown word goes by which block it is in.
        if (FDR_WORD.test(v) || (inFdr && !TFB_WORD.test(v))) fdr.push([m[1]!, v]);
        else if (putRating(out.tfb, "tfb", date, m[1], v)) n++;
        continue;
      }
      if (!inFdr && !out.declaration[date] && /total fire ban/i.test(line)) out.declaration[date] = clean(line, 160);
    }
    if (!issuedLine) {
      if (!out.notYet.includes(date)) out.notYet.push(date);
      n++;
      continue;
    }
    for (const [name, v] of fdr) if (putRating(out.fdr, "fdr", date, name, v)) n++;
  }
  return n ? out : undefined;
}

/** Entity-decoded, tag-stripped text lines, split on paragraph ends and line breaks. */
function htmlLines(desc: string): string[] {
  let h = desc;
  for (let k = 0; k < 2 && /&lt;|&#0*60;|&#x0*3c;/i.test(h); k++) h = decodeEntities(h);
  return h
    .split(/<\/p\s*>|<br\s*\/?>/i)
    // [^<>] ends each match attempt at the next "<", so a run of "<" costs linear time, not quadratic.
    .map((s) => decodeEntities(s.replace(/<[^<>]*>/g, " ")).replace(/[\s ]+/g, " ").trim())
    .filter(Boolean);
}

/** "Sunday, 27 September 2026 16:00 PM" (sic) → epoch ms, reading the wall time in Melbourne. */
function parseIssued(s: string): number | null {
  const date = fromLongDate(s);
  const t = /(\d{1,2}):(\d{2})\s*([AP]\.?M\.?)?/i.exec(s);
  if (!date || !t) return null;
  let hh = Number(t[1]);
  const mm = Number(t[2]);
  const ampm = t[3]?.toUpperCase().replace(/\./g, "");
  // CFA writes 24-hour times with a redundant suffix ("16:00 PM"); only adjust genuine 12-hour times.
  if (ampm === "PM" && hh < 12) hh += 12;
  if (ampm === "AM" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return melbourneWallTime(date, hh, mm);
}

function melbourneWallTime(date: LocalDate, hh: number, mm: number): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, hh, mm);
  // Start from a guess and correct by what Intl says the guess reads as; two passes settle DST.
  let t = wall - 10 * 3_600_000;
  for (let k = 0; k < 2; k++) {
    const p = localParts(t);
    t += wall - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  }
  return t;
}
