// What T3's MCP server returns to each tool a tutor calls, shared by every eval backend.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { jobStartedMessage } from "../../apps/server/src/learn/jobs/LearnJobs.ts";
import {
  assignmentVisual,
  pendulumSim,
  physicsSimTypes,
  visualApiTypes,
} from "../../apps/server/src/physics/templates/index.ts";
import type { PacingCase } from "./cases.ts";

export type ResultItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: "image/png" };

/** One tool call as production answers it: MCP `content`, `isError` and `structuredContent`. */
export interface ToolOutcome {
  readonly input: unknown;
  /** Session-gate problems that refused the call. */
  readonly problems: ReadonlyArray<string>;
  readonly isError: boolean;
  readonly content: ReadonlyArray<ResultItem>;
  readonly structured?: unknown;
}

// Every Lab ships these; a case adds its own files.
export const LAB_FILES: Readonly<Record<string, string>> = {
  "sims/pendulum.sim.js": pendulumSim,
  "sims/physics-sim.d.ts": physicsSimTypes,
  "visuals/visual-api.d.ts": visualApiTypes,
  "visuals/assignment.html": assignmentVisual,
};

const pngChunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const frame = Buffer.alloc(12 + data.length);
  frame.writeUInt32BE(data.length);
  body.copy(frame, 4);
  frame.writeUInt32BE(NodeZlib.crc32(body), 4 + body.length);
  return frame;
};
const SIDE = 64;
const header = Buffer.alloc(13);
header.writeUInt32BE(SIDE, 0);
header.writeUInt32BE(SIDE, 4);
header[8] = 8; // 8-bit grayscale
// Stand-in pixels for the screenshots production attaches: a black PNG. The API refuses 1×1 images.
const PNG: ResultItem = {
  type: "image",
  mimeType: "image/png",
  data: Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", NodeZlib.deflateSync(Buffer.alloc((SIDE + 1) * SIDE))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64"),
};

/** effect's McpServer: the encoded result as JSON text, plus the same value as structuredContent. */
export const success = (input: unknown, value: unknown, images: ReadonlyArray<ResultItem> = []) =>
  ({
    input,
    problems: [],
    isError: false,
    content: [{ type: "text", text: JSON.stringify(value) }, ...images],
    structured: value,
  }) satisfies ToolOutcome;

const encodeFailure = Schema.encodeSync(OrchestratorMcpFailure);
/** A failure a `failureMode: "return"` tool hands back: the encoded error as JSON text. */
export const failure = (
  input: unknown,
  code: OrchestratorMcpFailure["code"],
  message: string,
  problems: ReadonlyArray<string> = [],
) =>
  ({
    input,
    problems,
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(encodeFailure(new OrchestratorMcpFailure({ code, message }))),
      },
    ],
  }) satisfies ToolOutcome;

const field = (input: unknown, key: string) =>
  typeof input === "object" && input !== null && key in input
    ? String((input as Record<string, unknown>)[key])
    : "";
const hash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Production results for the non-session tools; the stand-in values are cheap but shaped like T3's. */
export function simulateTool(
  entry: PacingCase,
  name: string,
  input: unknown,
  index: number,
): ToolOutcome {
  if (name === "research" || name === "build_sim" || name === "make_visual")
    return success(input, {
      taskId: `task-${index}`,
      childThreadId: `thread-${index}`,
      providerInstanceId: "claudeAgent",
      model: "claude-haiku-5-5",
      message: jobStartedMessage({
        role: name === "research" ? "research" : name === "build_sim" ? "developer" : "visual",
        routed: true,
        providerInstanceId: "claudeAgent",
        model: "claude-haiku-5-5",
      }),
    });
  if (name === "Read") {
    const file = Object.entries({ ...LAB_FILES, ...entry.files }).find(([path]) =>
      field(input, "file_path").endsWith(path),
    );
    const text = file?.[1] ?? `File does not exist: ${field(input, "file_path")}`;
    return { input, problems: [], isError: file === undefined, content: [{ type: "text", text }] };
  }
  const path = field(input, "path");
  if (name === "html_render")
    return success(input, {
      htmlRender: {
        attachmentId: `thread-tutor-${NodeCrypto.randomUUID()}-html`,
        title: field(input, "title"),
        height: 640,
        heights: [
          [320, 760],
          [728, 640],
        ],
      },
      message:
        "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
    });
  if (name === "html_preview")
    return success(
      input,
      {
        width: 728,
        contentHeight: 640,
        capturedHeight: 640,
        consoleMessages: [],
        screenshot: { mimeType: "image/png", width: 728, height: 640 },
      },
      [PNG],
    );
  if (name === "sim_run")
    return success(
      input,
      {
        meta: { title: "Simulation", params: [], observables: [] },
        table: [{ t: 0, values: [] }],
        errors: [],
        finalState: {},
        consoleMessages: [],
        screenshot: { mimeType: "image/png", width: 900, height: 560 },
      },
      [PNG],
    );
  if (name === "sim_measure")
    return success(input, { duration: 10, times: [], intervals: [], errors: [] });
  if (name === "visual_run")
    return success(
      input,
      {
        path,
        passed: true,
        steps: [{ label: "Step 1" }],
        errors: [],
        consoleMessages: [],
        screenshots: [
          { mimeType: "image/png", width: 540, height: 820, step: 0, t: 0.5 },
          { mimeType: "image/png", width: 390, height: 700, step: 0, t: 1 },
        ],
      },
      [
        { type: "text", text: "Step 0, t=0.5, 540×820" },
        PNG,
        { type: "text", text: "Step 0, t=1, 390×700" },
        PNG,
      ],
    );
  if (name === "sim_show")
    return success(input, {
      physicsSim: {
        path,
        title: field(input, "title") || path,
        ok: true,
        errors: [],
        hash: hash(path),
      },
    });
  if (name === "visual_show")
    return success(input, {
      physicsVisual: {
        path,
        hash: hash(path),
        step: Number(field(input, "step") || 0),
        label: "Step 1",
      },
    });
  if (name === "board_write")
    return success(input, { physicsBoard: { board: "main", revision: 1, createdIds: ["item-1"] } });
  if (name === "board_read")
    return success(
      input,
      {
        board: "main",
        revision: 0,
        items: [],
        screenshot: { mimeType: "image/png", width: 1200, height: 800 },
      },
      [PNG],
    );
  if (name === "task_status") {
    const taskId = field(input, "taskId");
    const result = entry.taskResults?.[taskId];
    if (result === undefined && !entry.learnJobs?.includes(taskId))
      return failure(
        input,
        "task_not_found",
        `Delegated task ${taskId} does not belong to thread thread-tutor.`,
      );
    const done = result !== undefined;
    return success(input, {
      taskId,
      childThreadId: `thread-${taskId}`,
      link: `<t3-thread://v2/local/thread-${taskId}>`,
      childRunId: `run-${taskId}`,
      childNodeId: taskId,
      status: done ? "completed" : "running",
      workState: done ? "result_available" : "working",
      hasPendingChildRuns: false,
      latestTerminalRunId: done ? `run-${taskId}` : null,
      latestTerminalStatus: done ? "completed" : null,
      latestTerminalSummary: null,
      latestTerminalResultContextTransferId: null,
      providerInstanceId: "claudeAgent",
      model: "claude-haiku-5-5",
      options: [],
      summary: result ?? null,
      resultContextTransferId: null,
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });
  }
  return failure(input, "invalid_request", `${name} is not available in this eval.`);
}
