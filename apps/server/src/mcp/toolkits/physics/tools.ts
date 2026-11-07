import {
  OrchestratorMcpFailure,
  PhysicsBoardName,
  PhysicsBoardReadToolResult,
  PhysicsBoardWriteResult,
  PhysicsSimMeasureOptions,
  PhysicsSimMeasureResult,
  PhysicsSimOptions,
  PhysicsSimShowResult,
  PhysicsScreenshot,
  PhysicsSimRunResult,
  PhysicsVisualStep,
  PhysicsVisualShowResult,
} from "@t3tools/contracts";
import { BoardOps } from "@t3tools/physics/board";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as PhysicsService from "../../../physics/PhysicsService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [
  PhysicsService.PhysicsService,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
  description:
    "Project-relative sims/<slug>.sim.js; paths outside this thread's checkout are refused.",
});
export const SimRunTool = Tool.make("sim_run", {
  description:
    "Run a sim file headless and return what it computed: meta, an observable table at samples+1 evenly spaced times, errors, final state, console output and a PNG of the last frame. duration is in seconds (default 5); samples is the number of intervals (default 20); params overrides declared parameters within their bounds. Use it to check the physics before sim_show: energy conservation, periods, limiting cases. Sims are sims/<slug>.sim.js files you write with your file tools; the API is in AGENTS.md and sims/physics-sim.d.ts.",
  parameters: Schema.Struct({ path: Path, ...PhysicsSimOptions.fields }),
  success: Schema.Struct({
    ...PhysicsSimRunResult.fields,
    consoleMessages: Schema.Array(
      Schema.Struct({
        level: Schema.Literals(["log", "info", "warning", "error"]),
        text: Schema.String,
      }),
    ),
    screenshot: Schema.optional(PhysicsScreenshot),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const VisualPath = Schema.String.check(
  Schema.isPattern(/^visuals\/[a-z0-9][a-z0-9-]*\.html$/),
  Schema.isMaxLength(512),
);
export const VisualRunTool = Tool.make("visual_run", {
  description:
    "Check an offline visuals/<slug>.html file headlessly. Validates window.lbgosVisual including one short caption per step, seeks each step at t=0, 0.5 and 1, and returns passed, ordered steps, errors, console output and 540×820 PNGs at t=0.5 and t=1 per step plus a final 390×700 phone frame. Inspect every frame and fix the file until passed:true before reporting a completed animation.",
  parameters: Schema.Struct({ path: VisualPath }),
  success: Schema.Struct({
    path: Schema.String,
    passed: Schema.Boolean,
    steps: Schema.Array(PhysicsVisualStep),
    errors: Schema.Array(Schema.String),
    consoleMessages: Schema.Array(
      Schema.Struct({
        level: Schema.Literals(["log", "info", "warning", "error"]),
        text: Schema.String,
      }),
    ),
    screenshots: Schema.Array(
      Schema.Struct({ ...PhysicsScreenshot.fields, step: Schema.Int, t: Schema.Number }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const VisualShowTool = Tool.make("visual_show", {
  description:
    "Open a checked visuals/<slug>.html in the workbench at a zero-based step (default 0). Show step 0 and let the learner use captions, Prev/Next, Play and scrub; their current step is included in model context. Fails if the visual does not pass visual_run.",
  parameters: Schema.Struct({
    path: VisualPath,
    step: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  success: PhysicsVisualShowResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const SimMeasureTool = Tool.make("sim_measure", {
  description:
    "Run a sim headless and time an event: each time an observable crosses a value in one direction (up means from below to above). Crossings are checked every physics step. Returns the crossing times, the intervals between them, their mean and sample standard deviation, and errors. duration defaults to 10 s. Use the same params and crossing as the learner's auto lap to compare their measured period with yours.",
  parameters: Schema.Struct({ path: Path, ...PhysicsSimMeasureOptions.fields }),
  success: PhysicsSimMeasureResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const SimShowTool = Tool.make("sim_show", {
  description:
    "Show a sim to the learner. It appears live in the chat and they can open it in the side panel, change parameters and run it. Runs a 0.1 s check first and returns ok and errors; fix the file and call again if ok is false. title overrides the sim's own title. Call sim_run first and check the numbers, and after any edit to a sim the learner already has open.",
  parameters: Schema.Struct({
    path: Path,
    title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  }),
  success: PhysicsSimShowResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
export const BoardReadTool = Tool.make("board_read", {
  description:
    'Read the shared whiteboard (default "main"). Returns a PNG and the item list with ids, kind, author and bounding box. Learner ink is listed only as a box and point count, so look at the image to read handwriting. include picks image, json or both (default both). Call it when the learner asks you to check their work or says they wrote something.',
  parameters: Schema.Struct({
    board: Schema.optional(PhysicsBoardName),
    include: Schema.optional(Schema.Literals(["image", "json", "both"])),
  }),
  success: PhysicsBoardReadToolResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const BoardWriteTool = Tool.make("board_write", {
  description:
    "Write to the shared whiteboard (default \"main\") as the agent. ops: add {items}, update {id, patch}, remove {ids}, clear. Item kinds: text, math (LaTeX), shape (rect, ellipse, line, arrow), plot (expr in x, xMin, xMax, w, h), image (data URL), table (columns, numeric rows). Leave out x and y to place items under the existing content. Colors: white, red, blue, green, yellow, gray. Don't remove or clear the learner's items unless they ask.",
  parameters: Schema.Struct({ board: Schema.optional(PhysicsBoardName), ops: BoardOps }),
  success: PhysicsBoardWriteResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
export const PhysicsToolkit = Toolkit.make(
  SimRunTool,
  VisualRunTool,
  VisualShowTool,
  SimMeasureTool,
  SimShowTool,
  BoardReadTool,
  BoardWriteTool,
);
export const PhysicsImageToolkit = Toolkit.make(SimRunTool, VisualRunTool, BoardReadTool);
export const PhysicsReferenceToolkit = Toolkit.make(
  SimMeasureTool,
  SimShowTool,
  VisualShowTool,
  BoardWriteTool,
);
