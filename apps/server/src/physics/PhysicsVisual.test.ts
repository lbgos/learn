import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Access from "../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { McpInvocationContext, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Handlers from "../mcp/toolkits/physics/handlers.ts";
import { PhysicsImageToolkit, VisualRunTool } from "../mcp/toolkits/physics/tools.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ModelContext from "../mcpApps/McpAppModelContext.ts";
import * as Boards from "./PhysicsBoardService.ts";
import * as Physics from "./PhysicsService.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Files from "./PhysicsFiles.ts";
import * as Sims from "./PhysicsSimService.ts";
import * as Browser from "../preview/PreviewBrowser.ts";
import { assignmentVisual } from "./templates/index.ts";

it.live(
  "visual_run rejects missing contracts and throwing renders, and captures the offline example",
  (ctx) =>
    Effect.gen(function* () {
      const executable = (yield* HostProcess.Environment).T3CODE_TEST_HEADLESS_SHELL;
      if (!executable) return ctx.skip("T3CODE_TEST_HEADLESS_SHELL is required.");
      const layer = Sims.layer.pipe(
        Layer.provide(Files.layer),
        Layer.provide(
          Layer.mock(Browser.PreviewBrowser)({
            executable: Effect.succeed(executable),
            installed: Effect.succeedSome(executable),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* Sims.PhysicsSimService;
        const missing = yield* service.runVisualSource(
          "<body>Missing contract</body>",
          "visuals/missing.html",
        );
        expect(missing.passed).toBe(false);
        expect(missing.errors.join(" ")).toContain("window.lbgosVisual");
        const noCaption = yield* service.runVisualSource(
          `<script>window.lbgosVisual={steps:[{label:'scene'}],render(){}}</script>`,
          "visuals/no-caption.html",
        );
        expect(noCaption.passed).toBe(false);
        expect(noCaption.errors.join(" ")).toContain("caption for every step");
        const throwing = yield* service.runVisualSource(
          `<script>window.lbgosVisual={steps:[{label:'broken'}],captions:['Watch the change.'],render(){throw new Error('render failed')}}</script>`,
          "visuals/throw.html",
        );
        expect(throwing.passed).toBe(false);
        expect(throwing.errors.join(" ")).toContain("render failed");
        const timer = yield* service.runVisualSource(
          `<script>window.lbgosVisual={steps:[{label:'idle'}],captions:['Watch the change.'],render(){requestAnimationFrame(()=>{})}}</script>`,
          "visuals/timer.html",
        );
        expect(timer.passed).toBe(false);
        expect(timer.errors.join(" ")).toContain("timers are not allowed");
        const midpoint = yield* service.runVisualSource(
          `<script>window.lbgosVisual={steps:[{label:'moving'}],captions:['Watch the change.'],render(step,t){if(t===0.5)throw new Error('mid-motion failed')}}</script>`,
          "visuals/midpoint.html",
        );
        expect(midpoint.passed).toBe(false);
        expect(midpoint.errors.join(" ")).toContain("Step 0, t=0.5, 540×820: mid-motion failed");
        const geometry = yield* service.runVisualSource(
          `<script>window.lbgosVisual={steps:[{label:'panel'}],captions:['Watch the change.'],render(){if(!((innerWidth===540&&innerHeight===820)||(innerWidth===390&&innerHeight===700)))throw new Error('Wrong viewport: '+innerWidth+'x'+innerHeight)}}</script>`,
          "visuals/geometry.html",
        );
        expect(geometry.passed).toBe(true);
        expect(geometry.errors).toEqual([]);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const output = path.resolve("node_modules/.cache/lbgos-visual-run");
        const root = path.join(output, "lab");
        yield* fs.makeDirectory(path.join(root, "visuals"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "visuals/assignment.html"), assignmentVisual);
        const thread = { ...liveThreadShell(ThreadId.make("visual-builder")), worktreePath: root };
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("visual-test"),
          capabilities: new Set(),
          issuedAt: 0,
          requestNamespace: "visual-test",
          client: undefined,
          thread: {
            threadId: thread.id,
            providerSessionId: "visual-session",
            providerInstanceId: thread.providerInstanceId,
          },
        };
        const dependencies = Layer.mergeAll(
          Files.layer,
          Layer.succeed(Sims.PhysicsSimService, service),
          Layer.mock(Threads.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(thread),
          }),
          Layer.mock(Projects.ProjectService)({}),
          Layer.mock(Boards.PhysicsBoardService)({}),
          ModelContext.layerEmpty,
        );
        const handlers = Access.HandlersLayer.layer(Handlers.layerImages).pipe(
          Layer.provideMerge(Physics.layer.pipe(Layer.provideMerge(dependencies))),
        );
        const result = yield* Effect.gen(function* () {
          const toolkit = yield* PhysicsImageToolkit;
          const call = yield* toolkit
            .handle("visual_run", { path: "visuals/assignment.html" })
            .pipe(Stream.unwrap, Stream.runHead, Effect.flatMap(Effect.fromOption));
          expect(call.isFailure).toBe(false);
          return yield* Schema.decodeUnknownEffect(VisualRunTool.successSchema)(call.encodedResult);
        }).pipe(Effect.provide(handlers), Effect.provideService(McpInvocationContext, scope));
        expect(result.passed).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.consoleMessages.filter((m) => m.level === "error")).toEqual([]);
        expect(result.steps).toHaveLength(3);
        expect(
          result.screenshots.map(({ step, t, width, height }) => ({ step, t, width, height })),
        ).toEqual([
          ...[0, 1, 2].flatMap((step) =>
            [0.5, 1].map((t) => ({ step, t, width: 540, height: 820 })),
          ),
          { step: 2, t: 1, width: 390, height: 700 },
        ]);
        expect(result.screenshots[2]?.data).not.toBe(result.screenshots[3]?.data);

        for (const frame of result.screenshots) {
          const png = Buffer.from(frame.data, "base64");
          expect(png.readUInt32BE(0)).toBe(0x89504e47);
          expect(png.readUInt32BE(16)).toBe(frame.width);
          expect(png.readUInt32BE(20)).toBe(frame.height);
          yield* fs.writeFile(
            path.join(
              output,
              `assignment-step-${frame.step}-t-${frame.t}-${frame.width}x${frame.height}.png`,
            ),
            Buffer.from(frame.data, "base64"),
          );
        }
        yield* fs.writeFileString(
          path.join(output, "result.json"),
          JSON.stringify(
            {
              path: result.path,
              passed: result.passed,
              steps: result.steps,
              errors: result.errors,
              consoleMessages: result.consoleMessages,
            },
            null,
            2,
          ),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  120000,
);
