// Ported from learnharness (AGPL-3.0-only) tests/graph-view-filters.test.ts @ c549494.
/**
 * Legend/filters predicate tests — the pure half of the graph-view filters
 * panel (isNodeVisible); the sigma reducers just consume its verdict.
 */

import { describe, expect, it } from "vite-plus/test";
import { isNodeVisible } from "./graph-view.tsx";

const node = {
  name: "Money multiplier",
  statement: "The maximum ratio of broad money a bank can create from each unit of base money.",
};

describe("isNodeVisible (search predicate)", () => {
  it("is visible with an empty query", () => {
    expect(isNodeVisible(node, "")).toBe(true);
  });

  it("search matches the statement case-insensitively", () => {
    expect(isNodeVisible(node, "MONEY multiplier")).toBe(true);
  });

  it("search matches the statement when the name does not", () => {
    expect(isNodeVisible(node, "MAXIMUM ratio")).toBe(true);
    expect(isNodeVisible(node, " velocity")).toBe(false);
  });

  it("search matches the name when the statement does not", () => {
    expect(isNodeVisible(node, "money MULTIPLIER")).toBe(true);
    expect(isNodeVisible(node, " banking")).toBe(false);
  });

  it("whitespace-only query is no filter", () => {
    expect(isNodeVisible(node, "   ")).toBe(true);
  });
});
