// Ported from learnharness (AGPL-3.0-only) tests/plan-tree.test.ts, tests/plan-blocks.test.ts @ c549494.
import { describe, expect, it } from "vite-plus/test";
import {
  createTree,
  emptyTree,
  parseMermaidPlan,
  derivePlan,
  derivePlanStatuses,
  derivePlanBlocks,
  planBlocksFor,
  validateToolInput,
} from "./index.ts";
import { call, planEvents, quiz } from "./fixtures.test-utils.ts";

describe("mermaid subset", () => {
  it("parses headers, comments, quotes, inline labels, forward references and chained arrows", () => {
    const parsed = parseMermaidPlan(
      "%% Map\nFLOWCHART lr\na --> b[\"Second\"] ==> c('Third')\na[First] -.-> c\na[Ignored]\nsolo_node\na --> b",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.nodes).toEqual([
      { id: "a", title: "First" },
      { id: "b", title: "Second" },
      { id: "c", title: "Third" },
      { id: "solo_node", title: "solo_node" },
    ]);
    expect(parsed.plan.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
    ]);
  });
  it("gives line numbers for malformed ids, unsupported syntax, headers, cycles and self loops", () => {
    for (const source of [
      "wrong\na[A]",
      "graph TD\nUPPER[Bad]",
      "graph TD\na --> a",
      "graph TD\na --> b\nb --> a",
      "graph TD\nsubgraph title",
      "graph TD\na -->",
      "graph TD",
      "",
    ]) {
      const result = parseMermaidPlan(source);
      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/line \d+/);
      expect(validateToolInput("plan_init", { mermaid: source }).ok).toBe(false);
    }
  });
  it("collects more than one authoring problem and has no node-count limit", () => {
    const bad = parseMermaidPlan("graph TD\nUPPER[A]\nwrong.id[B]");
    expect(bad.problems).toHaveLength(2);
    expect(
      parseMermaidPlan(
        `graph TD\n${Array.from({ length: 100 }, (_, i) => `node-${i}[Node ${i}]`).join("\n")}`,
      ).ok,
    ).toBe(true);
  });
});
describe("tree invariants", () => {
  const nodes = [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
    { id: "c", title: "C" },
  ];
  it("rejects duplicate ids, unknown endpoints, duplicate edges, self-loops and cycles", () => {
    expect(() => createTree([...nodes, nodes[0]!], [])).toThrow(/Duplicate node/);
    for (const edges of [
      [{ from: "a", to: "missing" }],
      [{ from: "a", to: "a" }],
      [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    ])
      expect(() => createTree(nodes, edges)).toThrow();
    expect(() => createTree([{ id: "UPPER", title: "A" }], [])).toThrow();
  });
  it("copies the input tree and starts version 1", () => {
    const edges = [{ from: "a", to: "b" }];
    const tree = createTree(nodes, edges);
    expect(tree.version).toBe(1);
    expect(tree.nodes).not.toBe(nodes);
    expect(tree.edges).not.toBe(edges);
    expect(emptyTree()).toEqual({ nodes: [], edges: [], version: 0 });
  });
});
describe("plan position and snapshots", () => {
  it("emits only the last valid new plan in a supplied turn", () => {
    const rewrite = call("rewrite", "plan_init", { mermaid: "graph TD\nx[X]" });
    const turn = [
      ...planEvents,
      rewrite,
      call("bad", "plan_init", { mermaid: "graph TD\na --> a" }),
    ];
    expect(planBlocksFor([], turn).map((block) => block.planCallId)).toEqual(["rewrite"]);
    expect(planBlocksFor(turn, turn)).toEqual([]);
    expect(planBlocksFor(planEvents, [rewrite]).map((block) => block.planCallId)).toEqual([
      "rewrite",
    ]);
  });
  const tagged = (id: string, nodeId: string) =>
    call(id, "quiz", { ...quiz, type: "check", nodeId });
  it("keeps visited tags sticky on revisits, with current taking display priority", () => {
    const events = [
      ...planEvents,
      tagged("q1", "a"),
      tagged("q2", "a"),
      tagged("q3", "b"),
      tagged("q4", "a"),
      tagged("bad", "missing"),
    ];
    const plan = derivePlan(events)!;
    expect(derivePlanStatuses(plan, events)).toEqual({
      current: "a",
      visited: new Set(["a", "b"]),
    });
    expect(derivePlanStatuses(plan, planEvents)).toEqual({ current: null, visited: new Set() });
    expect(derivePlanStatuses(plan, [...planEvents, tagged("q1", "a"), tagged("q2", "a")])).toEqual(
      { current: "a", visited: new Set() },
    );
  });
  it("takes the latest valid rewrite, ignores deleted tags and keeps snapshots frozen", () => {
    const initial = [...planEvents, tagged("q1", "a"), tagged("q2", "b")];
    const events = [
      ...initial,
      call("rewrite", "plan_init", { mermaid: "graph TD\nb[Retained] --> d[New]" }),
      call("bad", "plan_init", { mermaid: "graph TD\nd --> d" }),
    ];
    const plan = derivePlan(events)!;
    expect(plan.version).toBe(2);
    expect(plan.nodes.map((node) => node.id)).toEqual(["b", "d"]);
    expect(derivePlanStatuses(plan, events)).toEqual({ current: "b", visited: new Set() });
    const blocks = derivePlanBlocks(events);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.current).toBeNull();
    expect(blocks[0]!.nodes.every((node) => node.status === "upcoming")).toBe(true);
    expect(blocks[1]!.nodes).toEqual([
      { id: "b", title: "Retained", status: "current" },
      { id: "d", title: "New", status: "upcoming" },
    ]);
    expect(derivePlanBlocks([...events, events[events.length - 2]!])).toEqual(blocks);
  });
});
