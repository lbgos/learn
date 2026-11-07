// Ported from learnharness (AGPL-3.0-only) tests/clusters.test.ts @ c549494.
/**
 * Cluster presentation-rule tests. Wave 7 killed the semantic detection
 * AND the LLM label matcher (birth-session clusters, session-name labels —
 * core/session-clusters.ts has its own suite); what remains pinned here
 * is the render threshold and the hull-color spread the UI leans on.
 */
import { describe, expect, it as test } from "vite-plus/test";
import { clusterHue } from "./cluster-geometry.ts";

describe("clusterHue", () => {
  test("is stable per id and spreads", () => {
    // Same id → same hue, always; different ids → usually different hues.
    expect(clusterHue("cluster-a")).toBe(clusterHue("cluster-a"));
    const hues = new Set<number>();
    for (let i = 0; i < 40; i++) hues.add(clusterHue(`cluster-${i}`));
    expect(hues.size > 20).toBeTruthy();
    for (const h of hues) expect(h >= 0 && h < 360).toBeTruthy();
  });
});
