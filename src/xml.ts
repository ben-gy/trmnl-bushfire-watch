/**
 * A small, tolerant XML tokenizer for BoM products and the CFA RSS feed. Workers have no DOMParser,
 * and HTMLRewriter treats BoM's <area> as an HTML void element (and is missing under vitest).
 */

export interface XEl {
  name: string;
  attrs: Record<string, string>;
  children: XEl[];
  text: string;
}

/** The document root. */
export interface XDoc extends XEl {
  /**
   * True only when every element opened was closed by EOF and a top-level element was closed: a body
   * cut short (a half-written file behind a CDN) must never parse as a smaller, calmer document.
   */
  complete: boolean;
}

const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|</g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function parseXml(src: string): XDoc {
  const root: XDoc = { name: "#root", attrs: {}, children: [], text: "", complete: false };
  const stack: XEl[] = [root];
  let closedTop = false;
  for (const m of src.replace(/^﻿/, "").matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
      continue;
    }
    if (m[1] !== undefined) {
      top.text += m[1];
      continue;
    }
    const name = m[3];
    if (!name) continue; // comment, PI, doctype, stray "<"
    if (m[2] === "/") {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i;
          if (i === 1) closedTop = true;
          break;
        }
      }
      continue;
    }
    const el: XEl = { name, attrs: {}, children: [], text: "" };
    for (const a of (m[4] ?? "").matchAll(ATTR)) el.attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
    top.children.push(el);
    if (m[5] !== "/") stack.push(el);
    else if (top === root) closedTop = true;
  }
  root.complete = closedTop && stack.length === 1;
  return root;
}

/** The top-level `name` element, only when the whole document arrived (see XDoc.complete). */
export function docRoot(doc: XDoc, name: string): XEl | undefined {
  return doc.complete ? doc.children.find((c) => c.name === name) : undefined;
}

/** Every descendant element with this name, depth first. */
export function* all(el: XEl, name: string): Generator<XEl> {
  for (const c of el.children) {
    if (c.name === name) yield c;
    yield* all(c, name);
  }
}

export function first(el: XEl, name: string): XEl | undefined {
  for (const c of all(el, name)) return c;
  return undefined;
}

/** Text of a direct child <element type="…"> or <text type="…">, trimmed; undefined when absent. */
export function typed(el: XEl, tag: "element" | "text", type: string): string | undefined {
  return el.children.find((c) => c.name === tag && c.attrs.type === type)?.text.trim();
}
