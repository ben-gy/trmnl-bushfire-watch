import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Liquid } from "liquidjs";
import { describe, expect, it } from "vitest";
import imported from "../plugin/src/full.liquid";
import { previewHtml } from "../src/preview.js";
import type { PayloadV1 } from "../src/types.js";
import { ATTRIBUTION, DISCLAIMER, EPOCH, PAYLOADS, busy, houseEW, incidentsDown, quiet, sample } from "./payloads.js";

const source = readFileSync(fileURLToPath(new URL("../plugin/src/full.liquid", import.meta.url)), "utf8");

/** strictFilters: a TRMNL-only filter would fail here, so LiquidJS and TRMNL's Ruby Liquid stay in step. */
const engine = new Liquid({ strictFilters: true });
const parsed = engine.parse(source);

function trmnlAt(timestamp: number, instance: string | null = "North Warrandyte") {
  return {
    system: { timestamp_utc: timestamp },
    plugin_settings: instance === null ? {} : { instance_name: instance },
    user: { time_zone_iana: "Australia/Melbourne" },
  };
}

/** TRMNL spreads a single polling URL's JSON at the root, next to its own `trmnl` object. */
function render(payload: unknown, trmnl?: ReturnType<typeof trmnlAt>): string {
  const p = (payload ?? {}) as Partial<PayloadV1>;
  const t = trmnl ?? trmnlAt((p.generated_epoch ?? EPOCH) + 60);
  return engine.renderSync(parsed, { ...p, trmnl: t }) as string;
}

const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const RATING_WORDS = /\b(NO RATING|MODERATE|HIGH|EXTREME|CATASTROPHIC|TOTAL FIRE BAN)\b/;
const ZERO_CLAIM = /\b0 (fires?|warnings?|going)\b/i;

const LIVE = ["quiet", "busy", "houseEW", "incidentsDown", "ratingUnavailable", "stale", "staleBusy", "sample", "houseAdviceCat", "houseHeatCat", "staleAlarm", "neighbourAlarm"] as const;
const DOWN = ["down", "configError", "empty"] as const;

/** The top band, which sits before the mid row. */
const band = (html: string) => html.slice(html.indexOf('class="fw-band'), html.indexOf('fw-mid">'));
/** The day columns and the incidents panel. */
const mid = (html: string) => html.slice(html.indexOf('fw-mid">'));

describe("full.liquid renders every payload", () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    it(`${name}: no errors or leaked values`, () => {
      const html = render(payload);
      expect(html).not.toMatch(/Liquid error|undefined|\[object Object\]|NaN/);
      expect(html).toContain('<div class="title_bar">');
      expect(html).toContain("North Warrandyte");
      for (const phrase of ["all clear", "no threat", "you are safe"]) {
        expect(text(html).toLowerCase()).not.toContain(phrase);
      }
    });
  }

  it("the vitest .liquid import is the file itself", () => {
    expect(imported).toBe(source);
  });

  for (const name of LIVE) {
    it(`${name}: attribution, disclaimer and checked time`, () => {
      const html = render(PAYLOADS[name]);
      expect(html).toContain(DISCLAIMER);
      expect(html).toContain("State of Victoria");
      expect(html).toContain(PAYLOADS[name].attribution);
      expect(html).toContain("Checked Sun 16:05");
      expect(html).toContain("SAMPLE DATA · NOT LIVE");
    });
  }

  for (const name of DOWN) {
    it(`${name}: full-screen unavailable, official channels, no ratings`, () => {
      const html = render(PAYLOADS[name]);
      const t = text(html);
      expect(t).toContain("Check the VicEmergency app");
      expect(t).toContain("1800 226 226");
      expect(t).not.toMatch(RATING_WORDS);
      expect(t).not.toMatch(ZERO_CLAIM);
      expect(html).not.toContain("fw-count");
      expect(html).toContain("State of Victoria");
      expect(html).toContain(DISCLAIMER);
      if (name !== "empty") {
        expect(html).toContain("SAMPLE DATA · NOT LIVE · Checked Sun 16:05");
        expect(t).toContain("Checked Sun 16:05");
        expect(html).not.toContain("NOT UPDATED");
      }
    });
  }

  it("titles the unavailable screens", () => {
    expect(render(PAYLOADS.down)).toContain("DATA UNAVAILABLE");
    expect(render(PAYLOADS.down)).toContain("Last successful update: Sun 13:52");
    expect(render(PAYLOADS.configError)).toContain("CONFIGURATION ERROR");
    expect(render(PAYLOADS.empty)).toContain("DATA UNAVAILABLE");
    expect(render(PAYLOADS.empty)).toContain("NOT UPDATED");
    expect(render(PAYLOADS.empty)).toContain("VicEmergency data received unknown");
  });

  it("treats any other contract version as unavailable", () => {
    const t = text(render({ ...quiet, v: 2 }));
    expect(t).toContain("DATA UNAVAILABLE");
    expect(t).not.toMatch(RATING_WORDS);
  });
});

