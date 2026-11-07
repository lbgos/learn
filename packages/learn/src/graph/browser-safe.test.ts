import { describe, it, expect } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Inspect the static import tree synchronously; this is a node-only test.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as graph from "./index.ts";

describe("graph entry", () => {
  it("exports the pipeline and layout functions without importing a node-only module", () => {
    const visited = new Set<string>();
    const visit = (url: URL): void => {
      const path = NodeURL.fileURLToPath(url);
      if (visited.has(path)) return;
      visited.add(path);
      const source = NodeFS.readFileSync(path, "utf8");
      expect(source).not.toMatch(/(?:from\s*|import\s*\()\s*["']node:/);
      for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.\.?\/[^"']+)["']/g)) {
        const specifier = match[1];
        if (specifier) visit(new URL(specifier, url));
      }
    };
    visit(new URL("./index.ts", import.meta.url));
    expect([...visited].some((path) => path.includes("/graph/node/"))).toBe(false);
    expect(graph.mergeFindings).toBeTypeOf("function");
    expect(graph.settleGraphLayout).toBeTypeOf("function");
  });
});
