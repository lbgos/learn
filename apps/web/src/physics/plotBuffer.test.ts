import { describe, expect, it } from "vite-plus/test";

import { SampleRing } from "./plotBuffer";

describe("SampleRing", () => {
  it("keeps the newest rows once full", () => {
    const ring = new SampleRing(2, 3);
    ring.push([
      [0, 10],
      [1, 11],
      [2, 12],
      [3, 13],
    ]);
    expect(ring.series(1, 10)).toEqual({ x: [1, 2, 3], y: [11, 12, 13] });
  });

  it("starts over when time goes backwards after a reset", () => {
    const ring = new SampleRing(2, 10);
    ring.push([
      [0, 1],
      [5, 2],
    ]);
    ring.push([[0, 9]]);
    expect(ring.series(1, 10)).toEqual({ x: [0], y: [9] });
  });

  it("replaces the t=0 row when the sim restarts before it ever advanced", () => {
    const ring = new SampleRing(2, 10);
    ring.push([[0, 1.2]]);
    ring.push([[0, 0.6]]);
    expect(ring.series(1, 10)).toEqual({ x: [0], y: [0.6] });
  });

  it("keeps spikes when decimating", () => {
    const ring = new SampleRing(2, 1000);
    ring.push(Array.from({ length: 1000 }, (_, i) => [i, i === 503 ? 100 : 0]));
    const { x, y } = ring.series(1, 40);
    expect(x.length).toBeLessThanOrEqual(40);
    expect(Math.max(...y)).toBe(100);
    expect(x).toEqual([...x].sort((a, b) => a - b));
  });
});
