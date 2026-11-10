import { describe, expect, it } from "vite-plus/test";
import { distractors, goldNotes, questions } from "./cases.ts";
import { allVisible, percentile, recallAt } from "./grade.ts";

describe("learner memory grading", () => {
  it("counts gold notes in the top k, and nothing expected as found", () => {
    expect(recallAt(["a", "b", "c"], ["c", "d"], 3)).toBe(0.5);
    expect(recallAt(["a", "b", "c"], ["c"], 2)).toBe(0);
    expect(recallAt([], [], 5)).toBe(1);
    expect(allVisible(new Set(["a", "b"]), ["a"])).toBe(true);
    expect(allVisible(new Set(["a"]), ["a", "b"])).toBe(false);
  });

  it("takes the nearest-rank percentile", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  });

  it("pads the set with unique distractors and names only real gold notes", () => {
    const padded = distractors(500);
    expect(padded.length + Object.keys(goldNotes).length).toBe(500);
    expect(new Set(padded.map((note) => note.text)).size).toBe(padded.length);
    for (const question of questions)
      for (const key of [...question.gold, ...(question.older ? [question.older] : [])])
        expect(goldNotes).toHaveProperty(key);
  });
});
