import type { SimDefinition, SimParams, SimState } from "./types.ts";

/** Validate every field before rendering, and reject changed derivative shapes. */
export function assertFiniteState(state: SimState): void {
  if (state === null || typeof state !== "object" || Array.isArray(state))
    throw new Error("State must be an object of numbers or number arrays.");
  for (const [key, value] of Object.entries(state)) {
    if (
      typeof value === "number"
        ? !Number.isFinite(value)
        : !Array.isArray(value) ||
          [...value].some((v) => typeof v !== "number" || !Number.isFinite(v))
    ) {
      throw new Error(`Non-finite or invalid state field: ${key}`);
    }
  }
}

function combine(state: SimState, terms: readonly (readonly [SimState, number])[]): SimState {
  const result: SimState = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === "number") {
      let sum = value;
      for (const [rate, factor] of terms) {
        const entry = rate[key];
        if (typeof entry !== "number") throw new Error(`Derivative shape differs at ${key}`);
        sum += entry * factor;
      }
      result[key] = sum;
    } else {
      result[key] = value.map((v, i) => {
        let sum = v;
        for (const [rate, factor] of terms) {
          const entry = rate[key];
          if (
            !Array.isArray(entry) ||
            entry.length !== value.length ||
            typeof entry[i] !== "number"
          )
            throw new Error(`Derivative shape differs at ${key}`);
          sum += entry[i] * factor;
        }
        return sum;
      });
    }
  }
  return result;
}

function verlet(
  state: SimState,
  derive: NonNullable<SimDefinition["derive"]>,
  params: SimParams,
  dt: number,
  t: number,
): SimState {
  const pairs = [
    ["position", "velocity"],
    ["theta", "omega"],
    ["x", "vx"],
    ["y", "vy"],
    ["z", "vz"],
  ] as const;
  const active = pairs.filter(([q, v]) => q in state && v in state);
  const covered = new Set<string>(active.flatMap(([q, v]) => [q, v]));
  if (Object.keys(state).some((key) => !covered.has(key)))
    throw new Error(
      "Verlet needs position/velocity, theta/omega or x/vx, y/vy, z/vz state pairs. Use rk4 or a custom step otherwise.",
    );
  const a = derive(state, params, t);
  const drift: SimState = {};
  for (const [q, v] of active) {
    drift[q] = a[v]!;
    drift[v] = typeof state[v] === "number" ? 0 : (state[v] as number[]).map(() => 0);
  }
  const next = combine(state, [
    [a, dt],
    [drift, (dt * dt) / 2],
  ]);
  // Velocity is predicted for velocity-dependent forces, then corrected by the averaged acceleration.
  const b = derive(next, params, t + dt);
  const rate: SimState = {};
  const finalRate: SimState = {};
  for (const [q, v] of active) {
    rate[q] = finalRate[q] = typeof state[q] === "number" ? 0 : (state[q] as number[]).map(() => 0);
    rate[v] = a[v]!;
    finalRate[v] = b[v]!;
  }
  const corrected = combine(state, [
    [rate, dt / 2],
    [finalRate, dt / 2],
  ]);
  for (const [q] of active) corrected[q] = next[q]!;
  return corrected;
}

export function integrate(
  definition: SimDefinition,
  state: SimState,
  params: SimParams,
  dt: number,
  t: number,
): SimState {
  let next: SimState;
  if (definition.step) next = definition.step(state, params, dt, t);
  else {
    const derive = definition.derive;
    if (!derive) throw new Error("A simulation needs derive or step.");
    const a = derive(state, params, t);
    switch (definition.integrator ?? "rk4") {
      case "euler":
        next = combine(state, [[a, dt]]);
        break;
      case "verlet":
        next = verlet(state, derive, params, dt, t);
        break;
      case "rk4": {
        const b = derive(combine(state, [[a, dt / 2]]), params, t + dt / 2);
        const c = derive(combine(state, [[b, dt / 2]]), params, t + dt / 2);
        const d = derive(combine(state, [[c, dt]]), params, t + dt);
        next = combine(state, [
          [a, dt / 6],
          [b, dt / 3],
          [c, dt / 3],
          [d, dt / 6],
        ]);
        break;
      }
    }
  }
  assertFiniteState(next);
  return next;
}
