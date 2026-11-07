import { describe, expect, it } from "vite-plus/test";
import { assertFiniteState, integrate } from "./integrators.ts";
import type { SimDefinition, SimState } from "./types.ts";

describe("simulation integration", () => {
  const oscillator: SimDefinition = {
    title: "Oscillator",
    init: () => ({ x: 1, vx: 0 }),
    derive: (s) => ({ x: s.vx as number, vx: -(s.x as number) }),
  };
  it("RK4 follows the analytic oscillator over a full period", () => {
    let state = oscillator.init({});
    const dt = (2 * Math.PI) / 1000;
    for (let i = 0; i < 1000; i++) state = integrate(oscillator, state, {}, dt, i * dt);
    expect(state.x).toBeCloseTo(1, 9);
    expect(state.vx).toBeCloseTo(0, 9);
  });
  it("Verlet keeps oscillator energy bounded over many periods", () => {
    let state = oscillator.init({});
    for (let i = 0; i < 10000; i++)
      state = integrate({ ...oscillator, integrator: "verlet" }, state, {}, 0.01, i * 0.01);
    const energy = ((state.x as number) ** 2 + (state.vx as number) ** 2) / 2;
    expect(Math.abs(energy - 0.5)).toBeLessThan(0.00002);
  });
  it("integrates number arrays with the same fixed timestep", () => {
    const definition: SimDefinition = {
      title: "Particle",
      init: () => ({ position: [0, 0], velocity: [2, 3] }),
      derive: (s) => ({ position: s.velocity as number[], velocity: [0, -10] }),
    };
    for (const integrator of ["rk4", "verlet"] as const) {
      const state = integrate({ ...definition, integrator }, definition.init({}), {}, 0.2, 0);
      expect((state.position as number[])[0]).toBeCloseTo(0.4);
      expect((state.position as number[])[1]).toBeCloseTo(0.4);
      expect((state.velocity as number[])[0]).toBeCloseTo(2, 12);
      expect((state.velocity as number[])[1]).toBeCloseTo(1, 12);
    }
  });
  it("Euler and custom steps advance once; invalid numeric states fail", () => {
    expect(
      integrate({ ...oscillator, integrator: "euler" }, oscillator.init({}), {}, 0.1, 0),
    ).toEqual({ x: 1, vx: -0.1 });
    expect(
      integrate(
        { ...oscillator, step: (s) => ({ x: (s.x as number) + 5, vx: 0 }) },
        oscillator.init({}),
        {},
        1,
        0,
      ),
    ).toEqual({ x: 6, vx: 0 });
    expect(() => integrate({ ...oscillator, step: () => ({ x: Infinity }) }, {}, {}, 1, 0)).toThrow(
      "Non-finite",
    );
    expect(() => assertFiniteState({ x: [0, NaN] })).toThrow("Non-finite");
    expect(() =>
      integrate(
        { ...oscillator, derive: () => ({ x: [1], vx: 0 }) },
        oscillator.init({}),
        {},
        1,
        0,
      ),
    ).toThrow("Derivative shape");
    expect(() =>
      integrate({ ...oscillator, integrator: "verlet" }, { arbitrary: 1 }, {}, 1, 0),
    ).toThrow("Verlet needs");
  });
  it("does not modify the caller's state during integration", () => {
    const state: SimState = { x: 1, vx: 0 };
    integrate(oscillator, state, {}, 0.1, 0);
    expect(state).toEqual({ x: 1, vx: 0 });
  });
});
