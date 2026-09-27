/**
 * DEV-only preview page: renders plugin/src/full.liquid in the browser with LiquidJS and the real
 * Framework 3.3.2 CSS and runtime inside TRMNL OG screen classes, one 800×480 screen per case, then
 * audits every screen for overflow. Chrome's anti-aliasing is not TRMNL's dithering, so this checks
 * layout, not the final PNG; the static-twin plugin on TRMNL is the release gate for that.
 * The runtime schedules terminalize() on animation frames, which a hidden tab never runs, so a page
 * opened in the background falls back to timers (FRAME_SHIM); those are throttled too, so the
 * audit can still take a minute to appear there.
 */

const FRAMEWORK = "3.3.2";
const LIQUIDJS = "https://cdn.jsdelivr.net/npm/liquidjs@10.29.0/dist/liquid.browser.min.js";

const SCREEN = {
  1: "screen screen--og_png screen--md screen--density-1x screen--1bit",
  2: "screen screen--ogv2 screen--md screen--density-1x screen--2bit",
} as const;

/** JSON for a <script type="application/json"> block: "</" and "<!--" cannot end or confuse it. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/").replace(/<!--/g, "\\u003c!--");
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Loaded before the runtime: animation frames as timers when the page opens hidden. */
const FRAME_SHIM = String.raw`
if (document.hidden) {
  window.requestAnimationFrame = function (cb) { return setTimeout(function () { cb(performance.now()); }, 16); };
  window.cancelAnimationFrame = function (id) { clearTimeout(id); };
}
`;

/** Runs in the page. Plain ES2017 so it needs no build step. */
const PAGE_SCRIPT = String.raw`
(async function () {
  var template = JSON.parse(document.getElementById("fw-template").textContent);
  var cases = JSON.parse(document.getElementById("fw-cases").textContent);
  var screenClass = document.body.getAttribute("data-screen");
  var engine = new liquidjs.Liquid();
  var root = document.getElementById("fw-cases-out");
  var nowS = Math.floor(Date.now() / 1000);
  var trmnl = {
    system: { timestamp_utc: nowS },
    plugin_settings: { instance_name: "North Warrandyte", custom_fields_values: {} },
    user: { time_zone_iana: "Australia/Melbourne", utc_offset: 36000, locale: "en" },
  };
  var out = [];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var wrap = document.createElement("section");
    wrap.className = "fw-case";
    var head = document.createElement("h2");
    head.textContent = c.name;
    var badge = document.createElement("span");
    badge.className = "fw-badge";
    badge.textContent = "…";
    head.appendChild(badge);
    var screen = document.createElement("div");
    screen.className = screenClass;
    var view = document.createElement("div");
    view.className = "view view--full";
    screen.appendChild(view);
    var env = document.createElement("div");
    env.className = "environment trmnl";
    env.appendChild(screen);
    wrap.appendChild(head);
    wrap.appendChild(env);
    root.appendChild(wrap);
    var ctx = Object.assign({}, c.payload || {}, { trmnl: trmnl });
    try {
      view.innerHTML = await engine.parseAndRender(template, ctx);
    } catch (e) {
      view.textContent = "Liquid error: " + (e && e.message ? e.message : e);
    }
    out.push({ name: c.name, screen: screen, badge: badge });
  }
  var original = new WeakMap();
  document.querySelectorAll(".view [data-clamp]").forEach(function (el) { original.set(el, el.textContent); });
  try { await document.fonts.ready; } catch (_) {}
  if (typeof window.terminalize === "function") {
    try { await window.terminalize(); } catch (e) { console.error(e); }
  }
  try { await document.fonts.ready; } catch (_) {}

  var DECLARED = { "fw-band": 120, "fw-mid": 250, "fw-foot": 28 };
  function audit(screen) {
    var problems = [];
    var layout = screen.querySelector(".layout");
    var view = screen.querySelector(".view");
    if (!layout) return ["no .layout rendered"];
    if (/Liquid error|undefined|\[object Object\]|NaN/.test(screen.textContent || "")) problems.push("bad text in output");
    var lr = layout.getBoundingClientRect();
    if (lr.bottom > view.getBoundingClientRect().bottom + 0.5) problems.push("layout below the view");
    layout.querySelectorAll("*").forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      var cs = getComputedStyle(el);
      var p = el.parentElement;
      var ps = getComputedStyle(p);
      var pr = p.getBoundingClientRect();
      var right = pr.right - parseFloat(ps.borderRightWidth) - parseFloat(ps.paddingRight);
      var bottom = pr.bottom - parseFloat(ps.borderBottomWidth) - parseFloat(ps.paddingBottom);
      var what = el.tagName.toLowerCase() + "." + String(el.className).trim().split(/\s+/).join(".") +
        " '" + (el.textContent || "").trim().slice(0, 40) + "'";
      var ownText = Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim(); });
      var lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      if (r.bottom > lr.bottom + 0.5) problems.push("below the layout by " + (r.bottom - lr.bottom).toFixed(1) + "px: " + what);
      if (r.right > right + 0.5) problems.push("past its parent's right by " + (r.right - right).toFixed(1) + "px: " + what);
      // Columns clip their own overflow, so the layout check alone would miss it.
      if (r.bottom > bottom + 0.5) problems.push("below its parent by " + (r.bottom - bottom).toFixed(1) + "px: " + what);
      if (ownText && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && !el.hasAttribute("data-clamp")) {
        problems.push("text wider than its box by " + (el.scrollWidth - el.clientWidth) + "px: " + what);
      }
      // A flex child whose min-height resolves to 0 shrinks instead of overflowing, clipping its text.
      if (ownText && r.height + 0.5 < lh) problems.push("squeezed below one line (" + r.height.toFixed(1) + " < " + lh + "px): " + what);
      if (!el.hasAttribute("data-clamp") && cs.overflow !== "visible" && el.scrollHeight > el.clientHeight + 1) {
        problems.push("clipped by " + (el.scrollHeight - el.clientHeight) + "px: " + what);
      }
    });
    Object.keys(DECLARED).forEach(function (cls) {
      layout.querySelectorAll("." + cls).forEach(function (el) {
        var h = el.getBoundingClientRect().height;
        if (Math.abs(h - DECLARED[cls]) > 0.5) problems.push(cls + " is " + h.toFixed(1) + "px, declared " + DECLARED[cls]);
      });
    });
    return problems;
  }
  /** Text the runtime clamped: fine as a safety net, but the Worker's budgets should prevent it. */
  function notes(screen) {
    var out = [];
    screen.querySelectorAll("[data-clamp]").forEach(function (el) {
      var before = original.get(el);
      if (el.scrollWidth > el.clientWidth + 1 || (before !== undefined && before !== el.textContent)) {
        out.push("clamped: '" + (before || el.textContent || "").trim().slice(0, 60) + "'");
      }
    });
    return out;
  }
  var results = out.map(function (o) {
    var problems = audit(o.screen);
    var clamped = notes(o.screen);
    o.badge.textContent = problems.length ? "FAIL" : "PASS";
    o.badge.className = "fw-badge " + (problems.length ? "fw-fail" : "fw-pass");
    if (problems.length) {
      var ul = document.createElement("ul");
      problems.forEach(function (t) { var li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
      o.screen.closest(".fw-case").appendChild(ul);
    }
    return { name: o.name, pass: problems.length === 0, problems: problems, clamped: clamped };
  });
  window.__fwAudit = { pass: results.every(function (r) { return r.pass; }), build: window.__TRMNL_BUILD__ || null, results: results };
  var sum = document.getElementById("fw-summary");
  sum.textContent = (window.__fwAudit.pass ? "PASS" : "FAIL") + " · " +
    results.filter(function (r) { return r.pass; }).length + "/" + results.length + " cases fit · " +
    (window.__fwAudit.build || "plugins.js not loaded");
})();
`;

