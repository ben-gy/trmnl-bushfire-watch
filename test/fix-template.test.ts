/**
 * The template fixes from the adversarial review: the rating's ink and AFDRS action inside a house
 * band [3], an alarming neighbour line outranking the statewide line [17], the checked time on
 * error screens [18], the rating's note in every place the rating is shown [19], declared pills
 * that print the Worker's text ("TOTAL FIRE BAN · as of 14:05", contract c3), hand-made payloads
 * that match what the Worker emits (c4), and the setup notes for the token and location [22–24].
 * From the final review: today's AFDRS action beside a Watch and Act (f0), a stale events feed's
 * clear house marked as old in the band (f1), and a model source line in every weather column (f2).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Liquid } from "liquidjs";
import { describe, expect, it } from "vitest";
import { downPayload } from "../src/payload.js";
import { previewHtml } from "../src/preview.js";
import { AFDRS_ACTION, buildRatings, neighbourLine, type RatingInputs } from "../src/ratings.js";
import type { BomFdr, Day, DistrictKey, PayloadV1, RatingsFeed, SourceResult } from "../src/types.js";
import {
  EPOCH,
  PAYLOADS,
  busy,
  configError,
  down,
  houseAdviceCat,
  houseEW,
  houseHeatCat,
  incidentsDown,
  neighbourAlarm,
  quiet,
  ratingUnavailable,
  sample,
  stale,
  staleAlarm,
  staleBusy,
} from "./payloads.js";

const file = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const source = file("../plugin/src/full.liquid");
const engine = new Liquid({ strictFilters: true });
const parsed = engine.parse(source);

function render(payload: unknown, ageS = 60): string {
  const p = (payload ?? {}) as Partial<PayloadV1>;
  const trmnl = {
    system: { timestamp_utc: (p.generated_epoch ?? EPOCH) + ageS },
    plugin_settings: { instance_name: "North Warrandyte" },
    user: { time_zone_iana: "Australia/Melbourne" },
  };
  return engine.renderSync(parsed, { ...p, trmnl }) as string;
}

const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const band = (html: string) => html.slice(html.indexOf('class="fw-band'), html.indexOf('fw-mid">'));
const mid = (html: string) => html.slice(html.indexOf('fw-mid">'));
/** One day column of the mid row (0 today, 1 tomorrow). */
const column = (html: string, n: 0 | 1) => mid(html).split('<div class="col--span-')[n + 1] ?? "";
/** The incidents panel, where the statewide and neighbour lines sit. */
const panel = (html: string) => mid(html).split('<div class="col--span-6')[1] ?? "";
const titleBar = (html: string) => html.slice(html.indexOf('<div class="title_bar">'));

const ACTION = {
  cat: "For your survival, leave bushfire risk areas",
  ext: "Take action now to protect life and property",
};

function withToday(p: PayloadV1, fdr: Partial<Day["fdr"]>, tfb?: Day["tfb"]): PayloadV1 {
  const d0 = { ...p.days[0], fdr: { ...p.days[0].fdr, ...fdr }, tfb: tfb ?? p.days[0].tfb };
  return { ...p, days: [d0, p.days[1]] };
}

const RATING: Record<number, Day["fdr"]> = {
  [-1]: { level: -1, word: "RATING UNAVAILABLE", action: "Check emergency.vic.gov.au or VicEmergency app", issued: "" },
  0: { level: 0, word: "NO RATING", action: AFDRS_ACTION["NO RATING"], issued: "" },
  1: { level: 1, word: "MODERATE", action: AFDRS_ACTION.MODERATE, issued: "" },
  2: { level: 2, word: "HIGH", action: AFDRS_ACTION.HIGH, issued: "" },
  3: { level: 3, word: "EXTREME", action: AFDRS_ACTION.EXTREME, issued: "" },
  4: { level: 4, word: "CATASTROPHIC", action: AFDRS_ACTION.CATASTROPHIC, issued: "" },
};

// ---------------------------------------------------------------------------------------------

