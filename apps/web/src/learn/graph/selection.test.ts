import { describe, expect, it } from "vite-plus/test";
import { graphSnapshot } from "@t3tools/learn/graph";
import { fixtureLedgers } from "./fixture";
import { propositionIds, selectionContext } from "./selection";

describe("graph selection", () => {
  const snapshot = graphSnapshot(fixtureLedgers());
  it("expands implication selections, deduplicates and formats one line per proposition and complete chain", () => {
    expect(propositionIds(snapshot, ["arg_newton", "n_force", "gone"])).toEqual([
      "n_force",
      "n_mass",
      "n_acceleration",
    ]);
    expect(selectionContext(snapshot, ["arg_newton"])).toBe(
      [
        "[graph context]",
        "n_force: Force: A net force changes momentum.",
        "n_mass: Mass: Mass measures inertia.",
        "n_acceleration: Acceleration: Newton's law gives $F = ma$.",
        "arg_newton: n_force ∧ n_mass → n_acceleration",
      ].join("\n"),
    );
    expect(selectionContext(snapshot, ["n_force"])).not.toContain("arg_newton");
  });
});
