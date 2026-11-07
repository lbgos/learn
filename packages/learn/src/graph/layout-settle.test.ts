// Ported from learnharness (AGPL-3.0-only) tests/layout.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import { settleGraphLayout } from "./layout-settle.ts";
import { ledgers, node, chain } from "./test-fixtures.ts";
import { chainsForSelection, formatChainLine, resolveTargetId } from "./chains.ts";
describe("pure layout settle", () => {
  it("dedupes raw lines and lays out only live propositions and multi-premise junctions", () => {
    const original = ledgers({
      nodes: [node("n_a"), node("n_b"), node("n_c"), node("n_d"), node("n_a")],
      chains: [
        chain("arg_ab", ["n_a"], "n_b"),
        chain("arg_bcd", ["n_b", "n_c"], "n_d"),
        chain("arg_bad", ["missing"], "n_d"),
      ],
      positions: { stale: { x: 4, y: 2 } },
    });
    const positions = settleGraphLayout(original);
    expect(Object.keys(positions).sort()).toEqual(["arg_bcd", "n_a", "n_b", "n_c", "n_d"]);
    expect(positions).toEqual(settleGraphLayout(original));
    expect(original.positions).toEqual({ stale: { x: 4, y: 2 } });
  });
  it("returns an empty replacement ledger for an empty graph", () => {
    expect(settleGraphLayout(ledgers({ positions: { stale: { x: 1, y: 2 } } }))).toEqual({});
  });
});
describe("selection chain views", () => {
  it("includes only fully selected arguments, retaining independent routes and singletons", () => {
    const selected = ["n_a", "n_b", "n_c", "n_lone"].map((id) => node(id));
    const chains = [
      chain("arg_a", ["n_a"], "n_c"),
      chain("arg_b", ["n_b"], "n_c"),
      chain("arg_missing", ["n_other"], "n_c"),
    ];
    const result = chainsForSelection(selected, chains);
    expect(result.map((c) => c.id)).toEqual(["arg_a", "arg_b", "n_lone"]);
    expect(formatChainLine(result[0]!, Object.fromEntries(selected.map((n) => [n.id, n])))).toBe(
      "n_a → n_c",
    );
    expect(resolveTargetId(' :"n_a" ', selected)).toBe("n_a");
    expect(resolveTargetId("absent", selected)).toBeNull();
  });
});