/**
 * A standalone HTML page rendering `template` once per case. `payload` is the merge-variable root;
 * each render also gets a `trmnl` global with the current time, as TRMNL provides.
 */
export function previewHtml(
  template: string,
  cases: { name: string; payload: unknown }[],
  opts: { bits?: 1 | 2 } = {},
): string {
  const screen = SCREEN[opts.bits ?? 1];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bushfire Watch · preview</title>
<link rel="stylesheet" href="https://trmnl.com/css/${FRAMEWORK}/plugins.css">
<script src="${LIQUIDJS}"></script>
<style>
  body.fw-preview { background: #d8d8d8; color: #000; font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 16px; }
  .fw-preview > h1 { font-size: 18px; margin: 0 0 4px; }
  #fw-summary { font-weight: 700; margin-bottom: 16px; }
  .fw-case { margin: 0 0 28px; }
  .fw-case > h2 { font-size: 15px; margin: 0 0 6px; }
  .fw-case > .environment { display: inline-block; background: #fff; outline: 1px solid #888; }
  .fw-case .screen { width: 800px; height: 480px; }
  .fw-badge { margin-left: 10px; padding: 1px 6px; font-size: 12px; border-radius: 3px; color: #fff; background: #666; }
  .fw-pass { background: #1b7f3a; }
  .fw-fail { background: #b3261e; }
  .fw-case ul { margin: 6px 0 0; font: 12px/1.4 ui-monospace, monospace; color: #b3261e; }
</style>
</head>
<body class="fw-preview" data-screen="${screen}">
<h1>Bushfire Watch · full layout · ${escapeHtml(screen)}</h1>
<div id="fw-summary">Rendering…</div>
<div id="fw-cases-out"></div>
<script type="application/json" id="fw-template">${embedJson(template)}</script>
<script type="application/json" id="fw-cases">${embedJson(cases)}</script>
<script>${FRAME_SHIM}</script>
<script src="https://trmnl.com/js/${FRAMEWORK}/plugins.js"></script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}