describe("freshness", () => {
  const live: PayloadV1 = { ...quiet, sample: false };

  it("shows the checked time on a fresh live render", () => {
    const html = render(live, trmnlAt(EPOCH + 3500));
    expect(html).toContain("Checked Sun 16:05");
    expect(html).not.toContain("SAMPLE");
    expect(html).not.toContain("OUT OF DATE");
  });

  it("flips to OUT OF DATE after an hour", () => {
    const html = render(live, trmnlAt(EPOCH + 3700));
    const t = text(html);
    expect(t).toContain("OUT OF DATE");
    expect(t).toContain("NOT UPDATED");
    expect(t).toContain("Last update: Sun 16:05");
    expect(t).toContain("Check the VicEmergency app");
    expect(t).not.toMatch(RATING_WORDS);
    expect(t).not.toContain("Checked Sun 16:05");
  });

  it("is OUT OF DATE when the payload has no generated time", () => {
    const { generated_epoch: _drop, ...rest } = live;
    expect(render(rest, trmnlAt(EPOCH))).toContain("OUT OF DATE");
  });

  it("does not age sample data, which is watermarked instead", () => {
    const html = render(quiet, trmnlAt(EPOCH + 86_400));
    expect(html).not.toContain("OUT OF DATE");
    expect(html).toContain("SAMPLE DATA · NOT LIVE · Checked Sun 16:05");
    expect(html).toContain("SAMPLE · FIRE DANGER TODAY · CENTRAL");
  });

  it("falls back to the plugin name when TRMNL sends no instance name", () => {
    expect(render(quiet, trmnlAt(EPOCH, null))).toContain('<span class="title">Bushfire Watch</span>');
  });
});

