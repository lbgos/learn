// Ported from learnharness (AGPL-3.0-only) tests/layout.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";

import { createGraphSimulation, incrementalLayout, inferenceDepths } from "./layout.ts";
import type { GraphNode, Position } from "./model.ts";

const node = (id: string): GraphNode => ({
  id,
  name: id,
  statement: id,
  aliases: [],
  createdAt: "2026-09-13T00:00:00.000Z",
  provenance: [],
});

const edge = (from: string, to: string): { from: string; to: string } => ({ from, to });

const mean = (positions: Map<string, Position>, ids: string[]): { x: number; y: number } => ({
  x: ids.reduce((s, id) => s + positions.get(id)!.x, 0) / ids.length,
  y: ids.reduce((s, id) => s + positions.get(id)!.y, 0) / ids.length,
});

describe("incrementalLayout", () => {
  it("bootstraps deterministically from an empty ledger", () => {
    const nodes = ["a", "b", "c", "d"].map(node);
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
    const first = incrementalLayout(nodes, edges, new Map());
    const second = incrementalLayout(nodes, edges, new Map());
    expect(first.size).toBe(4);
    for (const [id, p] of first) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y), `finite coords for ${id}`).toBeTruthy();
      expect(p, `deterministic position for ${id}`).toEqual(second.get(id));
    }
  });

  it("rest state is stable: a re-settle with nothing new barely moves nodes", () => {
    const nodes = ["a", "b", "c", "d", "e"].map(node);
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("a", "e")];
    const rest = incrementalLayout(nodes, edges, new Map());
    const span =
      Math.max(...[...rest.values()].map((p) => p.x)) -
      Math.min(...[...rest.values()].map((p) => p.x));
    const again = incrementalLayout(nodes, edges, rest);
    let maxShift = 0;
    for (const [id, p] of rest) {
      const q = again.get(id)!;
      maxShift = Math.max(maxShift, Math.hypot(p.x - q.x, p.y - q.y));
    }
    expect(
      maxShift < span * 0.1,
      `re-settle drift ${maxShift.toFixed(2)} should be < 10% of span ${span.toFixed(2)}`,
    ).toBeTruthy();
  });

  it("evolves: an anchored node stays near its anchor while a new neighbor joins it", () => {
    const core = ["a", "b", "c"].map(node);
    const coreEdges = [edge("a", "b"), edge("b", "c")];
    const previous = incrementalLayout(core, coreEdges, new Map());
    const anchor = previous.get("b")!;
    const dist = Math.hypot;
    const nearby = ["d", "e"].map(node);
    const next = incrementalLayout(
      [...core, ...nearby],
      [...coreEdges, edge("b", "d"), edge("d", "e")],
      previous,
    );
    const coreSpanBefore =
      Math.max(...[...previous.values()].map((p) => p.x)) -
      Math.min(...[...previous.values()].map((p) => p.x));
    expect(
      dist(next.get("b")!.x - anchor.x, next.get("b")!.y - anchor.y) < coreSpanBefore,
      "anchored node b stays near its previous position",
    ).toBeTruthy();
    const centroid = mean(next, ["b", "d", "e"]);
    expect(
      dist(next.get("d")!.x - centroid.x, next.get("d")!.y - centroid.y) < coreSpanBefore * 2,
      "new neighbor d landed near the cluster it arrived with",
    ).toBeTruthy();
  });

  it("rim: an orphan ends up outside the anchored core", () => {
    const core = ["a", "b", "c", "d", "e"].map(node);
    const coreEdges = [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("d", "e"),
      edge("a", "e"),
      edge("b", "d"),
    ];
    const previous = incrementalLayout(core, coreEdges, new Map());
    const next = incrementalLayout([...core, node("orphan")], coreEdges, previous);
    const c = mean(previous, ["a", "b", "c", "d", "e"]);
    const coreMax = Math.max(
      ...[...next.entries()]
        .filter(([id]) => id !== "orphan")
        .map(([, p]) => Math.hypot(p.x - c.x, p.y - c.y)),
    );
    const orphanR = Math.hypot(next.get("orphan")!.x - c.x, next.get("orphan")!.y - c.y);
    expect(
      orphanR > coreMax,
      `orphan at r=${orphanR.toFixed(1)} should sit outside core max r=${coreMax.toFixed(1)}`,
    ).toBeTruthy();
  });
});

