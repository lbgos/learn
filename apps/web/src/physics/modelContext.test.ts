import { describe, expect, it } from "vite-plus/test";

import type { SessionEvent } from "@t3tools/learn/session";
import {
  boardContextText,
  visualContextKey,
  visualContextText,
  simContextText,
  sessionContextKey,
  sessionContextText,
} from "./modelContext";

const meta = {
  title: "Pendulum",
  view: "3d",
  params: { L: { value: 1, unit: "m" }, b: { value: 0.1, unit: "1/s" } },
  observables: [],
  plots: [],
} as const;

describe("simContextText", () => {
  it("describes parameters, state and the last change", () => {
    expect(
      simContextText({
        path: "sims/pendulum.sim.js",
        meta: { ...meta, params: { ...meta.params }, observables: [], plots: [] },
        params: { L: 2.4, b: 0.1 },
        t: 12.3456,
        playing: false,
        lastChange: { name: "L", from: 1, to: 2.4 },
      }),
    ).toBe(
      "Learner has sims/pendulum.sim.js open. L=2.4 m, b=0.1 1/s. t=12.35 s, paused. Last change: L 1 → 2.4 m.",
    );
  });
});

describe("boardContextText", () => {
  it("counts what changed and is empty when nothing did", () => {
    expect(
      boardContextText({
        name: "main",
        revision: 42,
        tally: { added: { ink: 5, math: 1 }, updated: 0, removed: 0 },
      }),
    ).toBe(
      "Learner edited board main (rev 42): 5 new strokes, 1 math item since the agent's last write.",
    );
    expect(
      boardContextText({
        name: "main",
        revision: 42,
        tally: { added: {}, updated: 0, removed: 0 },
      }),
    ).toBe("");
  });
});

describe("sessionContextText", () => {
  it("publishes the shared phase and plan context with pending questions", () => {
    const events: SessionEvent[] = [
      {
        type: "tool-call",
        id: "done",
        name: "probe_done",
        at: "2026-10-24",
        input: { assessment: { strands: [{ strand: "Force", assessment: "Ready" }] } },
      },
      {
        type: "tool-call",
        id: "plan",
        name: "plan_init",
        at: "2026-10-24",
        input: { mermaid: "graph TD\nforce[Force] --> motion[Motion]" },
      },
      {
        type: "tool-call",
        id: "q1",
        name: "explain",
        at: "2026-10-24",
        input: {
          type: "check",
          nodeId: "force",
          question: "Why does it move?",
          correctAnswer: "F = ma",
        },
      },
    ];
    expect(sessionContextKey).toBe("physics:session");
    const teach = sessionContextText({ events, kind: "teach", mechanic: "recall" });
    expect(teach).toMatch(
      /^session: teach\nphase: teach\nmechanic: recall \(preferred; quiz and explain are both available\)\nplan: current force; visited none\n/,
    );
    expect(teach).toContain("pending question: q1 (explain): Why does it move?");
    expect(teach).toContain("# Teach sessions");
    expect(teach).not.toContain("# Practice sessions");
    const practice = sessionContextText({ events: [], kind: "practice", mechanic: "choice" });
    expect(practice).toMatch(/^session: practice\n/);
    expect(practice).toContain("# Practice sessions");
    expect(practice).not.toContain("# Teach sessions");
  });
});

it("reports the open visual and its zero-based step after learner seeks", () => {
  expect(visualContextKey("visuals/assignment.html")).toBe(
    "physics:visual:visuals/assignment.html",
  );
  expect(
    visualContextText({
      path: "visuals/assignment.html",
      step: 1,
      labels: ["Pool", "Assign"],
      t: 0.5,
      playing: false,
    }),
  ).toBe(
    "Learner has visuals/assignment.html open at step 1 of 2 (zero-based): Assign. t=0.5, paused.",
  );
});