describe("safety states", () => {
  it("never shows counts or zeros when incidents are unavailable", () => {
    const html = render(incidentsDown);
    const t = text(html);
    expect(t).toContain("INCIDENTS & WARNINGS UNAVAILABLE");
    expect(t).toContain("WARNINGS UNAVAILABLE");
    expect(t).toContain(incidentsDown.incidents.error_text!);
    expect(html).not.toContain("fw-count");
    expect(t).not.toMatch(ZERO_CLAIM);
    expect(t).toContain("HIGH");
  });

  it("ignores counts and rows sent alongside ok: false", () => {
    const html = render({ ...incidentsDown, incidents: { ...busy.incidents, ok: false } });
    expect(html).not.toContain("fw-count");
    expect(html).not.toContain("EMERGENCY WARNING");
    expect(text(html)).toContain("INCIDENTS & WARNINGS UNAVAILABLE");
  });

  it("flags warnings unavailable when the house is 'clear' but incidents are not ok", () => {
    const html = render({ ...quiet, house: { status: "clear" }, incidents: { ...incidentsDown.incidents } });
    expect(band(html)).toContain("WARNINGS UNAVAILABLE");
  });

  it("gives the band to a warning over the house and keeps the rating", () => {
    const html = render(houseEW);
    const b = band(html);
    expect(b).toContain("EMERGENCY WARNING");
    expect(b).toContain("YOU ARE IN A WARNING AREA · BUSHFIRE");
    expect(b).toContain("TAKE SHELTER NOW · Creightons Creek, Dropmore +9");
    expect(b).toContain("Today: CATASTROPHIC");
    expect(b).toContain("TOTAL FIRE BAN");
    expect(b).toContain("FBI 104 · BoM Tue 16:00");
    // The rating's note and the pill leave one line for the instruction.
    expect(b).toContain(">Follow the warning.</span>");
    expect(mid(html)).toContain('<span class="label label--filled">CATASTROPHIC</span>');
    expect(mid(html)).toContain("TODAY · WED 28 JAN");
  });

  it("encodes the house warning's rank by ink", () => {
    expect(band(render(houseEW))).toMatch(/fw-band fw-f4 p--1[\s\S]*inverse px--2 py--1/);
    expect(band(render(sample))).toContain("fw-band inverse p--2");
    // On a MODERATE day; on an Extreme or Catastrophic day the rating's heavier ink wins (fix-template.test.ts).
    const advice = render({ ...houseEW, days: quiet.days, house: { ...houseEW.house, rank: 1, level: "ADVICE" } });
    expect(band(advice)).toContain("fw-band fw-f4 p--2");
    expect(band(advice)).toContain("value value--large");
  });

  it("encodes today's rating by ink and meter", () => {
    const at = (level: -1 | 0 | 1 | 2 | 3 | 4, word: string) =>
      band(render({ ...quiet, days: [{ ...quiet.days[0], fdr: { ...quiet.days[0].fdr, level, word } }, quiet.days[1]] }));
    expect(at(4, "CATASTROPHIC")).toMatch(/fw-band fw-f4 p--1[\s\S]*inverse px--2 py--1/);
    expect(at(3, "EXTREME")).toContain("fw-band inverse p--2");
    expect(at(2, "HIGH")).toContain("fw-band fw-f4 p--2");
    expect(at(1, "MODERATE")).toContain("fw-band fw-f1 p--2");
    expect(at(0, "NO RATING")).toContain("fw-band fw-f1 p--2");
    expect(at(-1, "RATING UNAVAILABLE")).toContain("fw-band fw-fd p--2");
    expect(at(-1, "RATING UNAVAILABLE")).not.toContain("fw-seg");
    expect(at(3, "EXTREME").match(/fw-seg fw-fill/g)).toHaveLength(3);
    expect(at(0, "NO RATING").match(/fw-seg fw-fill/g)).toBeNull();
  });

  it("keeps NO RATING and NO RATING ISSUED (both level 0) distinct from unavailable", () => {
    const html = render(quiet);
    expect(html).toContain('<span class="label fw-f1 px--1">NO RATING</span>');
    const unavailable = render(PAYLOADS.ratingUnavailable);
    expect(band(unavailable)).toContain("RATING UNAVAILABLE");
    expect(band(unavailable)).toContain("fw-band fw-fd p--2");
    expect(mid(unavailable)).toContain('<span class="label fw-fd px--1" data-clamp="1">RATING UNAVAILABLE</span>');
    expect(mid(unavailable)).toContain('<span class="label fw-f1 px--1">NO RATING ISSUED</span>');
  });

  it("shows TFB states in their own ink", () => {
    const html = render(busy);
    expect(band(html)).toContain('<span class="label label--large label--filled">TOTAL FIRE BAN</span>');
    expect(html).toContain("No TFB declared yet");
    expect(band(render(quiet))).toContain("No TFB · restrictions may apply");
    expect(band(render(PAYLOADS.ratingUnavailable))).toContain('fw-fd px--1" data-clamp="1">TFB status unavailable');
  });

  it("says 'Forecast unavailable' instead of zero weather", () => {
    const t = text(render(PAYLOADS.ratingUnavailable));
    expect(t).toContain("Forecast unavailable");
    expect(t).not.toMatch(/\b0°|\b0%/);
  });

  it("shows indicators only when present", () => {
    const html = render(quiet);
    expect(html).not.toContain("label--filled");
    expect(html).toContain('<span class="label" data-clamp="1">S change ~13:00</span>');
    expect(render(busy)).toContain('<span class="label label--filled" data-clamp="1">Wind change danger</span>');
  });

  it("marks stale incidents with a filled chip", () => {
    const html = render(PAYLOADS.stale);
    expect(html).toContain('<span class="label label--small label--filled" data-clamp="1">OLD DATA · 15:20</span>');
    const noRows = render({ ...PAYLOADS.stale, incidents: { ...PAYLOADS.stale.incidents, rows: [] } });
    expect(noRows).toContain("Old data. Check the VicEmergency app");
  });

  it("lists rows with glyphs, severity bars and the UPWIND chip, at most five", () => {
    const html = render({ ...busy, incidents: { ...busy.incidents, rows: [...busy.incidents.rows!, busy.incidents.rows![0]!] } });
    expect(html.match(/class="fw-bar /g)).toHaveLength(5);
    expect(html).toContain("&#9632; 9.7 km NNW · EMERGENCY WARNING");
    expect(html).toContain("&#9679; 12 km NNW");
    expect(html).toContain("&#9675; 18 km ENE");
    expect(html).toContain("&#9633; 28 km SE");
    expect(render(houseEW)).toContain("&#215; 2 items not placed on the map");
    expect(html.match(/label--filled shrink-0">UPWIND/g)).toHaveLength(3);
    expect(html).toContain("fw-bar fw-fill");
    expect(html).toContain("fw-bar fw-f2");
    expect(html).toContain("fw-bar fw-f1");
  });

  it("shows the empty text with the nearest fire when nothing is listed", () => {
    expect(render(quiet)).toContain(quiet.incidents.empty_text!);
  });
});

describe("context lines", () => {
  it("puts statewide and neighbour lines in the incidents panel when there is room", () => {
    const html = render({ ...quiet, statewide: "Statewide: Extreme Heat Advice" });
    expect(mid(html)).toContain("Statewide: Extreme Heat Advice");
    expect(mid(html)).toContain("North Central: MODERATE · No TFB");
  });

  it("moves the neighbour line to the band beside five rows", () => {
    const html = render(busy);
    expect(band(html)).toContain(busy.neighbours);
    expect(band(html)).not.toContain(busy.statewide);
    expect(mid(html)).toContain(busy.statewide);
    expect(mid(html)).not.toContain(busy.neighbours);
  });

  it("keeps the statewide line beside a house warning with five rows when the neighbour is calm", () => {
    const html = render({ ...houseEW, neighbours: "North Central: HIGH · No TFB" });
    expect(html).toContain(houseEW.statewide);
    expect(html).not.toContain("North Central");
  });

  it("renders nothing for empty lines", () => {
    expect(render({ ...quiet, neighbours: "" })).not.toContain('<span class="description" data-clamp="1"></span>');
  });
});

describe("escaping", () => {
  const XSS = "<script>alert(1)</script>";

  it("escapes a row line and the house action", () => {
    const rows = [{ ...houseEW.incidents.rows![0]!, line2: XSS }];
    const html = render({ ...houseEW, house: { ...houseEW.house, action: XSS }, incidents: { ...houseEW.incidents, rows } });
    expect(html).not.toContain("<script");
    expect(html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g)).toHaveLength(2);
  });

  /** Every free-text leaf; enums stay valid so each branch is still exercised. */
  function inject(value: unknown, key = ""): unknown {
    if (typeof value === "string") return ["status", "state", "kind"].includes(key) ? value : `${XSS}"'&`;
    if (Array.isArray(value)) return value.map((v) => inject(v, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inject(v, k)]));
    }
    return value;
  }

  for (const name of ["busy", "houseEW", "incidentsDown", "down", "configError", "stale", "staleBusy", "quiet", "houseAdviceCat", "houseHeatCat", "staleAlarm", "neighbourAlarm"] as const) {
    it(`${name}: escapes every string field`, () => {
      const html = render(inject(PAYLOADS[name]));
      expect(html).not.toContain("<script");
      expect(html).not.toContain(`"'&`);
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&#34;&#39;&amp;");
    });
  }

  it("uses the literal attribution and disclaimer when the payload has none", () => {
    const { attribution: _a, disclaimer: _d, ...rest } = quiet;
    const html = render(rest);
    expect(html).toContain(ATTRIBUTION);
    expect(html).toContain(DISCLAIMER);
  });
});

describe("template lint (mirrors trmnlp and the design rules)", () => {
  it("avoids the inline-style words trmnlp counts, and opacity", () => {
    for (const word of [
      "padding",
      "margin",
      "background-color",
      "border-radius",
      "text-align",
      "object-fit",
      "font-size",
      "justify-content",
      "opacity",
    ]) {
      expect(source, word).not.toContain(word);
    }
    expect(source).not.toMatch(/style="/);
  });

  it("uses no .item rows, scripts, async code or view size classes", () => {
    expect(source).not.toMatch(/\.item\b|class="item|\sitem[\s"]/);
    expect(source).not.toMatch(/<script|async /);
    expect(source).not.toMatch(/view--/);
  });

  it("uses only glyphs the TRMNL fonts have", () => {
    expect(source).not.toMatch(/[▲△▼◆◇⚠★☆]|&#(9650|9651|9660|9670|9671|9888|9733|9734);/);
  });

  it("never compares with blank or empty, which plain Ruby Liquid gets wrong for '' and nil", () => {
    expect(source).not.toMatch(/(==|!=|<>)\s*(blank|empty)\b/);
  });

  it("uses no grey classes", () => {
    expect(source).not.toMatch(/\b(bg|text|border)--gray|\bgray-\d|dither/);
  });

  it("escapes every payload output", () => {
    const outputs = source.match(/{{[^}]*}}/g) ?? [];
    const unescaped = outputs.filter((o) => !/\|\s*escape\s*}}$/.test(o));
    // Only the template's own glyph entities and class-name variables are printed raw.
    for (const o of unescaped) expect(o).toMatch(/^{{ (g|band_outer|band_inner|warn_outer|warn_inner|down_size) }}$/);
  });
});