describe("imp-link half distance (rendering arc, owner 2026-09-30)", () => {
  const settle = (from: string, to: string, linkDistance: number) => {
    const nodes = [
      { id: from, x: 0, y: 0 },
      { id: to, x: 500, y: 0 },
    ];
    const sim = createGraphSimulation(nodes, [{ from, to }], {
      linkDistance,
      chargeStrength: 0, // springs only — the rest length IS the equilibrium
      gravity: { x: 0, y: 0, strength: 0 },
    });
    for (let i = 0; i < 300; i++) sim.tick();
    const [a, b] = sim.nodes().map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 }));
    if (!a || !b) throw new Error("both nodes must be present");
    return Math.abs(b.x - a.x);
  };

  it("a plain proposition link settles at the full rest length (tuned or default)", () => {
    expect(Math.abs(settle("a", "b", 100) - 100) < 2, "plain link ≈ 100").toBeTruthy();
  });

  it("a link TOUCHING an implication node gets HALF the rest length", () => {
    expect(Math.abs(settle("a", "arg_x", 100) - 50) < 2, "into-imp link ≈ 50").toBeTruthy();
    expect(Math.abs(settle("arg_x", "b", 100) - 50) < 2, "out-of-imp link ≈ 50").toBeTruthy();
  });
});

describe("clusterPull (the centroid force)", () => {
  it("compacts each cluster toward its OWN centroid; strength 0 = off", () => {
    const mk = (p: string, baseX: number) =>
      Array.from({ length: 8 }, (_, i) => ({ id: `${p}${i}`, x: baseX + i * 40, y: i * 15 }));
    const a = mk("a", -400);
    const b = mk("b", 400);
    const nodes = [...a, ...b];
    const edges = [
      ...a.slice(0, -1).map((n, i) => ({ from: n.id, to: a[i + 1]!.id })),
      ...b.slice(0, -1).map((n, i) => ({ from: n.id, to: b[i + 1]!.id })),
    ];
    const clusters = [{ members: a.map((n) => n.id) }, { members: b.map((n) => n.id) }];

    const spreadOf = (ns: { id: string; x: number; y: number }[]): number => {
      let sum = 0;
      for (const group of [ns.filter((n) => n.id[0] === "a"), ns.filter((n) => n.id[0] === "b")]) {
        const cx = group.reduce((s, n) => s + n.x, 0) / group.length;
        const cy = group.reduce((s, n) => s + n.y, 0) / group.length;
        sum += group.reduce((s, n) => s + Math.hypot(n.x - cx, n.y - cy), 0) / group.length;
      }
      return sum;
    };

    const run = (strength: number) => {
      const sim = createGraphSimulation(
        nodes.map((n) => ({ ...n })),
        edges,
        { clusterPull: { clusters, strength } },
      );
      for (let i = 0; i < 150; i++) sim.tick();
      return spreadOf(sim.nodes().map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 })));
    };
    const pulled = run(0.15);
    const unpulled = run(0);
    expect(
      pulled < unpulled * 0.8,
      `pulled spread ${pulled.toFixed(1)} should be well under ${unpulled.toFixed(1)}`,
    ).toBeTruthy();
    expect(pulled > 0, "spread is finite/positive").toBeTruthy();
  });
});

