import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { buildSimDocument } from "@t3tools/physics/sim";
import * as HeadlessChrome from "../htmlRender/headlessChrome.ts";
import { applyBoardOps } from "@t3tools/physics/board";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PhysicsFiles from "./PhysicsFiles.ts";
import * as PhysicsSimService from "./PhysicsSimService.ts";
import { intervals, intervalStats } from "@t3tools/physics/measure";
import { pendulumSim } from "./templates/index.ts";

it.live(
  "runs the offline pendulum deterministically, preserves energy without damping and renders MathML",
  (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment).T3CODE_TEST_HEADLESS_SHELL;
      if (!executable)
        return ctx.skip("Set T3CODE_TEST_HEADLESS_SHELL to a local headless Chrome executable.");
      const layer = PhysicsSimService.layer.pipe(
        Layer.provide(PhysicsFiles.layer),
        Layer.provide(
          Layer.succeed(
            PreviewBrowser.PreviewBrowser,
            PreviewBrowser.PreviewBrowser.of({
              executable: Effect.succeed(executable),
              installed: Effect.succeedSome(executable),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* fs.makeTempDirectoryScoped({ prefix: "physics-sim-" });
        yield* fs.makeDirectory(path.join(project, "sims"));
        yield* fs.writeFileString(path.join(project, "sims/pendulum.sim.js"), pendulumSim);
        const service = yield* PhysicsSimService.PhysicsSimService;
        const result = yield* service.run(project, "sims/pendulum.sim.js", {
          duration: 5,
          samples: 20,
          params: { damping: 0 },
        });
        expect(result.errors).toEqual([]);
        expect(result.table).toHaveLength(21);
        expect(result.table.at(-1)?.t).toBeCloseTo(5, 12);
        const energyIndex = result.meta.observables.findIndex((name) => name.startsWith("E "));
        expect(energyIndex).toBeGreaterThanOrEqual(0);
        const initial = result.table[0]!.values[energyIndex]!;
        expect(
          Math.max(...result.table.map((row) => Math.abs(row.values[energyIndex]! - initial))),
        ).toBeLessThan(1e-6);
        const repeated = yield* service.run(project, "sims/pendulum.sim.js", {
          duration: 5,
          samples: 20,
          params: { damping: 0 },
        });
        expect(repeated.table).toEqual(result.table);
        expect(Buffer.from(result.screenshot!.data, "base64").readUInt32BE(0)).toBe(0x89504e47);
        const board = applyBoardOps(
          { version: 1, revision: 0, items: [] },
          [
            {
              type: "add",
              items: [
                { kind: "math", latex: "E=\\frac{1}{2}mv^2", fontSize: 48 },
                {
                  kind: "ink",
                  points: [
                    [0, 0, 0.5],
                    [60, 40, 0.7],
                    [90, 0, 0.8],
                  ],
                  width: 5,
                },
                { kind: "plot", expr: "sin(x)*exp(-x/5)", xMin: 0, xMax: 10, w: 500, h: 200 },
              ],
            },
          ],
          "user",
        ).board;
        const capture = yield* service.renderBoard(board);
        expect(Buffer.from(capture.screenshot.data, "base64").readUInt32BE(0)).toBe(0x89504e47);
        yield* fs.writeFile(
          "/tmp/physics-board-proof.png",
          Buffer.from(capture.screenshot.data, "base64"),
        );
        yield* fs.writeFile(
          "/tmp/physics-sim-proof.png",
          Buffer.from(result.screenshot!.data, "base64"),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.live(
  "measures the pendulum period from θ crossings: 2π√(L/g) at small angles, longer at large ones",
  (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment).T3CODE_TEST_HEADLESS_SHELL;
      if (!executable)
        return ctx.skip("Set T3CODE_TEST_HEADLESS_SHELL to a local headless Chrome executable.");
      const layer = PhysicsSimService.layer.pipe(
        Layer.provide(PhysicsFiles.layer),
        Layer.provide(
          Layer.succeed(
            PreviewBrowser.PreviewBrowser,
            PreviewBrowser.PreviewBrowser.of({
              executable: Effect.succeed(executable),
              installed: Effect.succeedSome(executable),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* fs.makeTempDirectoryScoped({ prefix: "physics-measure-" });
        yield* fs.makeDirectory(path.join(project, "sims"));
        yield* fs.writeFileString(path.join(project, "sims/pendulum.sim.js"), pendulumSim);
        const service = yield* PhysicsSimService.PhysicsSimService;
        const period = (theta0: number) =>
          service
            .measure(project, "sims/pendulum.sim.js", {
              params: { damping: 0, L: 1, theta0 },
              duration: 20,
              crossings: { observable: "θ (rad)", value: 0, direction: "up" },
            })
            .pipe(
              Effect.map((run) => {
                expect(run.errors).toEqual([]);
                return intervalStats(intervals(run.crossings))!;
              }),
            );
        // The template uses g = 9.81 m/s². The exact period is T0 / AGM(1, cos(θ0/2)).
        const t0 = 2 * Math.PI * Math.sqrt(1 / 9.81);
        const agm = (a: number, b: number): number =>
          Math.abs(a - b) < 1e-15 ? a : agm((a + b) / 2, Math.sqrt(a * b));
        const small = yield* period(0.05);
        expect(small.n).toBeGreaterThanOrEqual(8);
        // Within 0.1% of the small-angle formula and 1 ppm of the exact period; laps agree to 1 µs.
        expect(Math.abs(small.mean - t0) / t0).toBeLessThan(1e-3);
        expect(Math.abs(small.mean - t0 / agm(1, Math.cos(0.025))) / t0).toBeLessThan(1e-6);
        expect(small.sd!).toBeLessThan(1e-6);
        const large = yield* period(2);
        expect(large.mean / t0).toBeGreaterThan(1.3);
        expect(Math.abs(large.mean - t0 / agm(1, Math.cos(1))) / t0).toBeLessThan(1e-6);
        const unknown = yield* service.measure(project, "sims/pendulum.sim.js", {
          crossings: { observable: "nope", value: 0, direction: "up" },
        });
        expect(unknown.errors.map((error) => error.message)).toEqual(["Unknown observable: nope"]);
        const outOfRange = yield* service.measure(project, "sims/pendulum.sim.js", {
          params: { L: 99 },
          crossings: { observable: "θ (rad)", value: 0, direction: "up" },
        });
        expect(outOfRange.crossings).toEqual([]);
        expect(outOfRange.errors).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.live.each([
  ["derive", "step"],
  ["init", "load"],
  ["setup", "load"],
  ["render", "render"],
  ["observables", "step"],
] as const)(
  "returns a phased timeout for an infinite %s loop and releases the run permit",
  ([hook, phase], ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment).T3CODE_TEST_HEADLESS_SHELL;
      if (!executable)
        return ctx.skip("Set T3CODE_TEST_HEADLESS_SHELL to a local headless Chrome executable.");
      const layer = PhysicsSimService.layer.pipe(
        Layer.provide(PhysicsFiles.layer),
        Layer.provide(
          Layer.succeed(
            PreviewBrowser.PreviewBrowser,
            PreviewBrowser.PreviewBrowser.of({
              executable: Effect.succeed(executable),
              installed: Effect.succeedSome(executable),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* PhysicsSimService.PhysicsSimService;
        const normal = `export default defineSim({title:"Test",view:"2d",init:()=>({x:1}),derive:()=>({x:0}),observables:{x:s=>s.x}})`;
        const looping =
          hook === "observables"
            ? normal.replace("x:s=>s.x", "x:()=>{while(true){}}")
            : normal.replace(
                hook === "init" ? "init:()=>({x:1})" : "derive:()=>({x:0})",
                hook === "init"
                  ? "init:()=>{while(true){}}"
                  : hook === "derive"
                    ? "derive:()=>{while(true){}}"
                    : `derive:()=>({x:0}),${hook}:()=>{while(true){}}`,
              );
        const start = performance.now();
        const result = yield* service.runSource(looping, { duration: 0.1, samples: 2 });
        expect(performance.now() - start).toBeLessThan(4000);
        expect(result.errors).toEqual([
          {
            phase,
            message: `Sim code did not finish within 3 s; check for an infinite loop in ${hook}.`,
          },
        ]);
        const following = yield* service.runSource(normal, { duration: 0.1, samples: 2 });
        expect(following.errors).toEqual([]);
        expect(following.table).toHaveLength(3);
        const capture = yield* service.renderBoard({ version: 1, revision: 0, items: [] });
        expect(capture.screenshot.data.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  15_000,
);

it.live("posts the t=0 sample after ready and again after reset and parameter changes", (ctx) =>
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const executable = environment.T3CODE_TEST_HEADLESS_SHELL;
    if (!executable)
      return ctx.skip("Set T3CODE_TEST_HEADLESS_SHELL to a local headless Chrome executable.");
    const code = `
      const events = [];
      let nextSample;
      window.__testEvents = events;
      window.__testSample = () => new Promise(resolve => { nextSample = resolve; });
      window.parent.postMessage = message => {
        events.push(message);
        if (message.type === "samples" && nextSample) {
          const resolve = nextSample; nextSample = undefined; resolve(message.rows);
        }
      };
      window.__testReady = window.__testSample();
      export default defineSim({ title: "Samples", view: "2d",
        params: { x: {value: 1} }, init: p => ({x:p.x}), derive:()=>({x:0}),
        observables: {x:s=>s.x}, plots:[["x"]] });`;
    const result = yield* HeadlessChrome.evaluateHtml({
      executable,
      noSandbox: environment.T3CODE_SERVER_BROWSER_SANDBOX === "0",
      html: buildSimDocument({ code, mode: "interactive" }),
      width: 900,
      expression: `(async () => {
        const initial = await window.__testReady;
        const readyIndex = window.__testEvents.findIndex(event => event.type === "ready");
        const nextType = window.__testEvents[readyIndex + 1]?.type;
        const resetSample = window.__testSample();
        window.dispatchEvent(new MessageEvent("message", {source:window, data:{type:"reset"}}));
        const reset = await resetSample;
        const paramsSample = window.__testSample();
        window.dispatchEvent(new MessageEvent("message", {source:window, data:{type:"setParams",params:{x:2}}}));
        const params = await paramsSample;
        return {initial, nextType, reset, params};
      })()`,
      result: Schema.Struct({
        initial: Schema.Array(Schema.Array(Schema.Number)),
        nextType: Schema.String,
        reset: Schema.Array(Schema.Array(Schema.Number)),
        params: Schema.Array(Schema.Array(Schema.Number)),
      }),
    });
    expect(result.result).toEqual({
      initial: [[0, 1]],
      nextType: "samples",
      reset: [[0, 1]],
      params: [[0, 2]],
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
