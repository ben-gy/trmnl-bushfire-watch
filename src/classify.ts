/**
 * What a VicEmergency feature is, how severe it is, and who reported it. Classification reads
 * feedType and category only: sourceOrg/sourceFeed allowlists have already broken twice (DELWP →
 * DEECA, FRV → ESTA), and new category2 values ("Structure Fire") appear without notice. Every
 * rule leans towards alarm: unknown statuses are active, unknown warning levels rank just below
 * Emergency Warning, and anything unrecognised stays visible as "unclassified".
 */
import { decodeEntities } from "./xml.js";
import type { Agency, Geo, Kind, StatusBucket } from "./types.js";

// Bounded so a long unbroken string cannot make the match quadratic.
const EMAIL = /[^\s@]{1,64}@[^\s@]{1,253}\.[a-z]{2,}[^\s@]{0,64}/gi;
/** No field we keep needs more; caps the work done on a hostile or runaway string. */
const MAX_IN = 4096;
// C0/C1 controls, zero-width characters, bidi overrides and the BOM.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
// Excluding '<' too stops each attempt at the next '<', so a run of them is linear, not quadratic.
const TAG = /<[^<>]*>/g;

/** Keeps the brackets and punctuation around an address: "(ask jo@x.com)" → "(ask [email removed])". */
function redact(m: string): string {
  const lead = /^[(\[{<'"]*/.exec(m)![0];
  const trail = /[)\]}>.,;:!?'"]*$/.exec(m.slice(lead.length))![0];
  return `${lead}[email removed]${trail}`;
}

/** Feed text made safe to store and show: no markup, no control characters, no email addresses. */
export function clean(s: unknown, max = 120): string {
  let t: string;
  if (typeof s === "string") t = s;
  else if (typeof s === "number" || typeof s === "boolean" || typeof s === "bigint") t = String(s);
  else if (Array.isArray(s)) t = s.map((x) => clean(x, Infinity)).filter(Boolean).join(", ");
  else return "";
  if (t.length > MAX_IN) t = t.slice(0, MAX_IN);
  t = decodeEntities(t.replace(TAG, " ")).replace(TAG, " ");
  t = t.replace(CONTROL, " ");
  if (t.includes("@")) t = t.replace(EMAIL, redact);
  t = t.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(0, max - 1));
  const sp = cut.lastIndexOf(" ");
  const head = sp >= max * 0.6 ? cut.slice(0, sp) : cut;
  return head.replace(/[\s,;:·–-]+$/, "") + "…";
}

const lc = (s: unknown): string => (typeof s === "string" ? s.trim().toLowerCase().replace(/\s+/g, " ") : "");

/** Who reported it, for display only; never used to classify. */
export function agencyOf(sourceOrg: string, sourceFeed: string): Agency {
  const org = lc(sourceOrg), feed = lc(sourceFeed);
  switch (org) {
    case "vic/cfa":
      return "CFA";
    case "vic/esta":
    case "vic/frv":
    case "vic/mfb":
      return "FRV";
    case "vic/ses":
      return "SES";
    case "vic/deeca":
    case "vic/delwp":
      return "DEECA";
    case "emv":
      return "EMV";
    case "au/bom":
      return "BoM";
    case "nsw/rfs":
      return "RFS";
    case "sa/cfs":
      return "CFS";
  }
  return feed.includes("mfb-") ? "FRV" : "Other";
}

const AREA_C2 = /^(fire danger rating|total fire ban|fire danger level|fire ban)/;
const AREA_FEEDS = new Set(["cfa-fdr", "cfa-fdrtfb", "cfa-prepare-fdr"]);
/** A bbox this large is a district, not an incident. */
const AREA_KM2 = 2000;

function bboxKm2(b: Geo["bbox"]): number {
  if (!b) return 0;
  const midLat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  return (b[2] - b[0]) * 111.32 * Math.cos(midLat) * (b[3] - b[1]) * 110.57;
}

/** The rating vocabulary (normRating's recognised words), repeated here so classification does not depend on ratings.ts. */
const RATING_WORD = /^(no rating|no forecast|moderate|high|extreme|catastrophic)$/;
/** Whole words only: "Abandoned" or "Urban" must not turn a fire into a rating. */
const RATING_TEXT = /\b(bans?|tfb|ratings?|danger)\b/;

/**
 * A status only a rating or ban product carries. Anything else, including blank, "Unknown" and
 * new words, is an incident status, so a district-sized fire with an odd status stays a fire.
 */
function ratingLike(status: unknown): boolean {
  const s = lc(status).replace(/_/g, " ");
  return RATING_WORD.test(s) || RATING_TEXT.test(s);
}

export function kindOf(p: Record<string, unknown>, geo: Geo): Kind {
  const ft = lc(p.feedType), c1 = lc(p.category1), c2 = lc(p.category2), feed = lc(p.sourceFeed), org = lc(p.sourceOrg);
  if (ft === "warning") return "warning";
  if (AREA_C2.test(c2) || AREA_FEEDS.has(feed)) return "area_product";
  if (c1 === "met" || org === "au/bom") return "met_warning";
  // A burns feed also reports burns that escape; one filed as a Fire is a fire, not a planned burn.
  if (ft === "burn-area" || c1.startsWith("planned burn") || c2.startsWith("planned burn") || (feed.endsWith("-burns") && c1 !== "fire")) return "burn";
  if (ft === "earthquake" || c1 === "earthquake") return "earthquake";
  if (ft === "incident") {
    // Defensive: a new statewide pseudo-incident (like cfa-fdr) under an unseen category2. Size alone
    // is not enough: it must also carry a rating or ban status, so a mega-fire is never hidden.
    if (bboxKm2(geo.bbox) > AREA_KM2 && ratingLike(p.status)) return "area_product";
    return c1 === "fire" ? "fire" : "other";
  }
  return "unclassified";
}

const ACTION_3 = /leave immediately|evacuate (now|immediately)|take shelter now|shelter indoors now/i;

/**
 * Warning level from category1: 3 Emergency Warning (and every evacuation variant, kept raw so it
 * shows as published), 2 Watch and Act, 1 Advice, 0 Community Update. An unrecognised category1 is 3 when its action is an Emergency
 * Warning action, else 2 (Watch and Act actions and unknowns alike); either way `raw` carries the
 * category1 so it is shown as published, never renamed to a level it isn't.
 */
export function warningLevel(category1: string, action: string): { level: 0 | 1 | 2 | 3; raw: string } {
  const c = lc(category1);
  if (/evacuat/.test(c)) return { level: 3, raw: clean(category1, 40) };
  if (c.startsWith("emergency warning")) return { level: 3, raw: "" };
  if (c.startsWith("watch and act") || c === "warning" || /^(major|moderate)\b/.test(c)) return { level: 2, raw: "" };
  if (c.startsWith("advice") || c === "watch" || /^(final )?minor\b/.test(c) || c.startsWith("safe to return")) return { level: 1, raw: "" };
  if (c.startsWith("community update") || c.startsWith("community information")) return { level: 0, raw: "" };
  const raw = clean(category1, 40) || "Level unknown";
  if (ACTION_3.test(action)) return { level: 3, raw };
  return { level: 2, raw };
}

const SAFE = new Set(["safe", "complete"]);
const CONTROLLED = new Set(["under control", "contained", "controlled", "patrolled"]);
const GOING = new Set(["going", "not yet under control", "not yet controlled", "out of control"]);

/** safe / controlled by exact name; everything else, including blank and new values, is active. */
export function statusBucket(status: string): StatusBucket {
  const s = lc(status);
  if (SAFE.has(s)) return "safe";
  if (CONTROLLED.has(s)) return "controlled";
  return "active";
}

/** 3 going, 2 other active (unknown and new values included), 1 controlled, 0 safe. */
export function fireRank(status: string): 0 | 1 | 2 | 3 {
  const b = statusBucket(status);
  if (b === "safe") return 0;
  if (b === "controlled") return 1;
  return GOING.has(lc(status)) ? 3 : 2;
}

export function isVegetation(cat2: string): boolean {
  return /bush|grass|scrub|forest|crop|stubble|hay|pasture|vegetation|wildfire/i.test(cat2);
}
