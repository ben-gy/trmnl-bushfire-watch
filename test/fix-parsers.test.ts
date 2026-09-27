/**
 * The rating parsers under hostile input: a body cut short must never parse as a smaller, calmer
 * document (review finding 2), a timestamp outside any plausible range must not reach the
 * formatters (13), and every rating, ban and declaration string is cleaned before it is stored (21).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { gather } from "../src/gather.js";
import { buildPayload } from "../src/payload.js";
import { normRating } from "../src/ratings.js";
import { parseIdv18555 } from "../src/sources/bom-fdr.js";
import { parseIdv18560 } from "../src/sources/bom-fw.js";
import { parseCfaRss } from "../src/sources/cfa-rss.js";
import { parseOsom, ratingsFromConditions } from "../src/sources/fdrtfb.js";
import { clearMemory } from "../src/store.js";
import { fmtTime, fmtWeekdayTime, parseTime } from "../src/time.js";
import { docRoot, parseXml } from "../src/xml.js";
import { EMAIL, FX, type LogLine, SUBURB, T_QUIET, upstream } from "./helpers.js";

/** Every prefix that stops short of the root's closing tag, sampled every `step` characters and at every character near the end. */
function truncations(xml: string, closeTag: string, step: number): number[] {
  const end = xml.lastIndexOf(closeTag) + closeTag.length; // the first length that holds the whole root
  const cuts: number[] = [];
  for (let k = 0; k < end; k += step) cuts.push(k);
  for (let k = Math.max(0, end - 80); k < end; k++) cuts.push(k);
  return cuts;
}

// The markup, address and bidi override a hostile or broken upstream could put in a status.
const HOSTILE = "<b>now</b> ring jo@example.com ‮";
const DIRTY = /[<>@‪-‮]|example\.com/;

describe("parseXml completeness", () => {
  it("is complete only when every element closed and a top-level element was closed", () => {
    expect(parseXml("<a><b>x</b></a>").complete).toBe(true);
    expect(parseXml('<?xml version="1.0"?>\n<!-- note -->\n<a/>\n').complete).toBe(true);
    // The tolerant close: an inner element left open is closed by its parent's tag.
    expect(parseXml("<a><b>x</a>").complete).toBe(true);
    expect(parseXml("﻿<a></a>  \n").complete).toBe(true);

    expect(parseXml("").complete).toBe(false);
    expect(parseXml("just text").complete).toBe(false);
    expect(parseXml("<!-- only a comment -->").complete).toBe(false);
    expect(parseXml("<a><b>x</b>").complete).toBe(false);
    expect(parseXml("<a><b>x</b></a").complete).toBe(false);
    expect(parseXml("<a></a><a>").complete).toBe(false);
    // A stray close tag for something never opened does not close the root.
    expect(parseXml("<a></b>").complete).toBe(false);
  });

  it("docRoot gives the named top-level element of a complete document only", () => {
    expect(docRoot(parseXml("<rss><channel/></rss>"), "rss")?.children[0]?.name).toBe("channel");
    expect(docRoot(parseXml("<rss><channel/></rss>"), "product")).toBeUndefined();
    expect(docRoot(parseXml("<rss><channel/>"), "rss")).toBeUndefined();
    // Nested, not top-level.
    expect(docRoot(parseXml("<html><rss></rss></html>"), "rss")).toBeUndefined();
  });
});

