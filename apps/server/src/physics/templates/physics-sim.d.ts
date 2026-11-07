// Exact sim API; Three.js types resolve from @types/three when checking custom objects.
import type * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type SimState = Record<string, number | number[]>;
export type SimParams = Record<string, number>;
export type SimPoint = readonly [number, number, number];
export type CrossingDirection = "up" | "down";
export interface CrossingSpec {
  /** Observable name, as in `SimMeta.observables`. */
  readonly observable: string;
  /** Level the observable crosses. */
  readonly value: number;
  /** "up" counts rising crossings (below to above), "down" falling ones. */
  readonly direction: CrossingDirection;
}
export interface SimParam {
  /** Default numeric parameter value. */
  value: number;
  /** Inclusive lower bound for parameter overrides. */
  min?: number;
  /** Inclusive upper bound for parameter overrides. */
  max?: number;
  /** Slider increment; does not change the physics timestep. */
  step?: number;
  /** Physical unit displayed with the parameter. */
  unit?: string;
  /** Parameter display label. */
  label?: string;
}
export interface SimMeta {
  /** Simulation title. */
  title: string;
  /** Perspective 3d or orthographic 2d view. */
  view: "3d" | "2d";
  /** Parameter definitions in declaration order. */
  params: Record<string, SimParam>;
  /** Observable names in sampled column order. */
  observables: string[];
  /** Plot groups by observable name. */
  plots: string[][];
}
export interface SimAppearance {
  /** Primary plot color; defaults to white against a black background. */
  accent?: string;
}
export interface SimObjectOptions {
  /** Three.js color; helpers default to white or neutral gray. */
  color?: THREE.ColorRepresentation;
  /** Object translation in world units; segment endpoints and trail points are local to it. */
  position?: SimPoint;
}
export interface SimRodOptions extends SimObjectOptions {
  /** Cylinder radius in world units; defaults to 0.015. */
  radius?: number;
}
export interface SimSpringOptions extends SimObjectOptions {
  /** Helix radius in world units; defaults to 0.05. */
  radius?: number;
  /** Number of helix turns; defaults to 10. */
  turns?: number;
}
export interface SimTrailOptions extends SimObjectOptions {
  /** Retained point count; defaults to 500, oldest points are discarded. */
  maxPoints?: number;
}
export interface SimLabelOptions extends SimObjectOptions {
  /** Sprite height in world units; defaults to 0.18. */
  height?: number;
}
export interface SimSegment extends THREE.Group {
  /** Update endpoints in the group's local coordinates. */
  setEndpoints: (from: SimPoint, to: SimPoint) => void;
}
export interface SimTrail extends THREE.Line {
  /** Append a point in the line's local coordinates. */
  push: (point: SimPoint) => void;
  /** Remove all retained points. */
  clearPoints: () => void;
}
export interface SimLabel extends THREE.Sprite {
  /** Replace label text; unchanged text reuses its existing texture. */
  setText: (text: string) => void;
}
/** Helpers add their object to the scene. Retain handles in setup and update them in render. */
export interface SimKit {
  /** Complete bundled Three.js module for custom objects. */
  THREE: typeof THREE;
  /** Scene containing helper objects, black background and lights. */
  scene: THREE.Scene;
  /** Active perspective or orthographic camera. */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** Orbit controls with damping disabled; changes render one frame while paused. */
  controls: OrbitControls;
  /** Add a sphere; radius defaults to 0.1 world units. */
  sphere: (radius?: number, options?: SimObjectOptions) => THREE.Mesh;
  /** Add a box; size defaults to [1,1,1] world units. */
  box: (size?: SimPoint, options?: SimObjectOptions) => THREE.Mesh;
  /** Add a cylindrical segment; setEndpoints updates it. */
  rod: (from: SimPoint, to: SimPoint, options?: SimRodOptions) => SimSegment;
  /** Add a helical segment; radius defaults to 0.05 and turns to 10. */
  spring: (from: SimPoint, to: SimPoint, options?: SimSpringOptions) => SimSegment;
  /** Add an arrow from start to end; setEndpoints updates it. */
  arrow: (from: SimPoint, to: SimPoint, options?: SimObjectOptions) => SimSegment;
  /** Add a line with push and clearPoints; maxPoints defaults to 500. */
  trail: (options?: SimTrailOptions) => SimTrail;
  /** Add a neutral grid; size defaults to 10 and divisions to 20. */
  grid: (size?: number, divisions?: number) => THREE.GridHelper;
  /** Add a canvas-text sprite; height defaults to 0.18 world units. */
  label: (text: string, options?: SimLabelOptions) => SimLabel;
}
export interface SimDefinition<S extends SimState = SimState> {
  /** Simulation title. */
  title: string;
  /** View mode, defaults to 3d; 2d looks along the Z axis at the XY plane. */
  view?: "3d" | "2d";
  /** Parameter definitions; defaults to an empty object. */
  params?: Record<string, SimParam>;
  /** Fixed timestep in seconds, defaults to 1/240; allowed range 0.0001 to 1. */
  dt?: number;
  /** Return initial finite scalar/array state from parameters. */
  init: (params: SimParams) => S;
  /** Return time derivatives with the same state shape; required unless step is supplied. */
  derive?: (state: S, params: SimParams, t: number) => S;
  /** Custom fixed step returning the next finite state; overrides derive/integrator. */
  step?: (state: S, params: SimParams, dt: number, t: number) => S;
  /** Integrator defaults to rk4; Verlet supports position/velocity, theta/omega or x/vx,y/vy,z/vz pairs. */
  integrator?: "rk4" | "verlet" | "euler";
  /** Create objects once at load/reset using initial state and parameters. */
  setup?: (kit: SimKit, state: S, params: SimParams) => void;
  /** Update objects from current state/time on active or invalidated frames. */
  render?: (kit: SimKit, state: S, params: SimParams, t: number) => void;
  /** Finite sampled scalar functions; include units in their names. */
  observables?: Record<string, (state: S, params: SimParams, t: number) => number>;
  /** Observable names grouped onto separate canvas plots. */
  plots?: string[][];
}
export type SimHostMessage =
  | { type: "load"; code: string; params?: SimParams }
  | { type: "play" }
  | { type: "pause" }
  | { type: "reset" }
  | { type: "step"; count: number }
  | { type: "setSpeed"; speed: number }
  | { type: "setParams"; params: SimParams }
  | { type: "snapshot" }
  | ({ type: "instruments" } & SimInstruments);
