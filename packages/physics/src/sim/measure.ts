/**
 * Event timing shared by the sim runtime (per physics step, interactive auto-lap and headless
 * `sim_measure`) and the web stopwatch (lap statistics). Pure and dependency-free, so the web can
 * import it through `@t3tools/physics/measure` without loading the three.js runtime bundle.
 */

export type CrossingDirection = "up" | "down";

export interface CrossingSpec {
  /** Observable name, as in `SimMeta.observables`. */
  readonly observable: string;
  /** Level the observable crosses. */
  readonly value: number;
  /** "up" counts rising crossings (below to above), "down" falling ones. */
  readonly direction: CrossingDirection;
}

export interface CrossingDetector {
  /** Feed samples in time order; returns the crossing time when this sample completes one. */
  readonly push: (t: number, x: number) => number | null;
  /** Forget history, e.g. after the sim restarts. */
  readonly reset: () => void;
}

/**
 * Streaming level-crossing detector. A crossing is a change of side, ignoring samples that land
 * exactly on the level: -1, 0, 1 is one crossing at the 0 sample, and -1, 0, -1 is none. Between
 * two off-level samples the time is linearly interpolated.
 */
export function createCrossingDetector(
  spec: Pick<CrossingSpec, "value" | "direction">,
): CrossingDetector {
  const { value, direction } = spec;
  let previous: { t: number; x: number } | null = null;
  let onLevel: number | null = null;
  return {
    push(t, x) {
      if (x === value) {
        onLevel ??= t;
        return null;
      }
      const before = previous;
      const touched = onLevel;
      previous = { t, x };
      onLevel = null;
      if (!before) return null;
      const crossed =
        direction === "up" ? before.x < value && x > value : before.x > value && x < value;
      if (!crossed) return null;
      return touched ?? before.t + ((value - before.x) / (x - before.x)) * (t - before.t);
    },
    reset() {
      previous = null;
      onLevel = null;
    },
  };
}

/** Crossing times in a sampled series; see `createCrossingDetector`. */
export function findCrossings(
  samples: ReadonlyArray<readonly [t: number, x: number]>,
  spec: Pick<CrossingSpec, "value" | "direction">,
): number[] {
  const detector = createCrossingDetector(spec);
  const times: number[] = [];
  for (const [t, x] of samples) {
    const crossing = detector.push(t, x);
    if (crossing !== null) times.push(crossing);
  }
  return times;
}

export interface IntervalStats {
  readonly n: number;
  readonly mean: number;
  /** Sample standard deviation (n − 1); null with fewer than two values. */
  readonly sd: number | null;
}

/** Mean and spread of a list of durations; null when empty. */
export function intervalStats(values: readonly number[]): IntervalStats | null {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const sd =
    n < 2 ? null : Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd };
}

/** Differences between consecutive event times. */
export function intervals(times: readonly number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i]!);
}