describe("[3] a warning over the house keeps the rating's ink and action", () => {
  it("Advice on a CATASTROPHIC TFB day: double rule and inverted, today's AFDRS action, no generic line", () => {
    const b = band(render(houseAdviceCat));
    expect(b).toMatch(/^class="fw-band fw-f4 p--1">\s*<div class="h--full inverse px--2 py--1 /);
    expect(b).toContain("ADVICE");
    expect(b).toContain("THREAT IS REDUCED · Kinglake, Pheasant Creek +3");
    expect(b).toContain("Today: CATASTROPHIC");
    expect(b).toContain(`<span class="description" data-clamp="2">${ACTION.cat}</span>`);
    expect(b).not.toContain("Follow the warning");
    // The note and the pill are both there, so the issued time and the pill take the small size.
    expect(b).toContain('<span class="label label--small" data-clamp="1">Issued 16:58 · +1 more</span>');
    expect(b).toContain('<span class="label label--small label--filled">TOTAL FIRE BAN</span>');
    expect(b).toContain("FBI 104 · BoM Fri 05:30");
  });

  it("Advice or Community Update on an EXTREME day: inverted, with the Extreme action", () => {
    for (const rank of [0, 1] as const) {
      const p = withToday({ ...houseAdviceCat, house: { ...houseAdviceCat.house, rank } }, RATING[3]!);
      const b = band(render(p));
      expect(b).toMatch(/^class="fw-band inverse p--2">\s*<div class="h--full  flex/);
      expect(b).toContain(ACTION.ext);
      expect(b).not.toContain("Follow the warning");
    }
  });

  it("Advice on a HIGH or lower day keeps the warning's own ink and the generic instruction", () => {
    for (const lvl of [-1, 0, 1, 2]) {
      const b = band(render(withToday(houseAdviceCat, RATING[lvl]!, { state: "none", text: "No TFB · restrictions may apply" })));
      expect(b, `level ${lvl}`).toContain("fw-band fw-f4 p--2");
      expect(b).toContain("Follow the warning. Check the VicEmergency app now.");
      expect(b).not.toMatch(/Plan and prepare|Be ready to act/);
    }
  });

  it("the heavier ink wins: a Watch and Act on a CATASTROPHIC day takes the double rule, and today's action", () => {
    const b = band(render(withToday(sample, RATING[4]!)));
    expect(b).toMatch(/^class="fw-band fw-f4 p--1">\s*<div class="h--full inverse px--2 py--1 /);
    expect(b).toContain("WATCH AND ACT");
    // The pill leaves no room for the generic line as well (f0).
    expect(b).toContain(ACTION.cat);
    expect(b).not.toContain("Follow the warning");
    // A Watch and Act on an EXTREME day is the same ink either way.
    expect(band(render(sample))).toContain("fw-band inverse p--2");
    // An Emergency Warning is never lightened by a lower rating.
    expect(band(render(withToday(houseEW, RATING[1]!)))).toMatch(/fw-band fw-f4 p--1[\s\S]*inverse px--2 py--1/);
  });

  it("beside a Watch and Act or Emergency Warning, the generic line and the AFDRS action when both fit", () => {
    // No note and no pill: the long generic line and the action both fit.
    const roomy = band(render(withToday(sample, { issued: "" }, { state: "none", text: "No TFB · restrictions may apply" })));
    expect(roomy).toContain("Follow the warning. Check the VicEmergency app now.");
    expect(roomy).toContain(ACTION.ext);
    // A note only: the short generic line and the action.
    const note = band(render(withToday(sample, {}, { state: "none", text: "No TFB · restrictions may apply" })));
    expect(note).toContain(">Follow the warning.</span>");
    expect(note).toContain(ACTION.ext);
    // A note and a pill: an Emergency Warning keeps one line, the generic instruction…
    const full = band(render(houseEW));
    expect(full).toContain(">Follow the warning.</span>");
    expect(full).not.toContain(ACTION.cat);
    // …and a Watch and Act gives today's action in its place (f0).
    const wa = band(render(sample));
    expect(wa).toContain(`<span class="description" data-clamp="2">${ACTION.ext}</span>`);
    expect(wa).not.toContain("Follow the warning");
  });

  /**
   * The right column is 224 × 96 px at worst. Heights measured in Chrome with the 3.3.2 CSS (the
   * /preview audit is the real gate): label 20, small label 14, pill 22, small pill 14, 12 a
   * description line, 2 px gaps.
   */
  function rightColumnPx(html: string): { px: number; items: string[] } {
    const start = html.indexOf('<div class="shrink-0 w--56');
    const body = html.slice(start, html.indexOf('<div class="grid grid--cols-12 fw-mid">', start));
    const items = body
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("<span") || l.startsWith('<div class="flex flex--row'));
    let px = 0;
    for (const l of items) {
      const cls = /class="([^"]*)"/.exec(l.startsWith("<div") ? l.slice(l.indexOf("<span")) : l)![1]!;
      if (cls.includes("description")) px += 12 * Number(/data-clamp="(\d)"/.exec(l)?.[1] ?? 1);
      else if (cls.includes("label--small")) px += 14;
      else if (cls.includes("label--filled")) px += 22;
      else px += 20;
    }
    return { px: px + 2 * (items.length - 1), items };
  }

  it("every rank × rating × note × ban combination fits the right column, and the action appears whenever a rank ≤ 2 band carries an Extreme+ rating", () => {
    const notes = ["", "LAST KNOWN 14:05 · EMV/CFA: HIGH"];
    const bans: Day["tfb"][] = [
      { state: "none", text: "No TFB · restrictions may apply" },
      { state: "declared", text: "TOTAL FIRE BAN" },
      { state: "declared", text: "TOTAL FIRE BAN · as of 14:05" },
      { state: "unknown", text: "TFB status unavailable" },
    ];
    let n = 0;
    for (const rank of [0, 1, 2, 3] as const)
      for (const lvl of [-1, 0, 1, 2, 3, 4])
        for (const issued of notes)
          for (const tfb of bans) {
            const p = withToday({ ...houseEW, house: { ...houseEW.house, rank } }, { ...RATING[lvl]!, issued: lvl < 0 ? "" : issued }, tfb);
            const html = render(p);
            const { px, items } = rightColumnPx(html);
            const what = `rank ${rank} level ${lvl} note ${issued ? "yes" : "no"} ${tfb.text}`;
            expect(px, `${what}: ${items.join(" | ")}`).toBeLessThanOrEqual(96);
            const b = band(html);
            if (rank <= 2 && lvl >= 3) expect(b, what).toContain(RATING[lvl]!.action);
            if (rank === 3 || lvl < 3) expect(b, what).toContain("Follow the warning");
            // A Watch and Act keeps the generic line too while the pill leaves room for both (f0).
            if (rank === 2 && lvl >= 3) expect(b.includes("Follow the warning"), what).toBe(tfb.state !== "declared");
            if (rank <= 1 && lvl >= 3) expect(b, what).not.toContain("Follow the warning");
            if (issued && lvl >= 0) expect(b, what).toContain(issued);
            if (tfb.state === "declared") expect(b, what).toContain(`label--filled">${tfb.text}</span>`);
            n++;
          }
    expect(n).toBe(192);
  });
});

