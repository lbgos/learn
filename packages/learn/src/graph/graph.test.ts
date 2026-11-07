// Ported from learnharness (AGPL-3.0-only) tests/graph.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { getGraph } from "./derive.ts";
import { mergeFindings } from "./merge.ts";
import { applyLedgerPlan, GraphSnapshot } from "./model.ts";
import { graphSnapshot, graphSessionIndex, graphSessionPropositions } from "./snapshot.ts";
import { node, chain, ledgers, findings, context, point } from "./test-fixtures.ts";
const stamp = { foldedAt: "2026-10-24" };
const decodeSnapshot = Schema.decodeSync(GraphSnapshot);

describe("pure ledger merger", () => {
  it("returns appends, job-local resolution and checkpoints without mutating input", () => {
    const original = ledgers();
    const plan = mergeFindings("s1", findings(), { links: [] }, original, stamp, context());
    expect(original).toEqual(ledgers());
    expect(plan.stats).toEqual({ nodes: 2, chains: 1 });
    expect(plan.mapping.get("p1")).toBe("n_new1");
    const graph = getGraph(applyLedgerPlan(original, plan));
    expect(graph.chains[0]?.premises).toEqual(["n_new1"]);
    expect(graph.nodes[0]?.provenance).toEqual([{ ...point("s1", "m1"), at: context().now }]);
    expect(plan.append.checkpoints).toEqual([{ chatId: "s1", foldedAt: stamp.foldedAt }]);
  });
  it("keeps first-line identity while unioning linked phrasings and message provenance", () => {
    const old = node("n_force", "old", { name: "Original", statement: "Original statement" });
    const original = ledgers({ nodes: [old] });
    const plan = mergeFindings(
      "s1",
      findings(),
      { links: [{ id: "p1", linkTo: old.id }] },
      original,
      stamp,
      context(),
    );
    const graph = getGraph(applyLedgerPlan(original, plan));
    expect(plan.stats.nodes).toBe(1);
    expect(graph.nodes[0]).toMatchObject({
      name: "Original",
      statement: "Original statement",
      aliases: [findings().propositions[0]?.statement],
      provenance: [
        { ...point("old"), at: old.createdAt },
        { ...point("s1", "m1"), at: context().now },
      ],
    });
    expect(old.aliases).toEqual([]);
  });
  it("never guesses identity by matching text; invalid links create", () => {
    const p = findings().propositions[0]!;
    const original = ledgers({
      nodes: [node("n_old", "s0", { name: p.name, statement: p.statement, aliases: p.aliases })],
    });
    const plan = mergeFindings(
      "s1",
      findings(),
      { links: [{ id: "p1", linkTo: "n_missing" }] },
      original,
      stamp,
      context(),
    );
    expect(plan.stats.nodes).toBe(2);
  });
  it("passes existing digest n_ ids through and unions repeated chain assertions", () => {
    const original = ledgers({
      nodes: [node("n_a"), node("n_b")],
      chains: [chain("arg_a", ["n_a"], "n_b")],
    });
    const input = { propositions: [], chains: [{ premises: ["n_a"], conclusion: "n_b" }] };
    const plan = mergeFindings("s2", input, { links: [] }, original, stamp, context());
    expect(plan.append.chains?.[0]?.id).toBe("arg_a");
    const next = applyLedgerPlan(original, plan);
    expect(getGraph(next).chains[0]?.provenance).toEqual([
      point("s1"),
      { ...point("s2"), at: context().now },
    ]);
    expect(mergeFindings("s2", input, { links: [] }, next, stamp, context()).stats.chains).toBe(0);
  });
  it("dedupes premise sets independent of order", () => {
    const original = ledgers({
      nodes: [node("n_a"), node("n_b"), node("n_c")],
      chains: [chain("arg_old", ["n_b", "n_a"], "n_c")],
    });
    const plan = mergeFindings(
      "s2",
      { propositions: [], chains: [{ premises: ["n_a", "n_b"], conclusion: "n_c" }] },
      { links: [] },
      original,
      stamp,
      context(),
    );
    expect(plan.append.chains?.[0]?.id).toBe("arg_old");
    expect(getGraph(applyLedgerPlan(original, plan)).chains).toHaveLength(1);
  });
  it("drops entire unresolved arguments and collapses aliases resolving to the conclusion", () => {
    const original = ledgers({ nodes: [node("n_a"), node("n_b")] });
    const plan = mergeFindings(
      "s1",
      {
        propositions: [],
        chains: [
          { premises: ["n_a", "missing"], conclusion: "n_b" },
          { premises: ["n_a"], conclusion: "n_a" },
        ],
      },
      { links: [] },
      original,
      stamp,
      context(),
    );
    expect(plan.stats.chains).toBe(0);
  });
  it("rewrites whole redundant keys including all provenance lines and prunes dead positions", () => {
    const original = ledgers({
      nodes: [node("n_a"), node("n_b"), node("n_c")],
      chains: [chain("arg_wide", ["n_a", "n_b"], "n_c")],
      positions: { arg_wide: { x: 1, y: 2 }, n_a: { x: 0, y: 0 } },
    });
    const plan = mergeFindings(
      "s2",
      { propositions: [], chains: [{ premises: ["n_a"], conclusion: "n_c" }] },
      { links: [] },
      original,
      stamp,
      context(),
    );
    expect(plan.stats).toEqual({ nodes: 0, chains: 1, droppedChains: 1 });
    const next = applyLedgerPlan(original, plan);
    expect(next.chains.map((c) => c.id)).toEqual(["arg_new1"]);
    expect(next.positions).toEqual({ n_a: { x: 0, y: 0 } });
  });
  it("checkpoints the exact supplied coverage batch, including empty findings", () => {
    const coverage = [{ chatId: "s1", fp: "fp", tokens: 20, foldedAt: stamp.foldedAt }];
    const plan = mergeFindings(
      "s1",
      { propositions: [], chains: [] },
      { links: [] },
      ledgers(),
      { ...stamp, coverage },
      context(),
    );
    expect(plan.append.coverage).toEqual(coverage);
    expect(plan.append.checkpoints).toBeUndefined();
  });
  it("refuses generated ID collisions before a persistence plan escapes", () => {
    expect(() =>
      mergeFindings(
        "s1",
        findings(),
        { links: [] },
        ledgers({ nodes: [node("n_new1")] }),
        stamp,
        context(),
      ),
    ).toThrow(/duplicate/);
  });
});
describe("snapshot and source views", () => {
  it("joins source labels, filters unknown provenance, derives clusters and positions", () => {
    const original = ledgers({
      nodes: [
        node("n_a"),
        node("n_b"),
        node("n_c"),
        node("n_file", "notes:one"),
        node("n_ghost", "deleted"),
      ],
      chains: [chain("arg_abc", ["n_a", "n_b"], "n_c")],
      sources: [{ id: "notes:one", filePath: "notes.md", importedAt: "2026-01-01" }],
      positions: { n_a: { x: 1, y: 2 }, stale: { x: 0, y: 0 } },
    });
    const sessions = [
      { id: "s1", title: "Mechanics", createdAt: "2026-01-01", updatedAt: "2026-10-24" },
    ];
    const snapshot = graphSnapshot(original, sessions);
    expect(snapshot.clusters).toEqual([
      { id: "s1", label: "Mechanics", members: ["arg_abc", "n_a", "n_b", "n_c"] },
    ]);
    expect(snapshot.fileSources).toEqual({ "notes:one": "notes.md" });
    expect(snapshot.nodeSessions.n_ghost).toBeUndefined();
    expect(snapshot.positions).toEqual({ n_a: { x: 1, y: 2 } });
    expect(decodeSnapshot(snapshot)).toEqual(snapshot);
    expect(graphSessionIndex(original, sessions)[0]?.name).toBe("Mechanics");
    expect(graphSessionPropositions(original, "s1").map((p) => p.nodeId)).toEqual([
      "n_a",
      "n_b",
      "n_c",
    ]);
  });
  it("filters clusters before adding implication geometry", () => {
    const snapshot = graphSnapshot(
      ledgers({
        nodes: [node("n_a"), node("n_b"), node("n_c", "s2")],
        chains: [chain("arg_x", ["n_a", "n_b"], "n_c")],
      }),
    );
    expect(snapshot.clusters).toEqual([]);
  });
});
