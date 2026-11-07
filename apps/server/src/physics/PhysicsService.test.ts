import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PhysicsSimShowResult, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PhysicsBoardService from "./PhysicsBoardService.ts";
import * as PhysicsSimService from "./PhysicsSimService.ts";
import * as PhysicsService from "./PhysicsService.ts";
import * as PhysicsFiles from "./PhysicsFiles.ts";

const isSimShowResult = Schema.is(PhysicsSimShowResult);

it.effect(
  "publishes exactly the validated source/hash and scopes UI reads to the thread checkout",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "physics-reference-" });
      const threadId = ThreadId.make("physics-reference");
      const shell = { ...liveThreadShell(threadId), worktreePath: root };
      yield* fs.makeDirectory(path.join(root, "sims"));
      const file = path.join(root, "sims/pendulum.sim.js");
      yield* fs.writeFileString(file, "export default defineSim({title:'v1'})");
      let validatedCode = "";
      const metadata = {
        title: "Pendulum",
        view: "3d" as const,
        params: { L: { value: 1, unit: "m", min: 0.1, max: 3 } },
        observables: ["E (J)"],
        plots: [["E (J)"]],
      };
      const layer = PhysicsService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            PhysicsFiles.layer,
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(shell),
            }),
            Layer.mock(PhysicsBoardService.PhysicsBoardService)({}),
            Layer.mock(PhysicsSimService.PhysicsSimService)({
              runSource: (code) => {
                validatedCode = code;
                return Effect.succeed({
                  meta: metadata,
                  table: [],
                  errors: [],
                  finalState: {},
                  consoleMessages: [],
                  screenshot: { mimeType: "image/png", data: "", width: 900, height: 800 },
                });
              },
            }),
            McpAppModelContext.layerEmpty,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* PhysicsService.PhysicsService;
        const first = yield* service.simShow(threadId, { path: "sims/pendulum.sim.js" });
        expect(first.physicsSim).not.toHaveProperty("code");
        expect(first.physicsSim.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(isSimShowResult(first)).toBe(true);
        const read = yield* service.readSim({
          projectId: shell.projectId,
          threadId,
          path: "sims/pendulum.sim.js",
        });
        expect(read).toEqual({ code: validatedCode, hash: first.physicsSim.hash });
        yield* fs.writeFileString(file, "export default defineSim({title:'v2'})");
        expect(
          (yield* service.simShow(threadId, { path: "sims/pendulum.sim.js" })).physicsSim.hash,
        ).not.toBe(first.physicsSim.hash);
        expect(
          (yield* service
            .readSim({ projectId: ProjectId.make("wrong"), threadId, path: "sims/pendulum.sim.js" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* service
            .readSim({ projectId: shell.projectId, threadId, path: "sims/../../outside.sim.js" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* service
            .simSubscribe({
              projectId: ProjectId.make("wrong"),
              threadId,
              path: "sims/pendulum.sim.js",
            })
            .pipe(Stream.runHead, Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* service
            .simSubscribe({
              projectId: shell.projectId,
              threadId,
              path: "sims/../../outside.sim.js",
            })
            .pipe(Stream.runHead, Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* service
            .setModelContext({ threadId, key: "physics:board:main", text: "я".repeat(8193) })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* service.setModelContext({
          threadId,
          key: "physics:board:main",
          text: "я".repeat(8192),
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "gates visual_show on a passing check, reuses the exact hash and validates the requested step",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "visual-show-" });
      yield* fs.makeDirectory(path.join(root, "visuals"));
      const file = path.join(root, "visuals/test.html");
      yield* fs.writeFileString(file, "valid");
      const threadId = ThreadId.make("visual-tutor");
      let checks = 0;
      const layer = PhysicsService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            PhysicsFiles.layer,
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({ ...liveThreadShell(threadId), worktreePath: root }),
            }),
            Layer.mock(PhysicsBoardService.PhysicsBoardService)({}),
            Layer.mock(PhysicsSimService.PhysicsSimService)({
              runVisualSource: (code, path) => {
                checks++;
                return Effect.succeed({
                  path,
                  passed: code === "valid",
                  steps: [{ label: "Pool" }, { label: "Assign" }],
                  errors: code === "valid" ? [] : ["bad render"],
                  consoleMessages: [],
                  screenshots: [],
                });
              },
            }),
            McpAppModelContext.layerEmpty,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* PhysicsService.PhysicsService;
        expect((yield* service.visualRun(threadId, { path: "visuals/test.html" })).passed).toBe(
          true,
        );
        const shown = yield* service.visualShow(threadId, { path: "visuals/test.html", step: 1 });
        expect(shown.physicsVisual).toMatchObject({
          path: "visuals/test.html",
          step: 1,
          label: "Assign",
        });
        expect(checks).toBe(1);
        expect(
          yield* service
            .visualShow(threadId, { path: "visuals/test.html", step: 2 })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "PhysicsSimError",
          message: "Visual validation failed: Step is outside the visual.",
        });
        yield* fs.writeFileString(file, "broken");
        expect(
          yield* service.visualShow(threadId, { path: "visuals/test.html" }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "PhysicsSimError",
          message: "Visual validation failed: bad render",
        });
        expect(checks).toBe(2);
        expect(
          yield* service.visualShow(threadId, { path: "visuals/../test.html" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "PhysicsFileError" });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);
