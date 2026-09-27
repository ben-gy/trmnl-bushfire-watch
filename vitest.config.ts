import { defineConfig, type Plugin } from "vitest/config";

/** Mirrors wrangler's Text rules for "**\/*.liquid" and "**\/*.xml", so tests import what the Worker ships. */
const liquidText: Plugin = {
  name: "text-modules",
  transform(code, id) {
    if (id.endsWith(".liquid") || id.endsWith(".xml")) return { code: "export default " + JSON.stringify(code), map: null };
    return undefined;
  },
};

export default defineConfig({
  plugins: [liquidText],
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
