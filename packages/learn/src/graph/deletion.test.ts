// Ported from learnharness (AGPL-3.0-only) tests/graph.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import { deleteNodeTraces, deleteChatTraces } from "./deletion.ts";
import { applyLedgerPlan } from "./model.ts";
import { getGraph } from "./derive.ts";
import { node, chain, ledgers, point } from "./test-fixtures.ts";
describe("full death", () => {
  const original = () =>
    ledgers({
      nodes: [node("n_a"), node("n_a", "s2"), node("n_b"), node("n_c")],
      chains: [
        chain("arg_a", ["n_a"], "n_b"),
        chain("arg_b", ["n_b"], "n_a"),
        chain("arg_c", ["n_b"], "n_c"),
      ],
      positions: Object.fromEntries(
        ["n_a", "n_b", "n_c", "arg_a", "arg_b", "arg_c"].map((id) => [id, { x: 1, y: 2 }]),
      ),
    });
  it("removes all proposition lines, every referencing chain and their positions", () => {
    const input = original();
    const plan = deleteNodeTraces(input, "n_a");
    expect(plan?.stats.chainsRemoved).toBe(2);
    const next = applyLedgerPlan(input, plan!);
    expect(next.nodes.map((n) => n.id)).toEqual(["n_b", "n_c"]);
    expect(next.chains.map((c) => c.id)).toEqual(["arg_c"]);
    expect(Object.keys(next.positions)).toEqual(["n_b", "n_c", "arg_c"]);
    expect(deleteNodeTraces(next, "n_a")).toBeNull();
    expect(input.nodes).toHaveLength(4);
  });
  it("argument deletion spares all member propositions and unrelated arguments", () => {
    const input = original();
    const plan = deleteNodeTraces(input, "arg_a");
    const next = applyLedgerPlan(input, plan!);
    expect(next.nodes).toEqual(input.nodes);
    expect(next.chains.map((c) => c.id)).toEqual(["arg_b", "arg_c"]);
    expect(next.positions.arg_a).toBeUndefined();
    expect(deleteNodeTraces(input, "arg_missing")).toBeNull();
  });
});
describe("session deletion", () => {
  const original = () =>
    ledgers({
      nodes: [
        node("n_shared", "s1", { aliases: ["creator alias"] }),
        node("n_shared", "s2", { aliases: ["survivor alias"] }),
        node("n_orphan"),
      ],
      chains: [chain("arg_dead", ["n_shared"], "n_orphan")],
      coverage: [{ chatId: "s1", fp: "fp", tokens: 3, foldedAt: "now" }],
      checkpoints: [{ chatId: "s1", foldedAt: "now" }],
      positions: { n_shared: { x: 1, y: 2 }, n_orphan: { x: 1, y: 2 }, arg_dead: { x: 1, y: 2 } },
    });
  it("preserve-graph changes only extraction bookkeeping", () => {
    const input = original();
    const plan = deleteChatTraces(input, "s1", "preserve-graph");
    expect(Object.keys(plan.rewrite).sort()).toEqual(["checkpoints", "coverage"]);
    const next = applyLedgerPlan(input, plan);
    expect(next.nodes).toEqual(input.nodes);
    expect(next.chains).toEqual(input.chains);
    expect(next.coverage).toEqual([]);
    expect(next.checkpoints).toEqual([]);
  });
  it("deletes orphan nodes, retains shared identity, strips creator phrasings and reattributes birth", () => {
    const input = original();
    const plan = deleteChatTraces(input, "s1", "delete-nodes");
    const next = applyLedgerPlan(input, plan);
    expect(plan.stats.nodesRemoved).toBe(1);
    expect(plan.stats.chainsRemoved).toBe(1);
    expect(next.nodes[0]).toMatchObject({ id: "n_shared", aliases: [], provenance: [] });
    expect(getGraph(next).nodes[0]?.provenance).toEqual([{ ...point("s2"), at: "2026-01-01" }]);
    expect(getGraph(next).nodes[0]?.aliases).toContain("survivor alias");
    expect(next.positions).toEqual({ n_shared: { x: 1, y: 2 } });
    expect(deleteChatTraces(next, "s1", "delete-nodes").rewrite).toEqual({});
  });
  it("retains positions for chains with a surviving assertion after provenance changes", () => {
    const input = ledgers({
      nodes: [node("n_a", "s2"), node("n_b", "s2")],
      chains: [{ ...chain("arg_live", ["n_a"], "n_b"), provenance: [point("s1"), point("s2")] }],
      positions: { arg_live: { x: 1, y: 2 } },
    });
    const plan = deleteChatTraces(input, "s1", "delete-nodes");
    const next = applyLedgerPlan(input, plan);
    expect(next.chains[0]?.provenance).toEqual([point("s2")]);
    expect(next.positions.arg_live).toEqual({ x: 1, y: 2 });
  });
});