// ---------------------------------------------------------------------------------------------

describe("[17] an alarming neighbour outranks the statewide line", () => {
  it("house warning, five rows, statewide and a neighbour at EXTREME under a ban: the neighbour takes the slot", () => {
    const html = render(neighbourAlarm);
    expect(panel(html)).toContain("Central: EXTREME · TOTAL FIRE BAN");
    expect(html).not.toContain(neighbourAlarm.statewide);
    expect(band(html)).not.toContain("Central: EXTREME");
  });

  it("each alarm form wins; calm and unknown forms do not", () => {
    const at = (neighbours: string) => render({ ...neighbourAlarm, neighbours });
    for (const line of [
      "North Central: CATASTROPHIC · TFB",
      "North Central: CATASTROPHIC · No TFB",
      "North Central: EXTREME · No TFB yet",
      "North Central: HIGH · TFB",
      "North Central: MODERATE · TOTAL FIRE BAN",
      "W&S Gippsland: CATASTROPHIC · TFB",
    ]) {
      const html = at(line);
      expect(panel(html), line).toContain(line.replace("&", "&amp;"));
      expect(html, line).not.toContain(neighbourAlarm.statewide);
    }
    for (const line of ["North Central: HIGH · No TFB", "North Central: HIGH · TFB n/a", "North Central: HIGH · TFB unclear", "North Central: RATING N/A · No TFB yet"]) {
      const html = at(line);
      expect(html, line).not.toContain(line);
      expect(panel(html), line).toContain(neighbourAlarm.statewide);
    }
  });

  it("still uses the band's free slot first, so both lines stay (busy: five rows, house clear)", () => {
    const html = render(busy);
    expect(band(html)).toContain(busy.neighbours);
    expect(panel(html)).toContain(busy.statewide);
  });

  it("with room for both (four rows) nothing is dropped", () => {
    const rows = neighbourAlarm.incidents.rows!.slice(0, 4);
    const html = render({ ...neighbourAlarm, incidents: { ...neighbourAlarm.incidents, rows } });
    expect(panel(html)).toContain(neighbourAlarm.statewide);
    expect(panel(html)).toContain(neighbourAlarm.neighbours);
  });
});

// ---------------------------------------------------------------------------------------------

describe("[18] error screens keep their checked time", () => {
  const live = <T extends object>(p: T) => ({ ...p, sample: false });

  it("DATA UNAVAILABLE and CONFIGURATION ERROR, built this minute, say 'Checked' in the title bar and the body", () => {
    for (const p of [down, configError]) {
      const html = render(live(p));
      expect(titleBar(html)).toContain("Checked Sun 16:05");
      expect(titleBar(html)).not.toContain("NOT UPDATED");
      const body = text(html.slice(0, html.indexOf('<div class="title_bar">')));
      expect(body).toContain("Checked Sun 16:05");
    }
    expect(text(render(live(down)))).toContain("Checked Sun 16:05 · Last successful update: Sun 13:52");
  });

  it("the sample watermark keeps the checked time on an error screen", () => {
    expect(titleBar(render(configError))).toContain("SAMPLE DATA · NOT LIVE · Checked Sun 16:05");
  });

  it("only OUT OF DATE, or a payload without a time, says NOT UPDATED", () => {
    const old = render(live(quiet), 3700);
    expect(titleBar(old)).toContain("NOT UPDATED");
    expect(text(old)).not.toContain("Checked Sun 16:05");
    expect(text(old)).toContain("Last update: Sun 16:05");
    const { checked_local: _c, ...noTime } = live(down);
    expect(titleBar(render(noTime))).toContain("NOT UPDATED");
    expect(titleBar(render(PAYLOADS.empty))).toContain("NOT UPDATED");
    expect(render(noTime)).not.toContain("Checked");
  });

  it("the Worker's own down payload renders its checked time", () => {
    const now = (EPOCH + 30) * 1000;
    const html = render(downPayload(now, { title: "LOCATION NOT VALID", reason: "Latitude must be negative (south of the equator)." }));
    expect(titleBar(html)).toContain("Checked Sun 16:05");
    expect(text(html)).toContain("LOCATION NOT VALID");
  });
});

// ---------------------------------------------------------------------------------------------