describe("previewHtml", () => {
  const cases = Object.entries(PAYLOADS).map(([name, payload]) => ({ name, payload }));
  const hostile = { name: "hostile </script><script>alert(1)</script>", payload: { ...quiet, district: "</script><!--" } };
  const page = previewHtml(source, [...cases, hostile]);

  it("names every case and loads the pinned framework and LiquidJS", () => {
    for (const c of cases) expect(page).toContain(JSON.stringify(c.name).slice(1, -1));
    expect(page).toContain('href="https://trmnl.com/css/3.3.2/plugins.css"');
    expect(page).toContain('src="https://trmnl.com/js/3.3.2/plugins.js"');
    expect(page).toContain("https://cdn.jsdelivr.net/npm/liquidjs@10.29.0/dist/liquid.browser.min.js");
    expect(page).toContain("screen screen--og_png screen--md screen--density-1x screen--1bit");
    expect(page).toContain("__fwAudit");
  });

  it("keeps the embedded JSON inside its script tags", () => {
    const blocks = [...page.matchAll(/<script type="application\/json" id="([^"]+)">([\s\S]*?)<\/script>/g)];
    expect(blocks.map((b) => b[1])).toEqual(["fw-template", "fw-cases"]);
    for (const b of blocks) {
      expect(b[2]).not.toMatch(/<\/script|<!--/i);
    }
    expect(JSON.parse(blocks[0]![2]!)).toBe(source);
    const parsedCases = JSON.parse(blocks[1]![2]!) as { name: string }[];
    expect(parsedCases.map((c) => c.name)).toEqual([...cases.map((c) => c.name), hostile.name]);
  });

  it("offers the 2-bit OG screen", () => {
    expect(previewHtml(source, cases, { bits: 2 })).toContain("screen screen--ogv2 screen--md screen--density-1x screen--2bit");
  });
});

