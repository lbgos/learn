import { describe, expect, it } from "vite-plus/test";

import {
  decimateRows,
  IDLE_STOPWATCH,
  instrumentContextText,
  lapTableItem,
  markStopwatch,
  startStopwatch,
  stopStopwatch,
  stopwatchElapsed,
  stopwatchLaps,
} from "./instruments";

const bob = {
  path: "4",
  label: "bob",
  position: [0.5646, -0.8253, 0] as [number, number, number],
  velocity: [1.234, 0.8442, 0] as [number, number, number],
};
const theta = { observable: "θ (rad)", value: 0, direction: "up" } as const;

describe("stopwatch", () => {
  it("auto-laps on crossings after the start and freezes the dial at stop", () => {
    let watch = startStopwatch(1.5, true);
    watch = markStopwatch(watch, 1.4); // before the start: ignored
    for (const t of [2.1, 4.1, 6.2]) watch = markStopwatch(watch, t);
    watch = stopStopwatch(watch, 7);
    watch = markStopwatch(watch, 8.2); // after the stop: ignored
    expect(stopwatchLaps(watch).map((lap) => Number(lap.toFixed(9)))).toEqual([2, 2.1]);
    expect(stopwatchElapsed(watch, 99)).toBeCloseTo(5.5, 12);
  });

  it("starts a manual run with a mark at the start", () => {
    const watch = markStopwatch(startStopwatch(2, false), 3.25);
    expect(stopwatchLaps(watch)).toEqual([1.25]);
    expect(stopwatchElapsed(watch, 4)).toBe(2);
  });
});

describe("decimateRows", () => {
  it("keeps the first and last rows and spaces the rest evenly", () => {
    expect(decimateRows([0, 1, 2, 3, 4, 5, 6, 7, 8], 3)).toEqual([0, 4, 8]);
    expect(decimateRows([0, 1], 5)).toEqual([0, 1]);
  });
});

describe("instrumentContextText", () => {
  it("is empty when no instrument is in use", () => {
    expect(
      instrumentContextText({
        playing: false,
        readouts: [],
        crossing: null,
        stopwatch: IDLE_STOPWATCH,
        recording: null,
      }),
    ).toBe("");
  });

  it("reports paused readouts, the lap trigger with statistics, and the recording", () => {
    let stopwatch = startStopwatch(0, true);
    for (const t of [0.5, 2.5066, 4.5131, 6.5199]) stopwatch = markStopwatch(stopwatch, t);
    expect(
      instrumentContextText({
        playing: false,
        readouts: [bob, { ...bob, label: "sphere 1", velocity: null }],
        crossing: theta,
        stopwatch: stopStopwatch(stopwatch, 7),
        recording: {
          active: false,
          columns: ["t (s)", "θ (rad)"],
          rows: [
            [0, 1],
            [0.05, 0.9],
          ],
        },
      }),
    ).toBe(
      "Probes: bob at (0.5646, -0.8253, 0) m, v (1.234, 0.8442, 0) m/s; sphere 1 at (0.5646, -0.8253, 0) m. " +
        "Stopwatch (auto-lap on θ (rad) crossing 0 upward, stopped): 3 laps, mean 2.007 s, sd 0.0001528 s; laps 2.007, 2.006, 2.007 s. " +
        "Recorded 2 samples of θ (rad).",
    );
  });

  it("names probes without stale values while playing", () => {
    expect(
      instrumentContextText({
        playing: true,
        readouts: [bob],
        crossing: null,
        stopwatch: startStopwatch(1, false),
        recording: { active: true, columns: ["t (s)", "x (m)"], rows: [] },
      }),
    ).toBe(
      "Probes (values change while playing): bob. Stopwatch (manual laps, running): no laps yet. Recording samples of x (m).",
    );
  });
});

describe("lapTableItem", () => {
  it("puts the trigger and statistics in the label", () => {
    expect(lapTableItem([2, 2.002], theta)).toEqual({
      kind: "table",
      columns: ["lap", "T (s)"],
      rows: [
        [1, 2],
        [2, 2.002],
      ],
      label: "Stopwatch, θ (rad) crossing 0 upward: 2 laps, mean 2.001 s, sd 0.001414 s",
    });
  });
});
