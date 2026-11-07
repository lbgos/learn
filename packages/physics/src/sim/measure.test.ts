import { describe, expect, it } from "vite-plus/test";
import { findCrossings, intervals, intervalStats } from "./measure.ts";

describe("findCrossings", () => {
  it("interpolates between the samples that straddle the level", () => {
    expect(
      findCrossings(
        [
          [0, -1],
          [1, 3],
        ],
        { value: 0, direction: "up" },
      ),
    ).toEqual([0.25]);
    expect(
      findCrossings(
        [
          [2, 1],
          [3, 0.5],
          [4, -1.5],
        ],
        { value: 0, direction: "down" },
      ),
    ).toEqual([3.25]);
  });

  it("counts only the chosen direction", () => {
    const wave = Array.from(
      { length: 401 },
      (_, i) => [i / 100, Math.sin(Math.PI * (i / 100))] as const,
    );
    const up = findCrossings(wave, { value: 0, direction: "up" });
    const down = findCrossings(wave, { value: 0, direction: "down" });
    // sin(πt) rises through 0 at t = 2 and falls through it at t = 1 and 3; t = 0 has no prior side.
    expect(up).toHaveLength(1);
    expect(up[0]).toBeCloseTo(2, 12);
    expect(down.map((t) => Number(t.toFixed(9)))).toEqual([1, 3]);
  });

  it("counts a sample exactly on the level once, at that sample, and ignores a touch", () => {
    expect(
      findCrossings(
        [
          [0, -1],
          [1, 0],
          [2, 0],
          [3, 1],
        ],
        { value: 0, direction: "up" },
      ),
    ).toEqual([1]);
    expect(
      findCrossings(
        [
          [0, -1],
          [1, 0],
          [2, -1],
          [3, 0.5],
        ],
        { value: 0, direction: "up" },
      ),
    ).toEqual([2 + 2 / 3]);
  });

  it("uses a nonzero level", () => {
    expect(
      findCrossings(
        [
          [0, 1],
          [1, 3],
        ],
        { value: 2.5, direction: "up" },
      ),
    ).toEqual([0.75]);
  });
});

describe("intervalStats", () => {
  it("returns mean and sample standard deviation of laps", () => {
    const stats = intervalStats(intervals([0.5, 2.5, 4.4, 6.5]));
    expect(stats?.n).toBe(3);
    expect(stats?.mean).toBeCloseTo(2, 12);
    expect(stats?.sd).toBeCloseTo(0.1, 12);
  });

  it("has no spread for one lap and no stats for none", () => {
    expect(intervalStats([2])).toEqual({ n: 1, mean: 2, sd: null });
    expect(intervalStats([])).toBeNull();
  });
});
