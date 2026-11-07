import { describe, expect, it } from "vite-plus/test";

import { physicsResultFromToolItem } from "./payloads";

const sim = {
  path: "sims/pendulum.sim.js",
  title: "Pendulum",
  ok: true,
  errors: [],
  hash: "h1",
};

describe("physicsResultFromToolItem", () => {
  it("reads structuredContent in any provider spelling", () => {
    const output = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { physicsSim: sim },
    };
    for (const toolName of ["mcp__t3-code__sim_show", "t3-code.sim_show", "sim_show"]) {
      expect(physicsResultFromToolItem({ toolName, output })).toEqual({ kind: "sim", sim });
    }
  });

  it("reads JSON text content", () => {
    const board = { board: "main", revision: 3, createdIds: ["item-1"] };
    const output = [{ type: "text", text: JSON.stringify({ physicsBoard: board }) }];
    expect(physicsResultFromToolItem({ toolName: "mcp__t3-code__board_write", output })).toEqual({
      kind: "board",
      board: { ...board, createdCount: 1 },
    });
  });

  it("ignores other tools, errors and malformed payloads", () => {
    const output = { structuredContent: { physicsSim: sim } };
    expect(
      physicsResultFromToolItem({ toolName: "mcp__t3-code__html_render", output }),
    ).toBeUndefined();
    expect(
      physicsResultFromToolItem({
        toolName: "sim_show",
        output: { isError: true, structuredContent: { physicsSim: sim } },
      }),
    ).toBeUndefined();
  });
});

it("keeps visual_show metadata through compact tool output and provider envelopes", () => {
  const physicsVisual = {
    path: "visuals/assignment.html",
    hash: "abc",
    step: 1,
    steps: [{ label: "Pool" }, { label: "Assign", duration: 1500 }],
  };
  for (const output of [
    { physicsVisual },
    { content: [{ type: "text", text: JSON.stringify({ physicsVisual }) }] },
  ]) {
    expect(physicsResultFromToolItem({ toolName: "mcp__t3-code__visual_show", output })).toEqual({
      kind: "visual",
      visual: {
        path: physicsVisual.path,
        hash: physicsVisual.hash,
        step: physicsVisual.step,
        label: "Assign",
      },
    });
  }
});
