import { boardItemBounds } from "@t3tools/physics/board";
import { intervals, intervalStats } from "@t3tools/physics/measure";
import {
  TurnItemId,
  type PhysicsSimReadInput,
  type PhysicsSimReadResult,
  type PhysicsSimEvent,
  type PhysicsSetModelContextInput,
  type PhysicsWorkspaceInput,
  type PhysicsBoardInput,
  PhysicsBoardApplyInput,
  PhysicsBoardEvent,
  type PhysicsBoardSnapshot,
  PhysicsBoardApplyResult,
  PhysicsWorkspaceResult,
  PhysicsSimOptions,
  PhysicsBoardReadToolResult,
  PhysicsSimShowResult,
  PhysicsVisualShowResult,
  type PhysicsVisualCheck,
  PhysicsBoardWriteResult,
  type PhysicsSimMeasureOptions,
  type PhysicsSimMeasureResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProjectService from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as PhysicsBoardService from "./PhysicsBoardService.ts";
import * as PhysicsSimService from "./PhysicsSimService.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PhysicsFiles from "./PhysicsFiles.ts";

export class PhysicsAccessError extends Schema.TaggedError<PhysicsAccessError>()(
  "PhysicsAccessError",
  {
    resource: Schema.Literals(["project", "thread"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `The physics ${this.resource} is unavailable.`;
  }
}
export class PhysicsContextError extends Schema.TaggedError<PhysicsContextError>()(
  "PhysicsContextError",
  {
    reason: Schema.Literals(["too-large", "store-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.reason === "too-large"
      ? "Model context exceeds 16384 UTF-8 bytes."
      : "Physics model context could not be saved.";
  }
}
export type PhysicsError =
  | PhysicsContextError
  | PhysicsAccessError
  | PhysicsFiles.PhysicsFileError
  | PhysicsSimService.PhysicsSimError;
type SimInput = PhysicsSimOptions & { readonly path: string };
type ReadInput = {
  readonly board?: string | undefined;
  readonly include?: "image" | "json" | "both" | undefined;
};

/** Project-aware API shared by WS clients and thread-scoped agent tools. Low-level services accept canonical roots. */
export class PhysicsService extends Context.Service<
  PhysicsService,
  {
    readonly boardRead: (
      input: PhysicsBoardInput,
    ) => Effect.Effect<PhysicsBoardSnapshot, PhysicsError>;
    readonly boardApplyOps: (
      input: PhysicsBoardApplyInput,
    ) => Effect.Effect<PhysicsBoardApplyResult, PhysicsError>;
    readonly boardSubscribe: (
      input: PhysicsBoardInput,
    ) => Stream.Stream<PhysicsBoardEvent, PhysicsError>;
    readonly listWorkspace: (
      input: PhysicsWorkspaceInput,
    ) => Effect.Effect<PhysicsWorkspaceResult, PhysicsError>;
    readonly readSim: (
      input: PhysicsSimReadInput,
    ) => Effect.Effect<PhysicsSimReadResult, PhysicsError>;
    readonly simSubscribe: (
      input: PhysicsSimReadInput,
    ) => Stream.Stream<PhysicsSimEvent, PhysicsError>;
    readonly setModelContext: (
      input: PhysicsSetModelContextInput,
    ) => Effect.Effect<void, PhysicsError>;
    readonly simRun: (
      threadId: ThreadId,
      input: SimInput,
    ) => Effect.Effect<
      Effect.Success<ReturnType<PhysicsSimService.PhysicsSimService["Service"]["run"]>>,
      PhysicsError
    >;
    readonly simMeasure: (
      threadId: ThreadId,
      input: PhysicsSimMeasureOptions & { readonly path: string },
    ) => Effect.Effect<PhysicsSimMeasureResult, PhysicsError>;
    readonly visualRun: (
      threadId: ThreadId,
      input: { readonly path: string },
    ) => Effect.Effect<PhysicsSimService.VisualRunResult, PhysicsError>;
    readonly visualShow: (
      threadId: ThreadId,
      input: { readonly path: string; readonly step?: number | undefined },
    ) => Effect.Effect<PhysicsVisualShowResult, PhysicsError>;
    readonly simShow: (
      threadId: ThreadId,
      input: { readonly path: string; readonly title?: string | undefined },
    ) => Effect.Effect<PhysicsSimShowResult, PhysicsError>;
    readonly boardReadForThread: (
      threadId: ThreadId,
      input: ReadInput,
    ) => Effect.Effect<PhysicsBoardReadToolResult, PhysicsError>;
    readonly boardWriteForThread: (
      threadId: ThreadId,
      input: { readonly board?: string | undefined; readonly ops: PhysicsBoardApplyInput["ops"] },
    ) => Effect.Effect<PhysicsBoardWriteResult, PhysicsError>;
  }
>()("t3/physics/PhysicsService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* Threads.ThreadManagementService;
  const boards = yield* PhysicsBoardService.PhysicsBoardService;
  const sims = yield* PhysicsSimService.PhysicsSimService;
  const files = yield* PhysicsFiles.PhysicsFiles;
  const modelContext = yield* McpAppModelContext.McpAppModelContext;
  const projectRoot = Effect.fn("PhysicsService.projectRoot")(function* (id: ProjectId) {
    const project = yield* projects
      .getById(id)
      .pipe(Effect.mapError((cause) => new PhysicsAccessError({ resource: "project", cause })));
    if (Option.isNone(project)) return yield* new PhysicsAccessError({ resource: "project" });
    return project.value.workspaceRoot;
  });
  const threadRoot = Effect.fn("PhysicsService.threadRoot")(function* (
    id: ThreadId,
    expectedProject?: ProjectId,
  ) {
    const thread = yield* threads
      .getThreadShell(id)
      .pipe(Effect.mapError((cause) => new PhysicsAccessError({ resource: "thread", cause })));
    if (
      thread === null ||
      thread.deletedAt !== null ||
      (expectedProject !== undefined && thread.projectId !== expectedProject)
    )
      return yield* new PhysicsAccessError({ resource: "thread" });
    return thread.worktreePath ?? (yield* projectRoot(thread.projectId));
  });
  const workspaceRoot = (input: PhysicsWorkspaceInput) =>
    input.threadId === undefined
      ? projectRoot(input.projectId)
      : threadRoot(input.threadId, input.projectId);
  const boardRead = Effect.fn("PhysicsService.boardRead")(function* (input: PhysicsBoardInput) {
    const board = yield* boards.read(yield* workspaceRoot(input), input.board);
    return { board, revision: board.revision };
  });
  const boardApplyOps = Effect.fn("PhysicsService.boardApplyOps")(function* (
    input: PhysicsBoardApplyInput,
  ) {
    const { board: _board, ...delta } = yield* boards.applyOps(
      yield* workspaceRoot(input),
      input.board ?? "main",
      input.ops,
      "user",
    );
    return delta;
  });
  const boardSubscribe = (input: PhysicsBoardInput) =>
    Stream.unwrap(
      workspaceRoot(input).pipe(Effect.map((root) => boards.subscribe(root, input.board))),
    );
  const listWorkspace = (input: PhysicsWorkspaceInput) =>
    workspaceRoot(input).pipe(Effect.flatMap(files.list));
  const readSim = (input: PhysicsSimReadInput) =>
    workspaceRoot(input).pipe(
      Effect.flatMap((root) => files.readSim(root, input.path)),
      Effect.map(({ code, hash }) => ({ code, hash })),
    );
  const simSubscribe = (input: PhysicsSimReadInput) =>
    Stream.unwrap(
      workspaceRoot(input).pipe(Effect.map((root) => files.subscribeSim(root, input.path))),
    );
  const setModelContext = Effect.fn("PhysicsService.setModelContext")(function* (
    input: PhysicsSetModelContextInput,
  ) {
    yield* threadRoot(input.threadId);
    if (
      new TextEncoder().encode(input.text).byteLength >
      McpAppModelContext.MCP_APP_MODEL_CONTEXT_MAX_BYTES
    )
      return yield* new PhysicsContextError({ reason: "too-large" });
    yield* modelContext
      .set({
        threadId: input.threadId,
        itemId: TurnItemId.make(input.key),
        server: "physics",
        tool: "workspace",
        text: input.text,
      })
      .pipe(Effect.mapError((cause) => new PhysicsContextError({ reason: "store-failed", cause })));
  });
  const simRun = Effect.fn("PhysicsService.simRun")(function* (
    threadId: ThreadId,
    input: SimInput,
  ) {
    return yield* sims.run(yield* threadRoot(threadId), input.path, input);
  });
  const simMeasure = Effect.fn("PhysicsService.simMeasure")(function* (
    threadId: ThreadId,
    input: PhysicsSimMeasureOptions & { readonly path: string },
  ) {
    const run = yield* sims.measure(yield* threadRoot(threadId), input.path, input);
    const laps = intervals(run.crossings);
    const stats = intervalStats(laps);
    return {
      duration: run.table.at(-1)?.t ?? 0,
      times: run.crossings,
      intervals: laps,
      ...(stats ? { mean: stats.mean } : {}),
      ...(stats?.sd != null ? { sd: stats.sd } : {}),
      errors: run.errors.map((error) => `${error.phase}: ${error.message}`),
    };
  });
  // Narrating successive steps reuses checks only while the exact source hash still matches.
  const checkedVisuals = new Map<string, PhysicsVisualCheck["steps"]>();
  const rememberVisual = (hash: string, steps: PhysicsVisualCheck["steps"]) => {
    checkedVisuals.set(hash, steps);
    if (checkedVisuals.size > 32) {
      const oldest = checkedVisuals.keys().next().value;
      if (oldest !== undefined) checkedVisuals.delete(oldest);
    }
  };
  const visualRun = Effect.fn("PhysicsService.visualRun")(function* (
    threadId: ThreadId,
    input: { readonly path: string },
  ) {
    if (!/^visuals\/[a-z0-9][a-z0-9-]*\.html$/.test(input.path))
      return yield* new PhysicsFiles.PhysicsFileError({ operation: "read", path: input.path });
    const source = yield* files.readVisual(yield* threadRoot(threadId), input.path);
    const result = yield* sims.runVisualSource(source.code, input.path);
    if (result.passed) rememberVisual(source.hash, result.steps);
    else checkedVisuals.delete(source.hash);
    return result;
  });
  const visualShow = Effect.fn("PhysicsService.visualShow")(function* (
    threadId: ThreadId,
    input: { readonly path: string; readonly step?: number | undefined },
  ) {
    if (!/^visuals\/[a-z0-9][a-z0-9-]*\.html$/.test(input.path))
      return yield* new PhysicsFiles.PhysicsFileError({ operation: "read", path: input.path });
    const source = yield* files.readVisual(yield* threadRoot(threadId), input.path);
    let steps = checkedVisuals.get(source.hash);
    if (steps === undefined) {
      const result = yield* sims.runVisualSource(source.code, input.path);
      if (!result.passed)
        return yield* new PhysicsSimService.PhysicsSimError({
          operation: "visual",
          cause: result.errors,
        });
      steps = result.steps;
      rememberVisual(source.hash, steps);
    }
    const step = input.step ?? 0;
    if (!Number.isInteger(step) || step < 0 || step >= steps.length)
      return yield* new PhysicsSimService.PhysicsSimError({
        operation: "visual",
        cause: ["Step is outside the visual."],
      });
    return {
      physicsVisual: { path: input.path, hash: source.hash, step, label: steps[step]!.label },
    };
  });
  const simShow = Effect.fn("PhysicsService.simShow")(function* (
    threadId: ThreadId,
    input: { readonly path: string; readonly title?: string | undefined },
  ) {
    const source = yield* files.readSim(yield* threadRoot(threadId), input.path);
    const result = yield* sims.runSource(source.code, { duration: 0.1, samples: 2 });
    return {
      physicsSim: {
        hash: source.hash,
        path: input.path,
        title: input.title ?? result.meta.title,
        ok: result.errors.length === 0,
        errors: result.errors.map((error) => `${error.phase}: ${error.message}`),
      },
    };
  });
  const boardReadForThread = Effect.fn("PhysicsService.boardReadForThread")(function* (
    threadId: ThreadId,
    input: ReadInput,
  ) {
    const name = input.board ?? "main";
    const board = yield* boards.read(yield* threadRoot(threadId), name);
    const include = input.include ?? "both";
    return {
      board: name,
      revision: board.revision,
      ...(include === "image"
        ? {}
        : {
            items: board.items.map((item) => ({
              id: item.id,
              kind: item.kind,
              author: item.author,
              bbox: boardItemBounds(item),
              ...(item.kind === "ink"
                ? { pointCount: item.points.length }
                : item.kind === "text"
                  ? { text: item.text }
                  : item.kind === "math"
                    ? { latex: item.latex }
                    : item.kind === "table"
                      ? {
                          columns: item.columns,
                          rows: item.rows.slice(0, 100),
                          rowCount: item.rows.length,
                          ...(item.label ? { label: item.label } : {}),
                        }
                      : item.kind === "plot" && item.label
                        ? { label: item.label }
                        : {}),
            })),
          }),
      ...(include === "json" ? {} : { screenshot: (yield* sims.renderBoard(board)).screenshot }),
    };
  });
  const boardWriteForThread = Effect.fn("PhysicsService.boardWriteForThread")(function* (
    threadId: ThreadId,
    input: { readonly board?: string | undefined; readonly ops: PhysicsBoardApplyInput["ops"] },
  ) {
    const name = input.board ?? "main";
    const result = yield* boards.applyOps(yield* threadRoot(threadId), name, input.ops, "agent");
    return {
      physicsBoard: { board: name, revision: result.revision, createdIds: [...result.createdIds] },
    };
  });
  return PhysicsService.of({
    readSim,
    simSubscribe,
    setModelContext,
    boardRead,
    boardApplyOps,
    boardSubscribe,
    listWorkspace,
    simRun,
    visualRun,
    visualShow,
    simMeasure,
    simShow,
    boardReadForThread,
    boardWriteForThread,
  });
});
export const layer = Layer.effect(PhysicsService, make);