/** Host-owned instrument setup, resent after every `ready`. */
export interface SimInstruments {
  /** Clicks on a mesh in the view post `pick` instead of only orbiting. */
  probeMode: boolean;
  /** Pinned probe paths (see `SimProbeReadout.path`), at most 8. */
  probes: string[];
  /** Observable level crossing to report as `crossing` messages, checked every physics step. */
  crossing: CrossingSpec | null;
}
/** Live readout of one pinned object, in world units (1 = 1 m) and simulated seconds. */
export interface SimProbeReadout {
  /** Child indices from the scene root, e.g. "4" or "6.0"; stable across resets. */
  path: string;
  /** Object name, the nearest named ancestor's, or kind and ordinal like "sphere 2". */
  label: string;
  /** World position. */
  position: [number, number, number];
  /** Average velocity over the last drawn frame; null until time advances once. */
  velocity: [number, number, number] | null;
}
export interface SimError {
  /** Load, integration or drawing failure description. */
  message: string;
  /** JavaScript stack when available. */
  stack?: string;
  /** Runtime operation that failed. */
  phase: "load" | "step" | "render";
}
/** samples rows are [time, ...observables in meta.observables order]; t is the latest time. */
export type SimFrameMessage =
  | {
      type: "keydown";
      key: string;
      code: string;
      ctrlKey: boolean;
      metaKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    }
  | { type: "ready"; meta: SimMeta }
  | { type: "samples"; t: number; rows: number[][] }
  | { type: "state"; t: number; playing: boolean }
  | ({ type: "error" } & SimError)
  | { type: "snapshot"; dataUrl: string }
  | { type: "pick"; path: string }
  | { type: "probes"; t: number; readouts: SimProbeReadout[] }
  | { type: "crossing"; t: number };
export interface SimRunOptions {
  /** Parameter overrides, validated against declared bounds; unspecified values use defaults. */
  params?: SimParams;
  /** Duration in seconds, default 5; sim_run accepts up to 120. Rounds down to complete fixed steps, at most one million. */
  duration?: number;
  /** Number of sample intervals, default 20; sim_run accepts 2..1000. Returns samples + 1 rows including time zero. */
  samples?: number;
  /** Record the times this observable crosses a level, checked every physics step; sim_measure uses it. */
  crossing?: CrossingSpec;
}
export interface SimSample {
  /** Sample time in seconds at a complete fixed timestep. */
  t: number;
  /** Observable values in meta.observables order. */
  values: number[];
}
export interface SimRunResult {
  /** Simulation metadata. */
  meta: SimMeta;
  /** Rows at sampled times in seconds; values follow meta.observables. */
  table: SimSample[];
  /** Load, numerical-step and render failures. */
  errors: SimError[];
  /** Final finite state, or empty state if user code corrupts it. */
  finalState: SimState;
  /** Crossing times in seconds when `crossing` was given, at most 1000. */
  crossings?: number[];
}
export interface SimHeadless {
  /** Await initial load, reset, step deterministically without rAF, and render the final frame. */
  run: (options: SimRunOptions) => Promise<SimRunResult>;
}

/** defineSim is injected into each evaluated .sim.js module. */
declare global {
  function defineSim<S extends SimState>(definition: SimDefinition<S>): SimDefinition<S>;
}
