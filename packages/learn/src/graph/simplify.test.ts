// Ported from learnharness (AGPL-3.0-only) tests/extraction.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import { simplifyChains } from "./derive.ts";
import type { GraphChain } from "./model.ts";
describe("chain simplification (the merger's maintenance pass, owner 2026-09-30 evening)", () => {
  const chain = (
    id: string,
    premises: string[],
    conclusion: string,
    createdAt: string,
  ): GraphChain => ({
    id,
    premises,
    conclusion,
    createdAt,
    provenance: [{ chatId: "src_1", messageId: "" }],
  });

  it("the owner example: [A,B]⇒X + [X,C]⇒Y make [A,B,C]⇒Y redundant (ancestry-cover)", () => {
    const kept = simplifyChains([
      chain("arg_3", ["n_a", "n_b", "n_c"], "n_y", "2026-09-30T03:00:00.000Z"),
      chain("arg_1", ["n_a", "n_b"], "n_x", "2026-09-30T01:00:00.000Z"),
      chain("arg_2", ["n_x", "n_c"], "n_y", "2026-09-30T02:00:00.000Z"),
    ]);
    expect(kept.map((c) => c.id).sort()).toEqual(["arg_1", "arg_2"]);
  });

  it("prefer-fewest-premises: a strict premise-superset of a kept chain drops", () => {
    const kept = simplifyChains([
      chain("arg_1", ["n_a"], "n_z", "2026-09-30T01:00:00.000Z"),
      chain("arg_2", ["n_a", "n_b"], "n_z", "2026-09-30T02:00:00.000Z"),
    ]);
    expect(kept.map((c) => c.id)).toEqual(["arg_1"]);
  });

  it("genuinely different routes to one conclusion stand; a superset route yields to the lean one", () => {
    const kept = simplifyChains([
      chain("arg_1", ["n_a"], "n_y", "2026-09-30T01:00:00.000Z"),
      chain("arg_2", ["n_b"], "n_y", "2026-09-30T02:00:00.000Z"),
      chain("arg_3", ["n_c", "n_d"], "n_y", "2026-09-30T03:00:00.000Z"),
      chain("arg_4", ["n_a", "n_c"], "n_y", "2026-09-30T04:00:00.000Z"),
    ]);
    expect(kept.map((c) => c.id).sort()).toEqual(["arg_1", "arg_2", "arg_3"]);
  });

  it("ancestry reaches transitively: [W]⇒A chains through [A,B]⇒X", () => {
    const kept = simplifyChains([
      chain("arg_1", ["n_w"], "n_a", "2026-09-30T01:00:00.000Z"),
      chain("arg_2", ["n_a", "n_b"], "n_x", "2026-09-30T02:00:00.000Z"),
      chain("arg_3", ["n_x", "n_c"], "n_y", "2026-09-30T03:00:00.000Z"),
      chain("arg_4", ["n_w", "n_b", "n_c"], "n_y", "2026-09-30T04:00:00.000Z"),
    ]);
    expect(kept.map((c) => c.id).sort()).toEqual(["arg_1", "arg_2", "arg_3"]);
  });

  it("same-key provenance lines drop TOGETHER (a key is kept or dropped as a whole)", () => {
    const kept = simplifyChains([
      chain("arg_1", ["n_a"], "n_z", "2026-09-30T01:00:00.000Z"),
      {
        ...chain("arg_1", ["n_a"], "n_z", "2026-09-30T01:00:00.000Z"),
        provenance: [{ chatId: "src_2", messageId: "" }],
      },
      chain("arg_2", ["n_a", "n_b"], "n_z", "2026-09-30T02:00:00.000Z"),
      {
        ...chain("arg_2", ["n_a", "n_b"], "n_z", "2026-09-30T02:00:00.000Z"),
        provenance: [{ chatId: "src_2", messageId: "" }],
      },
    ]);
    expect(
      kept.map((c) => c.id),
      "the superset key's every line went, the kept key's every line stayed",
    ).toEqual(["arg_1", "arg_1"]);
  });
  it("keeps an independent argument when an alternate route lacks a joint premise", () => {
    const lines = [
      chain("arg_ab", ["n_a", "n_b"], "n_x", "2026-09-30T01:00:00Z"),
      chain("arg_xy", ["n_x"], "n_y", "2026-09-30T02:00:00Z"),
      chain("arg_ay", ["n_a"], "n_y", "2026-09-30T03:00:00Z"),
    ];
    expect(simplifyChains(lines).map((line) => line.id)).toEqual(["arg_ab", "arg_xy", "arg_ay"]);
  });
});
