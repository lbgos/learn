import { expect, it } from "@effect/vitest";
import { EnvironmentId, Project, ThreadId, type PhysicsSimRunResult } from "@t3tools/contracts";
import { applyBoardOps, type Board } from "@t3tools/physics/board";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Access from "../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as Handlers from "../../mcp/toolkits/physics/handlers.ts";
import { PhysicsToolkit } from "../../mcp/toolkits/physics/tools.ts";
import * as McpAppModelContext from "../../mcpApps/McpAppModelContext.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Boards from "../../physics/PhysicsBoardService.ts";
import * as Files from "../../physics/PhysicsFiles.ts";
import * as Physics from "../../physics/PhysicsService.ts";
import * as Sims from "../../physics/PhysicsSimService.ts";
import * as Projects from "../../project/ProjectService.ts";

const decodeProject = Schema.decodeSync(Project);
it.effect.each([null, "/lab-checkout"])(
  "lets a shared child use physics tools with parent worktreePath %s",
  (worktreePath) => {
    const parent = { ...liveThreadShell(ThreadId.make("tutor")), worktreePath };
    const child = {
      ...parent,
      id: ThreadId.make("job-child"),
      lineage: {
        parentThreadId: parent.id,
        rootThreadId: parent.id,
        relationshipToParent: "subagent" as const,
      },
    };
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("jobs-test"),
      capabilities: new Set(),
      issuedAt: 0,
      requestNamespace: "child-test",
      thread: {
        threadId: child.id,
        providerSessionId: "child-session",
        providerInstanceId: child.providerInstanceId,
      },
      client: undefined,
    };
    const root = worktreePath ?? "/lab";
    const boards = new Map<string, Board>();
    const boardCalls: Array<readonly [string, string | undefined]> = [];
    const simCalls: Array<readonly [string, string]> = [];
    const empty: Board = { version: 1, revision: 0, items: [] };
    const run: PhysicsSimRunResult = {
      meta: { title: "Pendulum", view: "2d", params: {}, observables: ["x (m)"], plots: [] },
      table: [],
      errors: [],
      finalState: {},
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(id === child.id ? child : parent),
      }),
      Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.succeedSome(
            decodeProject({
              id: parent.projectId,
              title: "Lab",
              workspaceRoot: "/lab",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-24T00:00:00.000Z",
              updatedAt: "2026-10-24T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
      }),
      Layer.mock(Boards.PhysicsBoardService)({
        read: (root, name) =>
          Effect.sync(() => {
            boardCalls.push([root, name]);
            return boards.get(`${root}/${name}`) ?? empty;
          }),
        applyOps: (root, name, ops, author) =>
          Effect.sync(() => {
            boardCalls.push([root, name]);
            const key = `${root}/${name}`;
            const result = applyBoardOps(boards.get(key) ?? empty, ops, author);
            boards.set(key, result.board);
            return {
              ...result,
              revision: result.board.revision,
              changed: result.board.items,
              removed: [],
            };
          }),
      }),
      Layer.mock(Sims.PhysicsSimService)({
        run: (root, path) =>
          Effect.sync(() => {
            simCalls.push([root, path]);
            return { ...run, consoleMessages: [] };
          }),
        measure: (root, path) =>
          Effect.sync(() => {
            simCalls.push([root, path]);
            return { ...run, crossings: [1, 3, 5] };
          }),
      }),
      Layer.mock(Files.PhysicsFiles)({}),
      McpAppModelContext.layerEmpty,
    );
    const physics = Physics.layer.pipe(Layer.provideMerge(dependencies));
    const handlers = Layer.mergeAll(
      Access.HandlersLayer.layer(Handlers.layerImages),
      Access.HandlersLayer.layer(Handlers.layerReferences),
    ).pipe(Layer.provideMerge(physics));
    return Effect.gen(function* () {
      const toolkit = yield* PhysicsToolkit;
      yield* toolkit
        .handle("sim_run", { path: "sims/pendulum.sim.js" })
        .pipe(Stream.unwrap, Stream.runDrain);
      yield* toolkit
        .handle("sim_measure", {
          path: "sims/pendulum.sim.js",
          crossings: { observable: "x (m)", value: 0, direction: "up" },
        })
        .pipe(Stream.unwrap, Stream.runDrain);
      const src = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>').toString("base64")}`;
      yield* toolkit
        .handle("board_write", {
          ops: [{ type: "add", items: [{ kind: "image", id: "figure", src, w: 100, h: 100 }] }],
        })
        .pipe(Stream.unwrap, Stream.runDrain);
      yield* toolkit.handle("board_read", { include: "json" }).pipe(Stream.unwrap, Stream.runDrain);
      const service = yield* Physics.PhysicsService;
      const read = yield* service.boardReadForThread(parent.id, { include: "json" });
      expect(read.items).toMatchObject([{ id: "figure", kind: "image" }]);
      expect(simCalls).toEqual([
        [root, "sims/pendulum.sim.js"],
        [root, "sims/pendulum.sim.js"],
      ]);
      expect(boardCalls).toEqual([
        [root, "main"],
        [root, "main"],
        [root, "main"],
      ]);
    }).pipe(Effect.provide(handlers), Effect.provideService(McpInvocationContext, scope));
  },
);
