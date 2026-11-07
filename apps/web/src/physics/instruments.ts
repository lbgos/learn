/**
 * Lab instruments of the sim panel, as plain data and pure functions: a stopwatch in simulated
 * time (manual laps or auto-laps on an observable crossing), a recording of sample rows, the board
 * items they become, and the model-context sentence the tutor reads. `SimHost` holds the state;
 * the runtime reports probe readouts and crossings (see `SimInstruments` in `@t3tools/physics/sim`).
 */
import type { BoardAddItem } from "@t3tools/physics/board";
import {
  intervals,
  intervalStats,
  type CrossingSpec,
  type IntervalStats,
} from "@t3tools/physics/measure";
import type { SimProbeReadout } from "@t3tools/physics/sim";

import { formatQuantity } from "./modelContext";

export interface Stopwatch {
  readonly running: boolean;
  /** Simulated time of the last start; null before the first. */
  readonly startedAt: number | null;
  readonly stoppedAt: number | null;
  /** Lap boundaries. Manual: the start and every lap press. Auto: every crossing after start. */
  readonly marks: readonly number[];
}

export const IDLE_STOPWATCH: Stopwatch = {
  running: false,
  startedAt: null,
  stoppedAt: null,
  marks: [],
};

/** Starting clears the previous run. An auto stopwatch waits for the first crossing. */
export const startStopwatch = (t: number, auto: boolean): Stopwatch => ({
  running: true,
  startedAt: t,
  stoppedAt: null,
  marks: auto ? [] : [t],
});

export const stopStopwatch = (watch: Stopwatch, t: number): Stopwatch =>
  watch.running ? { ...watch, running: false, stoppedAt: t } : watch;

/** A manual lap press or a crossing; ignored unless running and not before the start. */
export const markStopwatch = (watch: Stopwatch, t: number): Stopwatch =>
  watch.running && watch.startedAt !== null && t >= watch.startedAt
    ? { ...watch, marks: [...watch.marks, t] }
    : watch;

export const stopwatchLaps = (watch: Stopwatch) => intervals(watch.marks);

/** Seconds on the dial: from start to now while running, to the stop afterwards. */
export function stopwatchElapsed(watch: Stopwatch, now: number): number {
  if (watch.startedAt === null) return 0;
  return Math.max(0, (watch.running ? now : (watch.stoppedAt ?? now)) - watch.startedAt);
}

/** Sample rows `[t, ...observables]` collected between record and stop. */
export interface Recording {
  readonly active: boolean;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly number[])[];
}

/** At most `count` rows, evenly spaced, always keeping the first and last. */
export function decimateRows<T>(rows: readonly T[], count: number): T[] {
  if (rows.length <= count) return [...rows];
  if (count < 2) return rows.slice(0, count);
  return Array.from(
    { length: count },
    (_, i) => rows[Math.round((i * (rows.length - 1)) / (count - 1))]!,
  );
}

const directionWord = (spec: CrossingSpec) => (spec.direction === "up" ? "upward" : "downward");

export function statsText(stats: IntervalStats): string {
  return `${stats.n} ${stats.n === 1 ? "lap" : "laps"}, mean ${formatQuantity(stats.mean)} s${stats.sd === null ? "" : `, sd ${formatQuantity(stats.sd)} s`}`;
}

/** Lap times as a two-column table; the label carries the trigger and the statistics. */
export function lapTableItem(laps: readonly number[], crossing: CrossingSpec | null): BoardAddItem {
  const stats = intervalStats(laps);
  const trigger = crossing
    ? `${crossing.observable} crossing ${formatQuantity(crossing.value)} ${directionWord(crossing)}`
    : "manual laps";
  return {
    kind: "table",
    columns: ["lap", "T (s)"],
    rows: laps.map((lap, i) => [i + 1, lap]),
    label: `Stopwatch, ${trigger}${stats ? `: ${statsText(stats)}` : ""}`,
  };
}

const recordingLabel = (recording: Recording) => {
  const first = recording.rows[0]?.[0] ?? 0;
  const last = recording.rows.at(-1)?.[0] ?? first;
  return `Recorded t = ${formatQuantity(first)}…${formatQuantity(last)} s, ${recording.rows.length} samples`;
};

/** A compact table: at most 25 evenly spaced rows of the recording. */
export function recordingTableItem(recording: Recording): BoardAddItem {
  return {
    kind: "table",
    columns: [...recording.columns],
    rows: decimateRows(recording.rows, 25).map((row) => [...row]),
    label: recordingLabel(recording),
  };
}

/** Every observable against time, at most 400 points each. */
export function recordingPlotItem(recording: Recording): BoardAddItem {
  return {
    kind: "table",
    view: "plot",
    columns: [...recording.columns],
    rows: decimateRows(recording.rows, 400).map((row) => [...row]),
    w: 480,
    h: 240,
    label: recordingLabel(recording),
  };
}

const vector = (values: readonly number[]) => `(${values.map(formatQuantity).join(", ")})`;

/**
 * The instrument part of the `physics:sim:<path>` note; empty when no instrument is in use.
 * Readouts are as of the last pause or step: while playing they change every frame.
 */
export function instrumentContextText(input: {
  readonly playing: boolean;
  readonly readouts: readonly SimProbeReadout[];
  readonly crossing: CrossingSpec | null;
  readonly stopwatch: Stopwatch;
  readonly recording: Recording | null;
}): string {
  const parts: string[] = [];
  if (input.readouts.length > 0) {
    const probes = input.readouts.map((readout) =>
      input.playing
        ? readout.label
        : `${readout.label} at ${vector(readout.position)} m${readout.velocity ? `, v ${vector(readout.velocity)} m/s` : ""}`,
    );
    parts.push(
      `Probes${input.playing ? " (values change while playing)" : ""}: ${probes.join("; ")}.`,
    );
  }
  const { stopwatch, crossing } = input;
  if (stopwatch.startedAt !== null) {
    const laps = stopwatchLaps(stopwatch);
    const stats = intervalStats(laps);
    const trigger = crossing
      ? `auto-lap on ${crossing.observable} crossing ${formatQuantity(crossing.value)} ${directionWord(crossing)}`
      : "manual laps";
    const listed = laps.slice(-20).map(formatQuantity).join(", ");
    parts.push(
      `Stopwatch (${trigger}, ${stopwatch.running ? "running" : "stopped"}): ${stats ? `${statsText(stats)}; laps ${laps.length > 20 ? "…, " : ""}${listed} s` : "no laps yet"}.`,
    );
  }
  const { recording } = input;
  if (recording && (recording.active || recording.rows.length > 0))
    parts.push(
      `${recording.active ? "Recording" : `Recorded ${recording.rows.length}`} samples of ${recording.columns.slice(1).join(", ")}.`,
    );
  return parts.join(" ");
}
