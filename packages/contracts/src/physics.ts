import * as Schema from "effect/Schema";
import { Board, BoardDelta, BoardOps } from "@t3tools/physics/board";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

/** Board files are named `<slug>.board.json`; callers cannot supply paths here. */
export const PhysicsBoardName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
);
export const PhysicsBoardInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  board: Schema.optional(PhysicsBoardName),
});
export const PhysicsBoardApplyInput = Schema.Struct({ ...PhysicsBoardInput.fields, ops: BoardOps });
export const PhysicsBoardEvent = Schema.Union([
  Schema.Struct({ revision: Schema.Int, board: Board }),
  BoardDelta,
]);
export const PhysicsBoardSnapshot = Schema.Struct({ revision: Schema.Int, board: Board });
export const PhysicsBoardApplyResult = Schema.Struct({
  ...BoardDelta.fields,
  createdIds: Schema.Array(Schema.String),
});
export const PhysicsWorkspaceInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
});
export const PhysicsWorkspaceResult = Schema.Struct({
  sims: Schema.Array(Schema.Struct({ path: Schema.String, title: Schema.optional(Schema.String) })),
  boards: Schema.Array(Schema.String),
});
export const PhysicsEnsureLabResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  created: Schema.Boolean,
  /** Instruction files the learner edited; ensureLab leaves them as they are. */
  unmanagedInstructionFiles: Schema.Array(Schema.String),
});
export class PhysicsRequestError extends Schema.TaggedError<PhysicsRequestError>()(
  "PhysicsRequestError",
  {
    operation: Schema.Literals(["read", "write", "subscribe", "list", "scaffold", "context"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Physics workspace ${this.operation} failed.`;
  }
}
export const PhysicsSimOptions = Schema.Struct({
  params: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  duration: Schema.optional(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(120)),
  ),
  samples: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1000 }))),
});
export const PhysicsScreenshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
});
export const PhysicsSimParam = Schema.Struct({
  value: Schema.Finite,
  min: Schema.optional(Schema.Finite),
  max: Schema.optional(Schema.Finite),
  step: Schema.optional(Schema.Finite),
  unit: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
});
export const PhysicsSimMeta = Schema.Struct({
  title: Schema.String,
  view: Schema.Literals(["3d", "2d"]),
  params: Schema.Record(Schema.String, PhysicsSimParam),
  observables: Schema.Array(Schema.String),
  plots: Schema.Array(Schema.Array(Schema.String)),
});
export const PhysicsSimRunError = Schema.Struct({
  message: Schema.String,
  stack: Schema.optional(Schema.String),
  phase: Schema.Literals(["load", "step", "render"]),
});
export const PhysicsSimRunResult = Schema.Struct({
  meta: PhysicsSimMeta,
  table: Schema.Array(Schema.Struct({ t: Schema.Finite, values: Schema.Array(Schema.Finite) })),
  errors: Schema.Array(PhysicsSimRunError),
  finalState: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Finite, Schema.Array(Schema.Finite)]),
  ),
});
export const PhysicsCrossingSpec = Schema.Struct({
  observable: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  value: Schema.Finite,
  direction: Schema.Literals(["up", "down"]),
});
export const PhysicsSimMeasureOptions = Schema.Struct({
  params: PhysicsSimOptions.fields.params,
  duration: PhysicsSimOptions.fields.duration,
  crossings: PhysicsCrossingSpec,
});
/** What the headless runtime returns for a measuring run. */
export const PhysicsSimMeasureRun = Schema.Struct({
  ...PhysicsSimRunResult.fields,
  crossings: Schema.Array(Schema.Finite),
});
export const PhysicsSimMeasureResult = Schema.Struct({
  duration: Schema.Finite,
  /** Crossing times in simulated seconds, at most 1000. */
  times: Schema.Array(Schema.Finite),
  /** Differences between consecutive crossing times. */
  intervals: Schema.Array(Schema.Finite),
  mean: Schema.optional(Schema.Finite),
  /** Sample standard deviation of the intervals. */
  sd: Schema.optional(Schema.Finite),
  errors: Schema.Array(Schema.String),
});
export type PhysicsCrossingSpec = typeof PhysicsCrossingSpec.Type;
export type PhysicsSimMeasureOptions = typeof PhysicsSimMeasureOptions.Type;
export type PhysicsSimMeasureResult = typeof PhysicsSimMeasureResult.Type;
export const PhysicsSimReadInput = Schema.Struct({
  ...PhysicsWorkspaceInput.fields,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export const PhysicsSimReadResult = Schema.Struct({ code: Schema.String, hash: Schema.String });
export const PhysicsSimEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("file"), ...PhysicsSimReadResult.fields }),
  Schema.Struct({ type: Schema.Literal("missing") }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
/** Source is fetched on demand through physicsReadSim and checked against hash. */
export const PhysicsSimShowResult = Schema.Struct({
  physicsSim: Schema.Struct({
    path: Schema.String,
    title: Schema.String,
    ok: Schema.Boolean,
    errors: Schema.Array(Schema.String),
    hash: Schema.String,
  }),
});
export const PhysicsSetModelContextInput = Schema.Struct({
  threadId: ThreadId,
  key: Schema.String.check(Schema.isPattern(/^physics:(?:(?:sim|board|visual):.{1,512}|session)$/)),
  text: Schema.String.check(Schema.isMaxLength(16 * 1024)),
});
export type PhysicsSimRunResult = typeof PhysicsSimRunResult.Type;
export type PhysicsSimReadInput = typeof PhysicsSimReadInput.Type;
export type PhysicsSimReadResult = typeof PhysicsSimReadResult.Type;
export type PhysicsSimEvent = typeof PhysicsSimEvent.Type;
export type PhysicsSetModelContextInput = typeof PhysicsSetModelContextInput.Type;
export const PhysicsBoardWriteResult = Schema.Struct({
  physicsBoard: Schema.Struct({
    board: PhysicsBoardName,
    revision: Schema.Int,
    createdIds: Schema.Array(Schema.String),
    createdCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
});
export type PhysicsBoardInput = typeof PhysicsBoardInput.Type;
export type PhysicsBoardApplyInput = typeof PhysicsBoardApplyInput.Type;
export type PhysicsBoardEvent = typeof PhysicsBoardEvent.Type;
export type PhysicsBoardApplyResult = typeof PhysicsBoardApplyResult.Type;
export type PhysicsWorkspaceInput = typeof PhysicsWorkspaceInput.Type;
export type PhysicsWorkspaceResult = typeof PhysicsWorkspaceResult.Type;
export type PhysicsSimOptions = typeof PhysicsSimOptions.Type;
export type PhysicsSimShowResult = typeof PhysicsSimShowResult.Type;
export type PhysicsBoardWriteResult = typeof PhysicsBoardWriteResult.Type;

export const PhysicsBoardSummaryItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["ink", "text", "math", "shape", "plot", "image", "table"]),
  author: Schema.Literals(["user", "agent"]),
  bbox: Schema.Struct({ x: Schema.Finite, y: Schema.Finite, w: Schema.Finite, h: Schema.Finite }),
  pointCount: Schema.optional(Schema.Int),
  text: Schema.optional(Schema.String),
  latex: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  columns: Schema.optional(Schema.Array(Schema.String)),
  /** Table rows, the first 100 when longer; rowCount has the total. */
  rows: Schema.optional(Schema.Array(Schema.Array(Schema.Finite))),
  rowCount: Schema.optional(Schema.Int),
});
export const PhysicsBoardReadToolResult = Schema.Struct({
  board: PhysicsBoardName,
  revision: Schema.Int,
  items: Schema.optional(Schema.Array(PhysicsBoardSummaryItem)),
  screenshot: Schema.optional(PhysicsScreenshot),
});
export type PhysicsBoardReadToolResult = typeof PhysicsBoardReadToolResult.Type;

/** Ordered scene metadata, shared by visual_run, visual_show and the viewer. */
export const PhysicsVisualStep = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  duration: Schema.optional(
    Schema.Finite.check(Schema.isBetween({ minimum: 100, maximum: 30000 })),
  ),
});
export const PhysicsVisualCheck = Schema.Struct({
  steps: Schema.Array(PhysicsVisualStep),
  captions: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
});
export type PhysicsVisualCheck = typeof PhysicsVisualCheck.Type;
export type PhysicsBoardSnapshot = typeof PhysicsBoardSnapshot.Type;
export const PhysicsVisualShowResult = Schema.Struct({
  physicsVisual: Schema.Struct({
    path: Schema.String,
    hash: Schema.String,
    step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    label: Schema.String,
  }),
});
export type PhysicsVisualShowResult = typeof PhysicsVisualShowResult.Type;