describe("depths over the LOGICAL graph (physics arc, owner 2026-09-30)", () => {
  it("a multi-premise conclusion sits at premises'+1 — NOT +2 — over logical edges", () => {
    const props = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const logical = [
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ];
    const depths = inferenceDepths(props, logical);
    expect(
      depths.get("c"),
      "one inference hop from BOTH premises — the imp point is not a hop",
    ).toBe(1);
  });

  it("the imp node is ABSENT from the rank map (depth is a property of propositions)", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "arg_x" }];
    const logical = [
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ];
    const depths = inferenceDepths(
      nodes.filter((n) => !n.id.startsWith("arg_")),
      logical,
    );
    expect(!depths.has("arg_x"), "geometry points carry no inference rank").toBeTruthy();
    expect(depths.get("c")).toBe(1);
  });

  it("VERTICAL mode: the central pole is horizontal-ONLY for everyone — orphans included (owner, 2026-09-30)", () => {
    const mk = (id: string, x: number, y: number) => ({ id, x, y });
    const sim = createGraphSimulation(
      [mk("a", 0, 0), mk("b", 40, 0), mk("lonely", 500, 400)],
      [{ from: "a", to: "b" }],
      {
        depthAnchor: { mode: "vertical", strength: 1, spacing: 60 },
        gravity: { x: 0, y: 0, strength: 0.1 },
        chargeStrength: 0,
      },
    );
    for (let i = 0; i < 400; i++) sim.tick();
    const pos = new Map(
      sim
        .nodes()
        .map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 }))
        .map((n) => [n.id, n]),
    );
    expect(
      Math.abs(pos.get("lonely")!.x) < 50,
      `lonely x pulled to center (got ${pos.get("lonely")!.x.toFixed(1)})`,
    ).toBeTruthy();
    expect(
      Math.abs(pos.get("lonely")!.y - 400) < 5,
      `lonely y free (got ${pos.get("lonely")!.y.toFixed(1)})`,
    ).toBeTruthy();
  });

  it("the IMP MIDPOINT ANCHOR: the junction pins halfway between premises and conclusion (owner, 2026-09-30)", () => {
    const mk = (id: string, x: number, y: number) => ({ id, x, y });
    const sim = createGraphSimulation(
      [mk("a", 0, 0), mk("b", 40, 0), mk("c", 0, -480), mk("arg_x", 20, -100)],
      [
        { from: "a", to: "arg_x" },
        { from: "b", to: "arg_x" },
        { from: "arg_x", to: "c" },
      ],
      {
        logicalEdges: [
          { from: "a", to: "c" },
          { from: "b", to: "c" },
        ],
        impLinks: [{ id: "arg_x", premises: ["a", "b"], conclusion: "c" }],
        depthAnchor: { mode: "vertical", strength: 1, spacing: 500 },
        gravity: { x: 0, y: 0, strength: 0.1 },
        chargeStrength: 0,
        linkStrength: 0.05,
      },
    );
    for (let i = 0; i < 400; i++) sim.tick();
    const pos = new Map(
      sim
        .nodes()
        .map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 }))
        .map((n) => [n.id, n]),
    );
    expect(
      Math.abs(pos.get("a")!.y) < 50,
      `a on row 0 (got ${pos.get("a")!.y.toFixed(1)})`,
    ).toBeTruthy();
    expect(
      Math.abs(pos.get("b")!.y) < 50,
      `b on row 0 (got ${pos.get("b")!.y.toFixed(1)})`,
    ).toBeTruthy();
    expect(
      Math.abs(pos.get("c")!.y + 500) < 50,
      `c on row 1 (got ${pos.get("c")!.y.toFixed(1)})`,
    ).toBeTruthy();
    expect(
      Math.abs(pos.get("arg_x")!.y + 250) < 40,
      `arg_x on the half-row (got ${pos.get("arg_x")!.y.toFixed(1)})`,
    ).toBeTruthy();
  });

  it("mixed-depth premises: the HIGHEST premise row is the premises side of the average", () => {
    const mk = (id: string, x: number, y: number) => ({ id, x, y });
    const sim = createGraphSimulation(
      [mk("a", 0, 0), mk("b", 10, 0), mk("c", 0, 0), mk("arg_x", 5, 0)],
      [
        { from: "a", to: "arg_x" },
        { from: "b", to: "arg_x" },
        { from: "arg_x", to: "c" },
      ],
      {
        logicalEdges: [
          { from: "a", to: "b" },
          { from: "a", to: "c" },
          { from: "b", to: "c" },
        ],
        impLinks: [{ id: "arg_x", premises: ["a", "b"], conclusion: "c" }],
        depthAnchor: { mode: "vertical", strength: 1, spacing: 400 },
        gravity: { x: 0, y: 0, strength: 0.1 },
        chargeStrength: 0,
        linkStrength: 0.05,
      },
    );
    for (let i = 0; i < 400; i++) sim.tick();
    const pos = new Map(
      sim
        .nodes()
        .map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 }))
        .map((n) => [n.id, n]),
    );
    expect(
      Math.abs(pos.get("a")!.y) < 40,
      `a on row 0 (got ${pos.get("a")!.y.toFixed(1)})`,
    ).toBeTruthy();
    expect(
      Math.abs(pos.get("b")!.y + 400) < 40,
      `b on row 1 (got ${pos.get("b")!.y.toFixed(1)})`,
    ).toBeTruthy();
    expect(
      Math.abs(pos.get("c")!.y + 800) < 40,
      `c on row 2 (got ${pos.get("c")!.y.toFixed(1)})`,
    ).toBeTruthy();
    expect(
      Math.abs(pos.get("arg_x")!.y + 600) < 40,
      `arg_x on the 1.5 half-row (got ${pos.get("arg_x")!.y.toFixed(1)})`,
    ).toBeTruthy();
  });

  it("WITHOUT impLinks the imp node keeps the legacy exemption (never depth-anchored)", () => {
    const mk = (id: string, x: number, y: number) => ({ id, x, y });
    const sim = createGraphSimulation(
      [mk("a", 0, 0), mk("b", 40, 0), mk("c", 0, -480), mk("arg_x", 20, -100)],
      [
        { from: "a", to: "arg_x" },
        { from: "b", to: "arg_x" },
        { from: "arg_x", to: "c" },
      ],
      {
        logicalEdges: [
          { from: "a", to: "c" },
          { from: "b", to: "c" },
        ],
        depthAnchor: { mode: "vertical", strength: 1, spacing: 500 },
        gravity: { x: 0, y: 0, strength: 0.1 },
        chargeStrength: 0,
        linkStrength: 0.05,
      },
    );
    for (let i = 0; i < 400; i++) sim.tick();
    const pos = new Map(
      sim
        .nodes()
        .map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 }))
        .map((n) => [n.id, n]),
    );
    expect(Math.abs(pos.get("c")!.y + 500) < 50, "c on row 1").toBeTruthy();
    expect(
      Math.abs(pos.get("arg_x")!.y) < 250,
      `arg_x unanchored (got ${pos.get("arg_x")!.y.toFixed(1)})`,
    ).toBeTruthy();
  });
});