describe("[19] the rating's note is shown wherever the rating is", () => {
  it("tomorrow's disagreement note sits above the short weather source line (f2)", () => {
    const col = column(render(busy), 1);
    expect(col).toContain('<span class="description" data-clamp="1">BoM: HIGH · EMV: MOD · FBI 38</span>');
    expect(col).not.toContain(busy.days[1].wx.src!);
    expect(col).toContain('<span class="description" data-clamp="1">Model · BoM</span>');
  });

  it("today's FBI note sits under today's tag; the full source line returns when there is no note", () => {
    const html = render(quiet);
    expect(column(html, 0)).toContain("FBI 12 · BoM Sun 05:30");
    expect(column(html, 0)).not.toContain("Open-Meteo model");
    expect(column(html, 0)).toContain('<span class="description" data-clamp="1">Model</span>');
    const bare = render(withToday(quiet, { issued: "" }));
    expect(column(bare, 0)).toContain('<span class="description" data-clamp="1">Open-Meteo model</span>');
    expect(band(bare)).not.toContain('<span class="description" data-clamp="1"></span>');
  });

  it("the note shows beside 'Forecast unavailable' too", () => {
    const p = { ...ratingUnavailable, days: [ratingUnavailable.days[0], { ...ratingUnavailable.days[1], fdr: { ...ratingUnavailable.days[1].fdr, issued: "BoM: HIGH · EMV: MOD" } }] } as PayloadV1;
    const col = column(render(p), 1);
    expect(col).toContain("BoM: HIGH · EMV: MOD");
    expect(col).toContain("Forecast unavailable");
  });

  it("the house band's right column shows today's note", () => {
    expect(band(render(houseEW))).toContain('<span class="description" data-clamp="1">FBI 104 · BoM Tue 16:00</span>');
    expect(band(render(withToday(houseEW, { issued: "LAST KNOWN 14:05" })))).toContain("LAST KNOWN 14:05");
  });

  it("a stale alarm is labelled LAST KNOWN in the band and both columns", () => {
    const html = render(staleAlarm);
    expect(band(html)).toContain("LAST KNOWN 14:05");
    expect(column(html, 0)).toContain("LAST KNOWN 14:05");
    expect(column(html, 1)).toContain("LAST KNOWN 14:05");
    expect(band(html)).toContain("EXTREME");
    expect(column(html, 1)).toContain("CATASTROPHIC");
  });
});

// ---------------------------------------------------------------------------------------------