describe("sample payloads stay within the Worker's character budgets", () => {
  const max = (s: string | undefined, n: number, what: string) => expect((s ?? "").length, `${what}: ${s}`).toBeLessThanOrEqual(n);
  for (const [name, p] of Object.entries(PAYLOADS)) {
    if (!p.ok) continue;
    it(name, () => {
      max(p.checked_local, 12, "checked_local");
      max(p.feed_received_local, 16, "feed_received_local");
      max(p.district, 24, "district");
      max(p.neighbours, 38, "neighbours");
      max(p.statewide, 56, "statewide");
      max(p.house.kicker, 36, "kicker");
      max(p.house.level, 17, "level");
      max(p.house.action, 48, "house.action");
      max(p.house.issued, 24, "issued");
      for (const d of p.days) {
        max(d.label, 18, "label");
        max(d.fdr.action, 46, "fdr.action");
        max(d.fdr.issued, 34, "fdr.issued");
        max(d.tfb.text, 31, "tfb.text");
        max(d.wx.temps, 11, "temps");
        for (const k of ["rh", "wind", "change", "rain"] as const) max(d.wx[k], 18, k);
        max(d.wx.text, 28, "wx.text");
        max(d.wx.src, 28, "wx.src");
        max(d.wx.src_short, 23, "wx.src_short");
      }
      max(p.incidents.heading, 14, "heading");
      max(p.incidents.as_at, 24, "as_at");
      max(p.incidents.empty_text, 80, "empty_text");
      max(p.incidents.error_text, 80, "error_text");
      for (const c of p.incidents.counts ?? []) {
        max(c.n, 3, "n");
        max(c.label, 11, "count label");
      }
      for (const r of p.incidents.rows ?? []) {
        max(r.line1, r.upwind ? 32 : 38, "line1");
        max(r.line2, 56, "line2");
      }
    });
  }
});