describe("truncated bodies are unavailable, never partial data", () => {
  it("CFA RSS: every prefix short of </rss> is undefined", () => {
    expect(parseCfaRss(FX.cfa)).toBeDefined();
    const cuts = truncations(FX.cfa, "</rss>", 13);
    expect(cuts.length).toBeGreaterThan(500);
    for (const k of cuts) expect(parseCfaRss(FX.cfa.slice(0, k)), `cut at ${k}`).toBeUndefined();
  });

  it("IDV18555: every prefix short of </product> is undefined", () => {
    expect(parseIdv18555(FX.idv18555)).toBeDefined();
    const cuts = truncations(FX.idv18555, "</product>", 31);
    expect(cuts.length).toBeGreaterThan(500);
    for (const k of cuts) expect(parseIdv18555(FX.idv18555.slice(0, k)), `cut at ${k}`).toBeUndefined();
  });

  it("IDV18560: every prefix short of </product> is undefined", () => {
    expect(parseIdv18560(FX.idv18560)).toBeDefined();
    const cuts = truncations(FX.idv18560, "</product>", 23);
    expect(cuts.length).toBeGreaterThan(500);
    for (const k of cuts) expect(parseIdv18560(FX.idv18560.slice(0, k)), `cut at ${k}`).toBeUndefined();
  });

  it("a CFA body cut at 'Central: EXT' cannot produce a rating", () => {
    // Central's rating in the first item's FDR block (";Central" never matches "North Central").
    const xml = FX.cfa.replace(/;Central: MODERATE/, ";Central: EXTREME");
    expect(parseCfaRss(xml)!.fdr["2026-09-27"]?.central).toBe("EXTREME");
    const at = xml.indexOf(";Central: EXTREME") + ";Central: EXT".length;
    expect(parseCfaRss(xml.slice(0, at))).toBeUndefined();
    // Nor can any later cut, right up to the last character of </rss>.
    for (let k = at; k < xml.lastIndexOf("</rss>") + "</rss>".length; k += 7) expect(parseCfaRss(xml.slice(0, k)), `cut at ${k}`).toBeUndefined();
  });

  it("an IDV18555 body cut inside 'Catastrophic' cannot produce a rating", () => {
    const xml = FX.idv18555.replace('<text type="fire_danger">No Rating</text>', '<text type="fire_danger">Catastrophic</text>');
    expect(parseIdv18555(xml)!.days.central?.["2026-09-28"]?.rating).toBe("Catastrophic");
    expect(parseIdv18555(xml.slice(0, xml.indexOf("Catastrophic") + "Catastr".length))).toBeUndefined();
  });

  it("still reads a whole document with trailing whitespace", () => {
    expect(parseIdv18555(`${FX.idv18555}\n\n`)).toEqual(parseIdv18555(FX.idv18555));
    expect(parseCfaRss(`${FX.cfa}\r\n`)).toEqual(parseCfaRss(FX.cfa));
  });
});

describe("parseTime keeps to plausible instants", () => {
  it("rejects numbers outside Date's range and outside 2000–2100", () => {
    const ok = Date.parse("2026-09-27T06:00:00Z");
    expect(parseTime(ok)).toBe(ok);
    for (const bad of [1e17, -1e17, 8.64e15, -8.64e15, 8.64e15 + 1, 0, -1, 1_790_000_000, Number.MAX_VALUE, NaN, Infinity, -Infinity]) {
      expect(parseTime(bad), String(bad)).toBeNull();
    }
    expect(parseTime(Date.UTC(2000, 0, 1))).toBe(Date.UTC(2000, 0, 1));
    expect(parseTime(Date.UTC(2000, 0, 1) - 1)).toBeNull();
    expect(parseTime(Date.UTC(2100, 11, 31, 23, 59))).toBe(Date.UTC(2100, 11, 31, 23, 59));
    expect(parseTime(Date.UTC(2101, 0, 1))).toBeNull();
  });

  it("rejects strings outside 2000–2100", () => {
    expect(parseTime("2000-01-01T00:00:00Z")).toBe(Date.UTC(2000, 0, 1));
    expect(parseTime("2100-12-31T23:59:59Z")).toBe(Date.parse("2100-12-31T23:59:59Z"));
    for (const bad of ["1999-12-31T23:59:59Z", "2101-01-01T00:00:00Z", "1970-01-01T00:00:00Z", "+275760-09-13T00:00:00Z", "-271821-04-20T00:00:00Z", "0001-01-01T00:00:00Z"]) {
      expect(parseTime(bad), bad).toBeNull();
    }
  });

  it("never hands the formatters a value they throw on", () => {
    for (const v of [1e17, -1e17, 8.64e15, "+275760-09-13T00:00:00Z", 1e300, "2026-09-27T06:00:00Z", Date.UTC(2050, 5, 1)]) {
      const t = parseTime(v);
      if (t !== null) {
        expect(() => fmtTime(t)).not.toThrow();
        expect(() => fmtWeekdayTime(t)).not.toThrow();
      }
    }
  });
});

