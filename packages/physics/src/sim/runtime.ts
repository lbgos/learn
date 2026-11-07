import * as THREE from "three";
import { assertFiniteState, integrate } from "./integrators.ts";
import { createKit, disposeKit } from "./kit.ts";
import { createCrossingDetector, type CrossingDetector } from "./measure.ts";
import type {
  SimAppearance,
  SimDefinition,
  SimError,
  SimFrameMessage,
  SimHeadless,
  SimHostMessage,
  SimInstruments,
  SimKit,
  SimMeta,
  SimParams,
  SimProbeReadout,
  SimRunResult,
  SimState,
} from "./types.ts";

declare global {
  interface Window {
    __physicsBoot: { code: string; mode: "interactive" | "headless"; appearance: SimAppearance };
    __physicsHeadless: SimHeadless;
    __physicsProgress?: (payload: string) => void;
  }
}

const root = document.getElementById("physics-root")!;
let renderer: THREE.WebGLRenderer | undefined;
let kit: SimKit | undefined;
let definition: SimDefinition | undefined;
let params: SimParams = {};
let state: SimState = {};
let t = 0;
let ticks = 0;
let dt = 1 / 240;
let playing = false;
let speed = 1;
let frame: number | undefined;
let accumulator = 0;
let previousTime = 0;
let lastPost = 0;
let rows: number[][] = [];
let history: number[][] = [];
let errors: SimError[] = [];
let generation = 0;
let loading = false;
let instruments: SimInstruments = { probeMode: false, probes: [], crossing: null };
/** Armed `instruments.crossing`; evaluated after every physics step. */
let watch: { observe: () => number; detector: CrossingDetector } | null = null;
/** Headless crossing times; null outside a measuring run. */
let headlessCrossings: number[] | null = null;
const plotCanvas = document.createElement("canvas");
plotCanvas.id = "physics-plots";
const boot = window.__physicsBoot;
const post = (message: SimFrameMessage) => {
  if (boot.mode === "interactive") window.parent.postMessage(message, "*");
};
const emptyMeta: SimMeta = {
  title: "Simulation",
  view: "3d",
  params: {},
  observables: [],
  plots: [],
};
function meta(): SimMeta {
  return definition
    ? {
        title: definition.title,
        view: definition.view ?? "3d",
        params: definition.params ?? {},
        observables: Object.keys(definition.observables ?? {}),
        plots: definition.plots ?? [],
      }
    : emptyMeta;
}
let currentHook = "";
function progress(phase: SimError["phase"], hook: string): void {
  if (boot.mode !== "headless" || hook === currentHook) return;
  currentHook = hook;
  window.__physicsProgress?.(JSON.stringify({ phase, hook, meta: meta() }));
}
function pause(): void {
  playing = false;
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  accumulator = 0;
  postProbes();
  post({ type: "state", t, playing });
}
function fail(cause: unknown, phase: SimError["phase"]): void {
  const error: SimError = {
    message: cause instanceof Error ? cause.message : String(cause),
    phase,
    ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {}),
  };
  errors.push(error);
  post({ type: "error", ...error });
  pause();
}
function values(): number[] {
  progress("step", "observables");
  const result = Object.values(definition?.observables ?? {}).map((observe) =>
    observe(state, params, t),
  );
  if (result.some((v) => typeof v !== "number" || !Number.isFinite(v)))
    throw new Error("Observable returned NaN, Infinity or a non-number.");
  return result;
}
function sample(): void {
  const row = [t, ...values()];
  rows.push(row);
  history.push(row);
  if (rows.length > 32) rows.shift();
  if (history.length > 1200) history.shift();
}
function flushSamples(): void {
  if (rows.length) {
    post({ type: "samples", t, rows });
    rows = [];
  }
}
function drawPlots(): void {
  const groups = definition?.plots ?? [];
  plotCanvas.hidden = groups.length === 0;
  if (!groups.length) return;
  const width = root.clientWidth || 900;
  const height = Math.min(240, 100 * groups.length);
  plotCanvas.width = width;
  plotCanvas.height = height;
  const ctx = plotCanvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  const names = meta().observables;
  const colors = [boot.appearance.accent ?? "#fff", "#72b7ff", "#ffac72", "#8bd399"];
  groups.forEach((group, groupIndex) => {
    const y0 = (height * groupIndex) / groups.length;
    const groupHeight = height / groups.length;
    const indices = group.map((name) => names.indexOf(name) + 1).filter((i) => i > 0);
    const allValues = history.flatMap((row) => indices.map((i) => row[i]!));
    let min = allValues.length ? Math.min(...allValues) : -1;
    let max = allValues.length ? Math.max(...allValues) : 1;
    // Keep numerical roundoff in nearly constant observables from filling the plot.
    const minimumRange = Math.max(1e-6, Math.max(Math.abs(min), Math.abs(max)) * 0.02);
    if (max - min < minimumRange) {
      const midpoint = (min + max) / 2;
      min = midpoint - minimumRange / 2;
      max = midpoint + minimumRange / 2;
    }
    const left = history[0]?.[0] ?? 0;
    const right = history.at(-1)?.[0] ?? 1;
    ctx.strokeStyle = "#333";
    ctx.strokeRect(42, y0 + 22, width - 54, groupHeight - 30);
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#fff";
    ctx.fillText(group.join(" · "), 8, y0 + 14);
    ctx.fillText(max.toPrecision(3), 2, y0 + 30);
    ctx.fillText(min.toPrecision(3), 2, y0 + groupHeight - 8);
    indices.forEach((index, i) => {
      ctx.beginPath();
      ctx.strokeStyle = colors[i % colors.length]!;
      history.forEach((row, j) => {
        const x = 42 + ((row[0]! - left) / (right - left || 1)) * (width - 54);
        const y = y0 + 22 + (1 - (row[index]! - min) / (max - min)) * (groupHeight - 30);
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  });
}
/**
 * Probes read what the learner sees: the world position of the picked three.js object, and its
 * velocity as a finite difference between drawn frames in simulated time. That works for every
 * sim without any sim-API addition (sims treat 1 world unit as 1 m), and the readout always
 * matches the drawing. The cost is that velocity is a frame average, so at high speed it lags by
 * half a frame; positions are exact. Objects are identified by their child-index path, which
 * setup recreates identically after reset or a parameter change.
 */
interface ProbeTrack {
  object: THREE.Object3D | null;
  label: string;
  last: { t: number; p: THREE.Vector3 } | null;
  velocity: [number, number, number] | null;
}
const tracks = new Map<string, ProbeTrack>();
let readouts: SimProbeReadout[] = [];
let postedReadouts = false;
const probeLayer = document.createElement("div");
probeLayer.id = "physics-probes";
function objectAt(path: string): THREE.Object3D | null {
  let object: THREE.Object3D | undefined = kit?.scene;
  for (const index of path.split(".")) object = object?.children[Number(index)];
  return object ?? null;
}
function pathOf(object: THREE.Object3D): string | null {
  const indices: number[] = [];
  for (let node = object; node !== kit?.scene; node = node.parent!) {
    if (!node.parent) return null;
    indices.unshift(node.parent.children.indexOf(node));
  }
  return indices.join(".");
}
const kindOf = (object: THREE.Object3D) =>
  object instanceof THREE.Mesh
    ? object.geometry.type.replace(/Geometry$/, "").toLowerCase() || "object"
    : "object";
function labelOf(object: THREE.Object3D): string {
  for (let node: THREE.Object3D | null = object; node && node !== kit?.scene; node = node.parent)
    if (node.name) return node.name;
  const kind = kindOf(object);
  let ordinal = 0;
  let found = 0;
  kit?.scene.traverse((node) => {
    if (found || !(node instanceof THREE.Mesh) || kindOf(node) !== kind) return;
    ordinal++;
    if (node === object) found = ordinal;
  });
  return `${kind} ${found || 1}`;
}
const fixed = (value: number) => value.toFixed(3);
/** Positions probe labels over the canvas; runs inside `render`, so never on an idle frame. */
function updateProbes(): void {
  readouts = [];
  if (!kit || !renderer || instruments.probes.length === 0) {
    probeLayer.replaceChildren();
    return;
  }
  const canvas = renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const flat = (definition?.view ?? "3d") === "2d";
  const nodes: HTMLElement[] = [];
  for (const path of instruments.probes) {
    let track = tracks.get(path);
    if (!track) {
      track = { object: null, label: path, last: null, velocity: null };
      tracks.set(path, track);
    }
    if (!track.object) {
      track.object = objectAt(path);
      if (track.object) track.label = labelOf(track.object);
    }
    if (!track.object) continue;
    const p = track.object.getWorldPosition(new THREE.Vector3());
    if (!track.last || t < track.last.t) {
      track.velocity = null;
      track.last = { t, p };
    } else if (t > track.last.t) {
      const v = p
        .clone()
        .sub(track.last.p)
        .divideScalar(t - track.last.t);
      track.velocity = [v.x, v.y, v.z];
      track.last = { t, p };
    }
    readouts.push({
      path,
      label: track.label,
      position: [p.x, p.y, p.z],
      velocity: track.velocity,
    });
    const screen = p.clone().project(kit.camera);
    if (screen.z > 1) continue;
    const x = ((screen.x + 1) / 2) * width;
    const y = ((1 - screen.y) / 2) * height;
    const axes = flat ? ["x", "y"] : ["x", "y", "z"];
    const position = axes.map((axis, i) => `${axis} ${fixed(p.getComponent(i))}`).join(" ");
    const velocity = track.velocity
      ? axes.map((axis, i) => `v${axis} ${fixed(track.velocity![i]!)}`).join(" ")
      : "v –";
    const marker = document.createElement("div");
    marker.className = "probe-marker";
    marker.style.transform = `translate(${x - 3}px, ${y - 3}px)`;
    const label = document.createElement("div");
    label.className = "probe";
    label.style.transform = `translate(${Math.min(x + 8, width - 150)}px, ${y + 6}px)`;
    label.textContent = `${track.label}\n${position} m\n${velocity}${track.velocity ? " m/s" : ""}`;
    nodes.push(marker, label);
  }
  probeLayer.replaceChildren(...nodes);
}
/** Posts readouts while any probe is pinned, and once more when the last one is unpinned. */
function postProbes(): void {
  if (readouts.length === 0 && !postedReadouts) return;
  postedReadouts = readouts.length > 0;
  post({ type: "probes", t, readouts });
}
function armWatch(): void {
  watch = null;
  const spec = instruments.crossing;
  const observable = spec && definition?.observables?.[spec.observable];
  if (!spec) return;
  if (!observable) {
    if (boot.mode === "headless") throw new Error(`Unknown observable: ${spec.observable}`);
    return;
  }
  const observe = () => {
    const value = observable(state, params, t);
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("Observable returned NaN, Infinity or a non-number.");
    return value;
  };
  watch = { observe, detector: createCrossingDetector(spec) };
  watch.detector.push(t, observe());
}
function crossed(time: number): void {
  if (boot.mode === "interactive") post({ type: "crossing", t: time });
  else if (headlessCrossings && headlessCrossings.length < 1000) headlessCrossings.push(time);
}
function render(): void {
  if (!kit || !renderer || !definition) return;
  try {
    progress("render", "render");
    definition.render?.(kit, state, params, t);
    assertFiniteState(state);
    const width = root.clientWidth || 900;
    const height = Math.max(
      100,
      (root.clientHeight || 600) -
        ((definition.plots?.length ?? 0) ? Math.min(240, 100 * definition.plots!.length) : 0),
    );
    renderer.setSize(width, height, false);
    if (kit.camera instanceof THREE.PerspectiveCamera) kit.camera.aspect = width / height;
    else {
      kit.camera.left = (-3 * width) / height;
      kit.camera.right = (3 * width) / height;
    }
    kit.camera.updateProjectionMatrix();
    renderer.render(kit.scene, kit.camera);
    updateProbes();
    drawPlots();
  } catch (cause) {
    fail(cause, "render");
  }
}
/** Orbit and resize events schedule one frame while paused. No idle animation loop. */
function invalidate(): void {
  if (frame !== undefined || playing || loading || boot.mode === "headless") return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    render();
  });
}
function advance(count: number): void {
  if (!definition) return;
  for (let i = 0; i < count; i++) {
    progress("step", definition.step ? "step" : "derive");
    state = integrate(definition, state, params, dt, t);
    ticks++;
    t = ticks * dt;
    if (watch) {
      const crossing = watch.detector.push(t, watch.observe());
      if (crossing !== null) crossed(crossing);
    }
    if (ticks % Math.max(1, Math.round(1 / (dt * 20))) === 0) sample();
  }
}
function animate(now: number): void {
  frame = undefined;
  if (!playing) return;
  accumulator += Math.min((now - previousTime) / 1000, 0.1) * speed;
  previousTime = now;
  try {
    const count = Math.min(2000, Math.floor(accumulator / dt));
    advance(count);
    accumulator -= count * dt;
    render();
    if (now - lastPost >= 50) {
      flushSamples();
      postProbes();
      post({ type: "state", t, playing });
      lastPost = now;
    }
  } catch (cause) {
    fail(cause, "step");
  }
  if (playing) frame = requestAnimationFrame(animate);
}
function validateParams(overrides: SimParams = {}): SimParams {
  const definitions = definition?.params ?? {};
  const result = Object.fromEntries(
    Object.entries(definitions).map(([name, p]) => [name, p.value]),
  );
  for (const [name, value] of Object.entries(overrides)) {
    const p = definitions[name];
    if (!p) throw new Error(`Unknown parameter: ${name}`);
    if (
      !Number.isFinite(value) ||
      (p.min !== undefined && value < p.min) ||
      (p.max !== undefined && value > p.max)
    )
      throw new Error(`Parameter out of range: ${name}`);
    result[name] = value;
  }
  for (const [name, value] of Object.entries(result)) {
    const p = definitions[name]!;
    if (
      !Number.isFinite(value) ||
      (p.min !== undefined && value < p.min) ||
      (p.max !== undefined && value > p.max)
    )
      throw new Error(`Parameter default out of range: ${name}`);
  }
  return result;
}
function reset(publishSamples = true): void {
  pause();
  if (!definition) return;
  progress("load", "init");
  const initialState = definition.init(params);
  assertFiniteState(initialState);
  state = initialState;
  t = 0;
  ticks = 0;
  rows = [];
  history = [];
  if (kit) disposeKit(kit);
  tracks.clear();
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    root.append(renderer.domElement, probeLayer, plotCanvas);
    listenForPicks(renderer.domElement);
  }
  kit = createKit(renderer, definition.view ?? "3d", invalidate);
  progress("load", "setup");
  definition.setup?.(kit, state, params);
  armWatch();
  sample();
  render();
  if (publishSamples) flushSamples();
  postProbes();
  post({ type: "state", t, playing });
}
/** A click (not an orbit drag) on a mesh in probe mode posts its path; the host toggles the pin. */
function listenForPicks(canvas: HTMLCanvasElement): void {
  if (boot.mode !== "interactive") return;
  const raycaster = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (event) => {
    down = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener("pointerup", (event) => {
    const start = down;
    down = null;
    if (!instruments.probeMode || !kit || !start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      ),
      kit.camera,
    );
    const hit = raycaster
      .intersectObjects(kit.scene.children, true)
      .find(({ object }) => object instanceof THREE.Mesh && object.visible);
    const path = hit && pathOf(hit.object);
    if (path) post({ type: "pick", path });
  });
}
async function load(code: string, overrides?: SimParams): Promise<void> {
  const id = ++generation;
  pause();
  loading = true;
  errors = [];
  definition = undefined;
  state = {};
  t = 0;
  ticks = 0;
  rows = [];
  history = [];
  const url = URL.createObjectURL(
    new Blob(["const defineSim = (definition) => definition;\n", code], {
      type: "text/javascript",
    }),
  );
  try {
    progress("load", "module evaluation");
    const module: { default?: unknown } = await import(/* @vite-ignore */ url);
    if (id !== generation) return;
    const candidate = module.default;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("init" in candidate) ||
      typeof candidate.init !== "function"
    )
      throw new Error("Export default defineSim({...}) with an init function.");
    definition = candidate as SimDefinition;
    if (typeof definition.title !== "string") throw new Error("Simulation title must be a string.");
    if (definition.view !== undefined && definition.view !== "2d" && definition.view !== "3d")
      throw new Error("View must be 2d or 3d.");
    dt = definition.dt ?? 1 / 240;
    if (!Number.isFinite(dt) || dt < 1 / 10000 || dt > 1)
      throw new Error("dt must be between 0.0001 and 1 second.");
    if (!definition.derive && !definition.step) throw new Error("Simulation needs derive or step.");
    if (definition.integrator && !["euler", "rk4", "verlet"].includes(definition.integrator))
      throw new Error("Unknown integrator.");
    const names = Object.keys(definition.observables ?? {});
    if (definition.plots?.some((group) => group.some((name) => !names.includes(name))))
      throw new Error("Plot names must refer to observables.");
    params = validateParams(overrides);
    reset(false);
    post({ type: "ready", meta: meta() });
    flushSamples();
  } catch (cause) {
    if (id === generation) {
      definition = undefined;
      fail(cause, "load");
    }
  } finally {
    URL.revokeObjectURL(url);
    if (id === generation) loading = false;
  }
}
const initialLoad = load(boot.code);
let commandQueue = initialLoad;
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    event.source !== window.parent ||
    !event.data ||
    typeof event.data !== "object" ||
    !("type" in event.data)
  )
    return;
  const message = event.data as SimHostMessage;
  commandQueue = commandQueue.then(async () => {
    try {
      switch (message.type) {
        case "load":
          await load(message.code, message.params);
          break;
        case "play":
          if (definition && !playing) {
            playing = true;
            previousTime = performance.now();
            if (frame !== undefined) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(animate);
            post({ type: "state", t, playing });
          }
          break;
        case "pause":
          pause();
          flushSamples();
          break;
        case "reset":
          reset();
          break;
        case "step": {
          if (!Number.isInteger(message.count) || message.count < 0 || message.count > 100000)
            throw new Error("Step count must be an integer from 0 to 100000.");
          pause();
          advance(message.count);
          sample();
          render();
          flushSamples();
          postProbes();
          post({ type: "state", t, playing });
          break;
        }
        case "setSpeed":
          if (!Number.isFinite(message.speed) || message.speed <= 0 || message.speed > 100)
            throw new Error("Speed must be between 0 and 100.");
          else speed = message.speed;
          break;
        case "setParams":
          params = validateParams({ ...params, ...message.params });
          reset();
          break;
        case "instruments":
          instruments = {
            probeMode: message.probeMode === true,
            probes: message.probes.filter((path) => /^\d+(?:\.\d+)*$/.test(path)).slice(0, 8),
            crossing: message.crossing,
          };
          for (const path of tracks.keys())
            if (!instruments.probes.includes(path)) tracks.delete(path);
          if (renderer) renderer.domElement.style.cursor = instruments.probeMode ? "crosshair" : "";
          if (definition) {
            armWatch();
            render();
            postProbes();
          }
          break;
        case "snapshot":
          render();
          if (renderer) {
            const canvas = document.createElement("canvas");
            canvas.width = renderer.domElement.width;
            canvas.height =
              renderer.domElement.height + (plotCanvas.hidden ? 0 : plotCanvas.height);
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(renderer.domElement, 0, 0);
            if (!plotCanvas.hidden)
              ctx.drawImage(
                plotCanvas,
                0,
                renderer.domElement.height,
                canvas.width,
                plotCanvas.height,
              );
            post({ type: "snapshot", dataUrl: canvas.toDataURL("image/png") });
          }
          break;
      }
    } catch (cause) {
      fail(cause, message.type === "load" ? "load" : "step");
    }
  });
});
window.addEventListener("resize", invalidate);
window.addEventListener("keydown", (event) => {
  if (boot.mode !== "interactive") return;
  const { key, code, ctrlKey, metaKey, altKey, shiftKey } = event;
  if (!ctrlKey && !metaKey && !altKey && key !== "Escape") return;
  post({ type: "keydown", key, code, ctrlKey, metaKey, altKey, shiftKey });
  // Local controls handle keys before they bubble here and mark consumed events.
  if (!event.defaultPrevented) event.preventDefault();
});
window.__physicsHeadless = {
  run: async (options): Promise<SimRunResult> => {
    await initialLoad;
    pause();
    const table: SimRunResult["table"] = [];
    // Set before anything can throw, so every measuring run returns a crossings list.
    headlessCrossings = options.crossing ? [] : null;
    const crossings = () => (headlessCrossings ? { crossings: headlessCrossings } : {});
    try {
      if (!definition || errors.length)
        return { meta: meta(), table, errors: [...errors], finalState: state, ...crossings() };
      const duration = options.duration ?? 5;
      const samples = options.samples ?? 20;
      if (!Number.isFinite(duration) || duration < 0 || duration > 300)
        throw new Error("Duration must be between 0 and 300 seconds.");
      if (!Number.isInteger(samples) || samples < 1 || samples > 1000)
        throw new Error("Samples must be an integer from 1 to 1000.");
      errors = [];
      params = validateParams(options.params);
      instruments = { ...instruments, crossing: options.crossing ?? null };
      reset();
      const totalSteps = Math.floor(duration / dt + 1e-9);
      if (totalSteps > 1000000) throw new Error("Run exceeds one million physics steps.");
      table.push({ t, values: values() });
      // samples is the number of intervals. Include the initial and final rows.
      for (let i = 1; i <= samples; i++) {
        const target = Math.round((i * totalSteps) / samples);
        advance(target - ticks);
        table.push({ t, values: values() });
      }
      render();
    } catch (cause) {
      fail(cause, "step");
    }
    let finalState: SimState = {};
    try {
      assertFiniteState(state);
      finalState = structuredClone(state);
    } catch {
      /* Preserve the reported error without returning invalid numbers. */
    }
    return {
      meta: meta(),
      table,
      errors: [...errors],
      finalState,
      ...crossings(),
    };
  },
};
