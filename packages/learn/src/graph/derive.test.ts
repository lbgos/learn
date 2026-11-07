// Ported from learnharness (AGPL-3.0-only) tests/graph.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import { deriveView } from "./derive.ts";
import type { GraphNode, GraphChain } from "./model.ts";
describe("deriveView (the argument's geometry)", () => {
  const prop = (id: string): GraphNode => ({
    id,
    name: id.toUpperCase(),
    statement: `${id} statement`,
    aliases: [],
    createdAt: "2026-09-30T00:00:00.000Z",
    provenance: [],
  });
  const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
    id,
    premises,
    conclusion,
    provenance: [],
    createdAt: "2026-09-30T00:00:00.000Z",
  });

  it("a SINGLE-premise chain collapses to ONE direct arrow — no imp node", () => {
    const view = deriveView({
      nodes: [prop("a"), prop("b")],
      chains: [chain("arg_ab", ["a"], "b")],
    });
    expect(
      view.nodes.map((n) => n.id),
      "no arg_ node minted",
    ).toEqual(["a", "b"]);
    expect(view.edges, "the argument IS a plain arrow").toEqual([{ from: "a", to: "b" }]);
  });

  it("a MULTI-premise chain keeps the imp node + fan (premises in, conclusion out)", () => {
    const view = deriveView({
      nodes: [prop("a"), prop("b"), prop("c")],
      chains: [chain("arg_ab", ["a", "b"], "c")],
    });
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["a", "arg_ab", "b", "c"]);
    expect(
      [...view.edges].sort((x, y) =>
        x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : 1,
      ),
    ).toEqual([
      { from: "a", to: "arg_ab" },
      { from: "arg_ab", to: "c" },
      { from: "b", to: "arg_ab" },
    ]);
    const imp = view.nodes.find((n) => n.id === "arg_ab")!;
    expect(imp.name).toBe("\u27f9");
  });

  it("two chains SHARING a conclusion stay distinct — two geometry points, never a unioned fan", () => {
    const view = deriveView({
      nodes: [prop("a"), prop("b"), prop("c"), prop("d"), prop("e")],
      chains: [chain("arg_e1", ["a", "b"], "e"), chain("arg_e2", ["c", "d"], "e")],
    });
    expect(view.nodes.map((n) => n.id).sort()).toEqual([
      "a",
      "arg_e1",
      "arg_e2",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(view.edges.some((x) => x.from === "arg_e1" && x.to === "e")).toBeTruthy();
    expect(view.edges.some((x) => x.from === "arg_e2" && x.to === "e")).toBeTruthy();
  });

  it("dangling chains drop (missing member — the honest belt)", () => {
    const view = deriveView({
      nodes: [prop("a")],
      chains: [chain("arg_ghost", ["a"], "gone"), chain("arg_gone", ["ghost"], "a")],
    });
    expect(view.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(view.edges).toEqual([]);
  });

  it("LOGICAL edges: every chain contracts to direct premise→conclusion arrows (all chains, deduped)", () => {
    const view = deriveView({
      nodes: [prop("a"), prop("b"), prop("c")],
      chains: [chain("arg_ab", ["a", "b"], "c"), chain("arg_ac", ["a"], "c")],
    });
    expect(
      [...view.logicalEdges].sort((x, y) =>
        x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : 1,
      ),
    ).toEqual([
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ]);
    expect(
      view.logicalEdges.every((e) => !e.from.startsWith("arg_") && !e.to.startsWith("arg_")),
    ).toBeTruthy();
  });

  it("impLinks: one linkage per MULTI-premise chain — the depth pass's midpoint input", () => {
    const view = deriveView({
      nodes: [prop("a"), prop("b"), prop("c")],
      chains: [chain("arg_ab", ["a", "b"], "c"), chain("arg_ac", ["a"], "c")],
    });
    expect(view.impLinks).toEqual([{ id: "arg_ab", premises: ["a", "b"], conclusion: "c" }]);
  });
});