describe("(c3) declared pills print the Worker's text", () => {
  const AS_OF = "TOTAL FIRE BAN · as of 14:05";

  it("a ban known only from a stale copy says so in the band and both columns, at the smaller sizes", () => {
    const html = render(staleAlarm);
    expect(band(html)).toContain(`<span class="label label--filled">${AS_OF}</span>`);
    for (const n of [0, 1] as const) {
      expect(column(html, n)).toContain(`<span class="label label--small label--filled" data-clamp="1">${AS_OF}</span>`);
    }
    const house = band(render(withToday(houseEW, { issued: "LAST KNOWN 14:05" }, { state: "declared", text: AS_OF })));
    expect(house).toContain(`<span class="label label--small label--filled">${AS_OF}</span>`);
  });

  it("a current ban keeps the full-size pills", () => {
    const html = render(busy);
    expect(band(html)).toContain('<span class="label label--large label--filled">TOTAL FIRE BAN</span>');
    expect(column(html, 0)).toContain('<span class="label label--filled" data-clamp="1">TOTAL FIRE BAN</span>');
    expect(band(render(houseEW))).toContain('<span class="label label--filled">TOTAL FIRE BAN</span>');
  });

  it("a declared state with no text still says TOTAL FIRE BAN", () => {
    const p = withToday(quiet, {}, { state: "declared", text: "" });
    const html = render({ ...p, days: [p.days[0], { ...p.days[1], tfb: { state: "declared", text: "" } }] });
    expect(band(html)).toContain('label--large label--filled">TOTAL FIRE BAN</span>');
    expect(column(html, 1)).toContain('label--filled" data-clamp="1">TOTAL FIRE BAN</span>');
  });

  it("no pill hard-codes its text", () => {
    expect(source).not.toMatch(/label--filled[^"]*"[^>]*>TOTAL FIRE BAN</);
  });
});

// ---------------------------------------------------------------------------------------------

describe("(c4) the hand-made payloads are ones the Worker emits", () => {
  const TODAY = "2026-09-27";
  const TOMORROW = "2026-09-28";
  const NOW = EPOCH * 1000;
  const at = (iso: string) => Date.parse(iso);

  const feed = (fdr: RatingsFeed["fdr"], tfb: RatingsFeed["tfb"]): RatingsFeed => ({ fdr, tfb, declaration: {}, notYet: [], issued: {} });
  function src<T>(id: SourceResult<T>["id"], data: T | null, state: SourceResult<T>["state"] = "ok", asOf: number | null = NOW): SourceResult<T> {
    return { id, state: data ? state : "unavailable", data, asOf: data ? asOf : null, fetchedAt: NOW, error: data ? null : "http 503" };
  }
  function inputs(o: { osom?: SourceResult<RatingsFeed>; bom?: BomFdr | null; district?: DistrictKey }): RatingInputs {
    return {
      dates: [TODAY, TOMORROW],
      now: NOW,
      district: o.district ?? "central",
      osom: o.osom ?? src<RatingsFeed>("osom", null),
      conditions: src<RatingsFeed>("events", null),
      cfa: src<RatingsFeed>("cfa", null),
      bomFdr: src<BomFdr>("bom_fdr", o.bom ?? null),
      areaStatuses: [],
    };
  }
  const NO = "NO - RESTRICTIONS MAY APPLY";
  const YES = "YES - TOTAL FIRE BAN IN FORCE";

  it("quiet: MODERATE with BoM's FBI, then NO RATING (level 0), no ban today and none declared yet tomorrow", () => {
    const osom = src("osom", feed({ [TODAY]: { central: "MODERATE" }, [TOMORROW]: { central: "NO FORECAST" } }, { [TODAY]: { central: NO }, [TOMORROW]: { central: NO } }));
    const bom: BomFdr = {
      issued: at("2026-09-27T06:00:00Z"),
      nextIssue: null,
      days: {
        central: {
          [TODAY]: { rating: "Moderate", fbi: 12, issued: at("2026-09-26T19:30:00Z") },
          [TOMORROW]: { rating: "No Rating", fbi: 8, issued: at("2026-09-27T06:00:00Z") },
        },
      },
    };
    const [d0, d1] = buildRatings(inputs({ osom, bom }));
    expect(d0).toEqual({ fdr: quiet.days[0].fdr, tfb: quiet.days[0].tfb });
    expect(d1).toEqual({ fdr: quiet.days[1].fdr, tfb: quiet.days[1].tfb });
  });

  it("ratingUnavailable: no rating for today is -1; an unconfirmed NO FORECAST is NO RATING ISSUED at level 0", () => {
    const osom = src("osom", feed({ [TOMORROW]: { central: "NO FORECAST" } }, { [TOMORROW]: { central: NO } }));
    const [d0, d1] = buildRatings(inputs({ osom }));
    expect(d0).toEqual({ fdr: ratingUnavailable.days[0].fdr, tfb: ratingUnavailable.days[0].tfb });
    expect(d1).toEqual({ fdr: ratingUnavailable.days[1].fdr, tfb: ratingUnavailable.days[1].tfb });
    expect(d1.fdr.level).toBe(0);
  });

  it("busy: tomorrow's disagreement note has the Worker's format", () => {
    const osom = src("osom", feed({ [TOMORROW]: { central: "MODERATE" } }, { [TOMORROW]: { central: NO } }));
    const bom: BomFdr = { issued: at("2026-09-27T06:00:00Z"), nextIssue: null, days: { central: { [TOMORROW]: { rating: "High", fbi: 38, issued: at("2026-09-27T06:00:00Z") } } } };
    const [, d1] = buildRatings(inputs({ osom, bom }));
    expect(d1).toEqual({ fdr: busy.days[1].fdr, tfb: busy.days[1].tfb });
  });

  it("staleAlarm: a 2 h old copy's EXTREME / CATASTROPHIC and bans are LAST KNOWN and 'as of'", () => {
    const osom = src(
      "osom",
      feed({ [TODAY]: { central: "EXTREME" }, [TOMORROW]: { central: "CATASTROPHIC" } }, { [TODAY]: { central: YES }, [TOMORROW]: { central: YES } }),
      "stale",
      at("2026-09-27T04:05:00Z"),
    );
    const [d0, d1] = buildRatings(inputs({ osom }));
    expect(d0).toEqual({ fdr: staleAlarm.days[0].fdr, tfb: staleAlarm.days[0].tfb });
    expect(d1).toEqual({ fdr: staleAlarm.days[1].fdr, tfb: staleAlarm.days[1].tfb });
  });

  it("neighbour lines are the Worker's", () => {
    const osom = src(
      "osom",
      feed({ [TODAY]: { north_central: "CATASTROPHIC", central: "EXTREME" } }, { [TODAY]: { north_central: YES, central: YES } }),
    );
    const i = inputs({ osom });
    expect(neighbourLine("north_central", TODAY, i)).toBe(busy.neighbours);
    expect(neighbourLine("north_central", TODAY, i)).toBe(houseEW.neighbours);
    expect(neighbourLine("central", TODAY, i)).toBe(neighbourAlarm.neighbours);
  });

  it("the full-screen payloads have downPayload's shape", () => {
    const now = (EPOCH + 30) * 1000;
    const w = downPayload(now, { title: "DATA UNAVAILABLE", reason: "x", lastGood: now, received: "Sun 13:52" });
    for (const p of [down, configError]) {
      expect(Object.keys(p).filter((k) => p[k as keyof PayloadV1] !== undefined).sort()).toEqual(
        [...Object.keys(w), "sample"].filter((k) => !(k === "last_good_local" && p === configError)).sort(),
      );
      expect(p.days).toEqual(w.days);
      expect(p.incidents).toEqual(w.incidents);
      expect(p.house).toEqual(w.house);
    }
    expect(down.attribution).toBe(w.attribution);
  });

  const LIVE = Object.entries(PAYLOADS).filter(([, p]) => (p as PayloadV1).ok === true) as [string, PayloadV1][];

  for (const [name, p] of LIVE) {
    it(`${name}: every rating, ban, row and weather string has a shape the Worker emits`, () => {
      const actions = new Set([...Object.values(AFDRS_ACTION), "Check emergency.vic.gov.au or VicEmergency app", "District unknown – set it in plugin settings"]);
      p.days.forEach((d, n) => {
        const f = d.fdr;
        if (/^NO RATING( ISSUED)?$/.test(f.word)) expect(f).toMatchObject({ level: 0, action: AFDRS_ACTION["NO RATING"] });
        if (f.level < 0) expect(f.word).toBe("RATING UNAVAILABLE");
        expect(actions.has(f.action), f.action).toBe(true);
        expect(f.issued).toMatch(/^$|^FBI \d+ · BoM \w{3} \d\d:\d\d$|^LAST KNOWN \d\d:\d\d( · .+)?$|^[A-Za-z/ ]+: [A-Z]+( · [A-Za-z/ ]+: [A-Z]+)*( · FBI \d+)?$/);
        const t = d.tfb;
        const ok: Record<Day["tfb"]["state"], RegExp> = {
          declared: /^TOTAL FIRE BAN( · as of \d\d:\d\d)?$/,
          none: /^No TFB · restrictions may apply$/,
          pending: /^No TFB declared yet$/,
          unknown: /^TFB status (unclear|unavailable)$/,
        };
        expect(t.text).toMatch(ok[t.state]);
        // Tomorrow's NO is never an all-clear.
        if (n === 1) expect(t.state).not.toBe("none");
        if (d.wx.ok && n === 1 && d.wx.change) expect(d.wx.change_flag).toBe(true);
        // src_short is src's "Model…" form: same window, same BoM marker.
        if (d.wx.ok) {
          expect(d.wx.src).toMatch(/^(Open-Meteo model|Model)( (from|to) \d\d:00| \d\d:00–\d\d:00)?( · BoM)?$/);
          expect(d.wx.src_short).toBe(d.wx.src!.replace(/^Open-Meteo model/, "Model"));
        }
      });
      for (const r of p.incidents.rows ?? []) {
        expect(r.line1).toMatch(/^(IN AREA|~?(\d\.\d|[1-9]\d+) km( [NESW]{1,3})?) · |^\d+ items? not placed on the map$/);
        if (r.kind === "fire") expect(r.sev).toBe(/^(Going|Not yet under control)/.test(r.line2) ? 3 : 2);
      }
      if (p.neighbours) expect(p.neighbours).toMatch(/^[A-Za-z&' ]+: [A-Z/ ]+ · (TOTAL FIRE BAN|TFB|No TFB|No TFB yet|TFB n\/a|TFB unclear)$/);
      if (p.statewide) expect(p.statewide).toMatch(/^Statewide: .+ \((Advice|Community update)\)( \+\d+)?$/);
    });
  }
});

// ---------------------------------------------------------------------------------------------

describe("(f0) a Watch and Act on an Extreme or Catastrophic day keeps today's AFDRS action", () => {
  const heatNote = houseHeatCat.days[0].fdr.issued;

  it("statewide Extreme Heat Watch and Act, CATASTROPHIC and a TFB, with and without a note", () => {
    for (const issued of [heatNote, ""]) {
      const b = band(render(withToday(houseHeatCat, { issued })));
      const what = `note ${issued ? "yes" : "no"}`;
      expect(b, what).toMatch(/^class="fw-band fw-f4 p--1">\s*<div class="h--full inverse px--2 py--1 /);
      expect(b, what).toContain("STATEWIDE WARNING · EXTREME HEAT");
      expect(b, what).toContain("WATCH AND ACT");
      expect(b, what).toContain("STAY INDOORS · Victoria");
      expect(b, what).toContain("Today: CATASTROPHIC");
      expect(b, what).toContain('label--filled">TOTAL FIRE BAN</span>');
      expect(b, what).toContain(`<span class="description" data-clamp="2">${ACTION.cat}</span>`);
      if (issued) expect(b, what).toContain(issued);
    }
  });

  it("the same on an EXTREME day with a TFB", () => {
    for (const issued of ["FBI 64 · BoM Thu 16:00", ""]) {
      const b = band(render(withToday(houseHeatCat, { ...RATING[3]!, issued })));
      expect(b).toMatch(/^class="fw-band inverse p--2">/);
      expect(b).toContain("Today: EXTREME");
      expect(b).toContain(`<span class="description" data-clamp="2">${ACTION.ext}</span>`);
    }
  });

  it("a local Watch and Act too, under a current or an 'as of' ban", () => {
    const smoke = { ...houseHeatCat.house, kicker: "YOU ARE IN A WARNING AREA · SMOKE", action: "STAY INDOORS · Kinglake, Pheasant Creek +3" };
    for (const tfb of [{ state: "declared", text: "TOTAL FIRE BAN" }, { state: "declared", text: "TOTAL FIRE BAN · as of 14:05" }] as Day["tfb"][])
      for (const lvl of [3, 4])
        for (const issued of ["LAST KNOWN 14:05 · EMV/CFA: HIGH", ""]) {
          const b = band(render(withToday({ ...houseHeatCat, house: smoke }, { ...RATING[lvl]!, issued }, tfb)));
          expect(b, `${tfb.text} level ${lvl} note ${issued ? "yes" : "no"}`).toContain(RATING[lvl]!.action);
        }
  });

  it("with the note and the pill, the issued time and the pill take the small size, as under an Advice", () => {
    const b = band(render(houseHeatCat));
    expect(b).toContain('<span class="label label--small" data-clamp="1">Issued 16:50</span>');
    expect(b).toContain('<span class="label label--small label--filled">TOTAL FIRE BAN</span>');
    expect(b).not.toContain("Follow the warning");
  });

  it("an Emergency Warning keeps the generic instruction first", () => {
    const b = band(render({ ...houseHeatCat, house: { ...houseHeatCat.house, rank: 3, level: "EMERGENCY WARNING" } }));
    expect(b).toContain(">Follow the warning.</span>");
    expect(b).not.toContain(ACTION.cat);
  });
});

// ---------------------------------------------------------------------------------------------

describe("(f1) an events feed 10–45 min old never reads as a fresh no-warning", () => {
  const CHIP = '<span class="label label--small fw-fd px--1">WARNINGS · OLD DATA</span>';

  it("a stale clear house puts a dashed WARNINGS · OLD DATA chip in the rating band", () => {
    for (const p of [stale, staleBusy]) {
      const b = band(render(p));
      expect(b).toContain(CHIP);
      expect(b).not.toContain("WARNINGS UNAVAILABLE");
    }
  });

  it("a fresh clear house has no chip; an unusable feed still says WARNINGS UNAVAILABLE", () => {
    for (const p of [quiet, busy]) expect(band(render(p))).not.toMatch(/WARNINGS (·|UNAVAILABLE)/);
    for (const p of [{ ...stale, house: { status: "unknown" } }, { ...stale, incidents: { ...incidentsDown.incidents } }, incidentsDown] as PayloadV1[]) {
      const b = band(render(p));
      expect(b).toContain("WARNINGS UNAVAILABLE");
      expect(b).not.toContain("OLD DATA");
    }
  });

  it("a warning over the house keeps the band, stale or not", () => {
    const b = band(render({ ...houseEW, incidents: { ...houseEW.incidents, stale: true, as_at: "OLD DATA · 15:45" } }));
    expect(b).toContain("EMERGENCY WARNING");
    expect(b).not.toContain("OLD DATA");
  });

  it("the chip takes the band's neighbour slot: an alarming neighbour takes the panel's, a calm one gives way", () => {
    const html = render(staleBusy);
    expect(band(html)).not.toContain(staleBusy.neighbours);
    expect(panel(html)).toContain(staleBusy.neighbours);
    expect(html).not.toContain(staleBusy.statewide);
    const calm = render({ ...staleBusy, neighbours: "North Central: HIGH · No TFB" });
    expect(calm).not.toContain("North Central: HIGH");
    expect(panel(calm)).toContain(staleBusy.statewide);
    // Fresh, the same screen keeps both lines.
    expect(band(render(busy))).toContain(busy.neighbours);
  });
});

// ---------------------------------------------------------------------------------------------

describe("(f2) every weather column names its model source", () => {
  const LIVE = Object.entries(PAYLOADS).filter(([, p]) => (p as PayloadV1).ok === true) as [string, PayloadV1][];

  it("every column with weather renders 'model', with or without the rating's note", () => {
    let n = 0;
    for (const [name, p] of LIVE)
      for (const variant of [p, withToday(p, { issued: "" }), withToday(p, { issued: "LAST KNOWN 14:05 · EMV/CFA: HIGH" })]) {
        const html = render(variant);
        variant.days.forEach((d, i) => {
          if (!d.wx.ok) return;
          expect(text(column(html, i as 0 | 1)), `${name} column ${i}`).toMatch(/model/i);
          n++;
        });
      }
    expect(n).toBeGreaterThan(40);
  });

  it("under a note the short form keeps the window and the BoM marker; an older payload without it falls back to the full line", () => {
    const wx = { ...busy.days[1].wx, src: "Open-Meteo model from 15:00", src_short: "Model from 15:00 · BoM" };
    const p = { ...busy, days: [busy.days[0], { ...busy.days[1], wx }] } as PayloadV1;
    expect(column(render(p), 1)).toContain('<span class="description" data-clamp="1">Model from 15:00 · BoM</span>');
    const { src_short: _s, ...old } = wx;
    const q = { ...busy, days: [busy.days[0], { ...busy.days[1], wx: old }] } as PayloadV1;
    expect(column(render(q), 1)).toContain('<span class="description" data-clamp="1">Open-Meteo model from 15:00</span>');
  });

  /**
   * The day column is 250 px. Heights measured in Chrome with the 3.3.2 CSS (the /preview audit is
   * the real gate): title 16, value 29, label 20, filled label 22, small filled label 14, a label
   * framed 1 / 2 (dashed) / 3 px 22 / 24 / 26, the double-framed CATASTROPHIC 30, a description 12.
   */
  function dayColumnPx(col: string): { px: number; items: string[] } {
    const gap = /^[^>]*gap--\[3px\]/.test(col) ? 3 : 5;
    const items = col
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("<span") || l.startsWith('<div class="flex flex--row'));
    let px = 0;
    for (const l of items) {
      const s = l.startsWith("<div") ? l.slice(l.indexOf("<span")) : l;
      const cls = /class="([^"]*)"/.exec(s)![1]!;
      if (cls.startsWith("fw-f2 p--0.5")) px += 30;
      else if (cls.includes("title")) px += 16;
      else if (cls.includes("value")) px += 29;
      else if (cls.includes("description")) px += 12;
      else if (cls.includes("label--small")) px += 14;
      else if (cls.includes("label--filled") || cls.includes("fw-f1")) px += 22;
      else if (cls.includes("fw-fd")) px += 24;
      else if (cls.includes("fw-f3")) px += 26;
      else px += 20;
    }
    return { px: px + gap * (items.length - 1), items };
  }

  it("every rating × note × change × indicator × ban combination fits 250 px and keeps every line", () => {
    const changes: Pick<Day["wx"], "change" | "change_flag">[] = [
      { change: "", change_flag: false },
      { change: "S change ~13:00", change_flag: false },
      { change: "Wind change danger", change_flag: true },
    ];
    const texts = ["", "7 days: 0.0 mm · wet Sat 19", "Hot, dry & windy (model)"];
    const bans: Day["tfb"][] = [
      { state: "declared", text: "TOTAL FIRE BAN" },
      { state: "declared", text: "TOTAL FIRE BAN · as of 14:05" },
      { state: "none", text: "No TFB · restrictions may apply" },
      { state: "pending", text: "No TFB declared yet" },
      { state: "unknown", text: "TFB status unavailable" },
    ];
    let n = 0;
    for (const lvl of [-1, 0, 1, 2, 3, 4])
      for (const issued of ["", "LAST KNOWN 14:05 · EMV/CFA: HIGH"])
        for (const ch of changes)
          for (const t of texts)
            for (const tfb of bans) {
              const wx: Day["wx"] = { ...houseEW.days[0].wx, ...ch, text: t, src: "Open-Meteo model · BoM", src_short: "Model 06:00–12:00 · BoM" };
              const day: Day = { label: "TODAY · WED 28 JAN", fdr: { ...RATING[lvl]!, issued: lvl < 0 ? "" : issued }, tfb, wx };
              const html = render({ ...houseEW, days: [day, { ...day, label: "TOMORROW · THU 29" }] });
              for (const i of [0, 1] as const) {
                const col = column(html, i);
                const { px, items } = dayColumnPx(col);
                const what = `level ${lvl} note ${issued && lvl >= 0 ? "yes" : "no"} change '${ch.change}' text '${t}' ${tfb.text}`;
                expect(px, `${what}: ${items.join(" | ")}`).toBeLessThanOrEqual(250);
                if (issued && lvl >= 0) expect(col, what).toContain(issued);
                expect(col, what).toContain(issued && lvl >= 0 ? ">Model 06:00–12:00 · BoM<" : ">Open-Meteo model · BoM<");
                if (ch.change) expect(col, what).toContain(ch.change);
                if (t) expect(col, what).toContain(t.replace("&", "&amp;"));
                n++;
              }
            }
    expect(n).toBe(1080);
  });

  it("only a column with a note, a change and an indicator packs at 3 px", () => {
    expect(column(render(houseEW), 0)).toMatch(/^3 fw-clip [^>]*gap--\[3px\]">/);
    expect(column(render(quiet), 1)).toMatch(/^3 fw-clip [^>]*gap--xsmall">/);
    expect(column(render(withToday(houseEW, { issued: "" })), 0)).toMatch(/^3 fw-clip [^>]*gap--xsmall">/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("setup notes: token, location, ignored files", () => {
  const settings = file("../plugin/src/settings.yml");
  const readme = file("../README.md");

  it("[22] the token is hex, and url_encoded in the polling headers as TRMNL documents", () => {
    expect(readme).toContain("openssl rand -hex 32");
    expect(readme).not.toMatch(/any long random string|rand -base64/);
    expect(settings).toMatch(/keyname: brief_token[\s\S]*description: .*Hex only[\s\S]*openssl rand -hex 32/);
    expect(settings).toMatch(/^polling_headers: "x-brief-token=\{\{ brief_token \| url_encode \}\}&x-home-secret=\{\{ lat_lon \}\}&/m);
  });

  it("[23] the location help says what leaves the Worker, rounded, and for how long", () => {
    const latLon = /keyname: lat_lon[\s\S]*?description: "([^"]+)"/.exec(settings)![1]!;
    expect(latLon).not.toContain("sent only to your Worker");
    expect(latLon).toMatch(/1 km with Open-Meteo/);
    expect(latLon).toMatch(/100 m with Vicmap \(State of Victoria\)/);
    expect(latLon).toMatch(/even when you pick a district/);
    expect(latLon).toMatch(/cached for 30 days/);
    expect(readme).toMatch(/rounded to 2 dp \(~1 km\)/);
    expect(readme).toMatch(/rounded to 3 dp \(~100 m\), even when you pick a district/);
    expect(readme).not.toMatch(/\| District \| Vicmap `cfa_tfb_district` \(cached 30 days\), or the district you pick/);
  });

  it("[24] .wrangler/ is ignored at any depth, and so are local-only captures", () => {
    const ignore = file("../.gitignore").split("\n");
    expect(ignore).toContain(".wrangler/");
    expect(ignore).toContain("fixtures/local/");
  });
});

describe("preview page", () => {
  it("falls back to timers for animation frames when opened hidden, before the runtime loads", () => {
    const page = previewHtml(source, [{ name: "quiet", payload: quiet }]);
    const shim = page.indexOf("if (document.hidden)");
    expect(shim).toBeGreaterThan(0);
    expect(shim).toBeLessThan(page.indexOf("plugins.js\"></script>"));
  });
});