describe("inferenceDepths (SCC-safe ranking)", () => {
  const nodes = (ids: string[]) => ids.map((id) => ({ id }));

  it("ranks a chain, a diamond takes the longest path, orphans are depth 0", () => {
    const ns = nodes(["a", "b", "c", "d", "loner"]);
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "d" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    const d = inferenceDepths(ns, edges);
    expect(d.get("a")).toBe(0);
    expect(d.get("b")).toBe(1);
    expect(d.get("c")).toBe(2);
    expect(d.get("d")).toBe(3); // longest path, not shortest
    expect(d.get("loner")).toBe(0);
  });

  it("cycles share a depth (mutual support = equal footing)", () => {
    const ns = nodes(["s", "x", "y", "z"]);
    const edges = [
      { from: "s", to: "x" },
      { from: "x", to: "y" },
      { from: "y", to: "x" },
      { from: "x", to: "z" },
    ];
    const d = inferenceDepths(ns, edges);
    expect(d.get("s")).toBe(0);
    expect(d.get("x"), "cycle members share a depth").toBe(d.get("y"));
    expect(d.get("x")).toBe(1);
    expect(d.get("z")).toBe(2);
    expect([...inferenceDepths(ns, edges).entries()]).toEqual([...d.entries()]);
  });
});

describe("depthAnchor force", () => {
  const nodes = (ids: string[]) => ids.map((id) => ({ id, x: 0, y: 0 }));

  it("vertical: the premise lands below its conclusion", () => {
    const ns = nodes(["base", "derived"]);
    const edges = [{ from: "base", to: "derived" }];
    const sim = createGraphSimulation(ns, edges, {
      depthAnchor: { mode: "vertical", strength: 1.2, spacing: 100, center: { x: 0, y: 0 } },
    });
    for (let i = 0; i < 300; i++) sim.tick();
    const byId = new Map(sim.nodes().map((n) => [n.id, n]));
    const baseY = byId.get("base")!.y!;
    const derivedY = byId.get("derived")!.y!;
    expect(
      baseY > derivedY,
      `base (${baseY.toFixed(0)}) should sit BELOW derived (${derivedY.toFixed(0)})`,
    ).toBeTruthy();
    expect(
      baseY - derivedY > 60,
      `level separation should be substantial (got ${(baseY - derivedY).toFixed(0)})`,
    ).toBeTruthy();
  });

  it("radial: inference depth becomes radius", () => {
    const ns = nodes(["base", "mid", "top"]);
    const edges = [
      { from: "base", to: "mid" },
      { from: "mid", to: "top" },
    ];
    const sim = createGraphSimulation(ns, edges, {
      depthAnchor: {
        mode: "radial",
        strength: 1.2,
        spacing: 80,
        baseRadius: 100,
        center: { x: 0, y: 0 },
      },
    });
    for (let i = 0; i < 300; i++) sim.tick();
    const r = (id: string) => {
      const n = sim.nodes().find((x) => x.id === id)!;
      return Math.hypot(n.x!, n.y!);
    };
    expect(
      r("base") < r("mid"),
      `base ring (${r("base").toFixed(0)}) inside mid (${r("mid").toFixed(0)})`,
    ).toBeTruthy();
    expect(
      r("mid") < r("top"),
      `mid ring (${r("mid").toFixed(0)}) inside top (${r("top").toFixed(0)})`,
    ).toBeTruthy();
  });

  it("settle with depthAnchor: old nodes keep x memory but snap to their level", () => {
    const previous = new Map([
      ["old", { x: 250, y: 300 }],
      ["peer", { x: 260, y: 290 }],
    ]);
    const next = incrementalLayout(
      [{ id: "old" }, { id: "peer" }, { id: "child" }],
      [
        { from: "old", to: "child" },
        { from: "peer", to: "child" },
      ],
      previous,
      { depthAnchor: { mode: "vertical", strength: 0.6, spacing: 80 } },
    );
    const old = next.get("old")!;
    expect(
      Math.abs(old.y - 295) < 20,
      `old node snaps to the baseline (y=${old.y.toFixed(1)})`,
    ).toBeTruthy();
    expect(old.x > 150, `x memory preserved (x=${old.x.toFixed(1)})`).toBeTruthy();
    const child = next.get("child")!;
    expect(
      child.y < old.y - 40,
      `child rises above its premises (child=${child.y.toFixed(1)}, old=${old.y.toFixed(1)})`,
    ).toBeTruthy();
  });

  it("orphans are exempt from depth anchoring — y is FREE, the pole is horizontal (ORPHAN RULE, amended 2026-09-30)", () => {
    const ns = [
      { id: "base", x: 0, y: 0 },
      { id: "derived", x: 10, y: 0 },
      { id: "loner", x: 400, y: -80 },
    ];
    const sim = createGraphSimulation(ns, [{ from: "base", to: "derived" }], {
      gravity: { x: 0, y: 500, strength: 0.1 },
      depthAnchor: { mode: "vertical", strength: 1.5, spacing: 120, center: { x: 0, y: 0 } },
      chargeStrength: 0,
    });
    for (let i = 0; i < 400; i++) sim.tick();
    const byId = new Map(sim.nodes().map((n) => [n.id, n]));
    expect(
      Math.abs(byId.get("base")!.y!) < 40,
      "structured base sits on the baseline",
    ).toBeTruthy();
    expect(byId.get("derived")!.y! < -60, "derived rises a level").toBeTruthy();
    const loner = byId.get("loner")!;
    expect(
      Math.abs(loner.y! - -80) < 5,
      `the orphan's y is untouched (y=${loner.y!.toFixed(0)})`,
    ).toBeTruthy();
    expect(
      Math.abs(loner.x!) < 60,
      `the orphan still converges on the pole horizontally (x=${loner.x!.toFixed(0)})`,
    ).toBeTruthy();
  });

  it("radial: orphans are exempt — they gather at the center, not on the base ring", () => {
    const ns = [
      { id: "base", x: 0, y: 0 },
      { id: "mid", x: 10, y: 0 },
      { id: "loner", x: 300, y: 300 },
    ];
    const sim = createGraphSimulation(ns, [{ from: "base", to: "mid" }], {
      gravity: { x: 0, y: 0, strength: 0.1 },
      depthAnchor: {
        mode: "radial",
        strength: 1.5,
        spacing: 80,
        baseRadius: 150,
        center: { x: 0, y: 0 },
      },
    });
    for (let i = 0; i < 400; i++) sim.tick();
    const r = (id: string) => {
      const n = sim.nodes().find((x) => x.id === id)!;
      return Math.hypot(n.x!, n.y!);
    };
    expect(
      Math.abs(r("base") - 150) < 40,
      `base sits on the base ring (r=${r("base").toFixed(0)})`,
    ).toBeTruthy();
    expect(
      r("loner") < 60,
      `the orphan follows gravity to the center, not the ring (r=${r("loner").toFixed(0)})`,
    ).toBeTruthy();
  });
});