describe("rating strings are cleaned before they are stored", () => {
  it("OSOM: statuses and declarations lose markup, addresses and bidi controls, and keep their alarm", () => {
    const o = parseOsom({
      results: [
        { issueFor: "27/09/2026", issueAt: "27/09/2026", declareList: [{ name: "Central", status: `EXTREME ${HOSTILE}` }] },
        {
          issueFor: "27/09/2026",
          status: "Y",
          declaration: `A Total Fire Ban is declared. Contact <a href="mailto:jo@example.com">jo@example.com</a> ‮`,
          declareList: [{ name: "Central", status: `YES - TOTAL FIRE BAN IN FORCE ${HOSTILE}` }],
        },
      ],
    })!;
    const fdr = o.fdr["2026-09-27"]!.central!;
    const tfb = o.tfb["2026-09-27"]!.central!;
    const decl = o.declaration["2026-09-27"]!;
    for (const s of [fdr, tfb, decl]) expect(s).not.toMatch(DIRTY);
    expect(fdr.startsWith("EXTREME NOW RING")).toBe(true);
    expect(normRating(fdr).level).toBe(3);
    expect(tfb.startsWith("YES - TOTAL FIRE BAN IN FORCE")).toBe(true);
    expect(decl.startsWith("A Total Fire Ban is declared.")).toBe(true);
  });

  it("CFA: district lines and the declaration are cleaned", () => {
    const enc = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const desc = enc(
      `<p>Total Fire Ban declared, ask jo@example.com</p><p>Central: YES - TOTAL FIRE BAN IN FORCE ‮ jo@example.com<br></p>` +
        `<p>Fire Danger Ratings<br/>Bureau of Meteorology forecast issued at: Sunday, 27 September 2026 05:30 AM</p>` +
        `<p>Central: CATASTROPHIC &lt;i&gt;call&lt;/i&gt; jo@example.com<br></p>`,
    );
    const c = parseCfaRss(`<rss><channel><item><title>Sunday, 27 September 2026</title><description>${desc}</description></item></channel></rss>`)!;
    const fdr = c.fdr["2026-09-27"]!.central!;
    const tfb = c.tfb["2026-09-27"]!.central!;
    const decl = c.declaration["2026-09-27"]!;
    for (const s of [fdr, tfb, decl]) expect(s).not.toMatch(DIRTY);
    expect(normRating(fdr).level).toBe(4);
    expect(tfb.startsWith("YES - TOTAL FIRE BAN IN FORCE")).toBe(true);
  });

  it("BoM: IDV18555 ratings and IDV18560 ratings and wind directions are cleaned", () => {
    const fdrXml = FX.idv18555.replace('<text type="fire_danger">No Rating</text>', `<text type="fire_danger">Extreme &lt;b&gt;x&lt;/b&gt; jo@example.com ‮</text>`);
    const r = parseIdv18555(fdrXml)!.days.central!["2026-09-28"]!.rating;
    expect(r).not.toMatch(DIRTY);
    expect(normRating(r).level).toBe(3);

    const fwXml = FX.idv18560
      .replace('<element type="fire_danger_rating">No Rating</element>', `<element type="fire_danger_rating">High jo@example.com</element>`)
      .replace('<element type="wind_direction_at_elevation_1">SSE</element>', `<element type="wind_direction_at_elevation_1">&lt;b&gt;SSE&lt;/b&gt;‮</element>`);
    const wx = parseIdv18560(fwXml)!.district.central![0]!;
    expect(wx.fdr).not.toMatch(DIRTY);
    expect(wx.fdr!.startsWith("High")).toBe(true);
    expect(wx.windDir).toBe("SSE");
  });

  it("the events feed's conditions go through the same door", () => {
    const c = ratingsFromConditions([{ date: "2026-09-27", fdr: { central: `HIGH ${HOSTILE}` }, tfb: { central: `NO - RESTRICTIONS MAY APPLY ${HOSTILE}` } }]);
    expect(c.fdr["2026-09-27"]!.central).not.toMatch(DIRTY);
    expect(c.tfb["2026-09-27"]!.central).not.toMatch(DIRTY);
  });

  describe("end to end", () => {
    beforeEach(() => clearMemory());

    it("an email and markup in an OSOM status never reach the payload, and the alarm stays", async () => {
      const j = JSON.parse(FX.osom) as { results: { issueFor: string; issueAt?: string; declareList: { name: string; status: string }[] }[] };
      for (const e of j.results) {
        if (e.issueFor !== "27/09/2026") continue;
        for (const d of e.declareList) if (d.name === "Central") d.status = e.issueAt ? `EXTREME ${HOSTILE}` : `YES - TOTAL FIRE BAN IN FORCE ${HOSTILE}`;
      }
      const up = upstream(T_QUIET, {}, { osom: JSON.stringify(j) });
      const logs: LogLine[] = [];
      const g = await gather({ home: SUBURB, district: null, radiusKm: 30 }, { fetch: up.fetch, now: () => T_QUIET, kv: null, log: (l) => logs.push(l) });
      const p = buildPayload(g);
      const json = JSON.stringify(p);
      expect(json).not.toMatch(EMAIL);
      expect(json).not.toContain("example.com");
      expect(json).not.toContain("<b>");
      expect(json).not.toContain("‮");
      expect(p.days[0].fdr.level).toBe(3);
      expect(p.days[0].tfb.state).toBe("declared");
    });
  });
});
