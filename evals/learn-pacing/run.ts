#!/usr/bin/env node
// An eval script, not server code: it writes result files directly.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { ProviderDriverKind } from "@t3tools/contracts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { LEARN_JOBS_CONTEXT_KEY } from "../../apps/server/src/learn/jobs/jobsContext.ts";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { HtmlToolkit } from "../../apps/server/src/mcp/toolkits/html/tools.ts";
import { JobsToolkit } from "../../apps/server/src/mcp/toolkits/jobs/tools.ts";
import { LearnToolkit } from "../../apps/server/src/mcp/toolkits/learn/tools.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import { PhysicsToolkit } from "../../apps/server/src/mcp/toolkits/physics/tools.ts";
import { tutorInstructions } from "../../apps/server/src/physics/templates/index.ts";
import { prependAppModelContext } from "../../apps/server/src/provider/appModelContext.ts";
import {
  formatParkedContext,
  formatSessionContext,
  LEARN_BREAK_CONTEXT_KEY,
} from "../../packages/learn/src/session/context.ts";
import {
  type SessionToolName,
  sessionToolResultMessage,
} from "../../packages/learn/src/session/tools.ts";
import { proxyConfig } from "../shared/proxy.ts";
import { cases, type PacingCase } from "./cases.ts";
import {
  MCP_PREFIX,
  runClaudeCodeSample,
  startMcpServer,
  type McpServerHandle,
  type McpTool,
} from "./claudeCode.ts";
import { createEvalSession, historyGate } from "./session.ts";
import { grade, stepFrom, type Block, type Step } from "./grade.ts";
import { simulateTool, type ResultItem, type ToolOutcome } from "./results.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", multiple: true },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    concurrency: { type: "string", default: "4" },
    "max-steps": { type: "string", default: "6" },
    proxy: { type: "string", default: "vibeproxy" },
    backend: { type: "string", default: "api" },
    "base-url": { type: "string" },
    baseline: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model <id>] [--case <id>].");
const outDirectory = values.out;
const models = values.model ?? ["claude-haiku-5-5"];
const samples = Number(values.samples);
const maxSteps = Number(values["max-steps"]);
const selected = values.case ? cases.filter((entry) => values.case!.includes(entry.id)) : cases;
if (selected.length === 0) throw new Error(`No case matches ${values.case?.join(", ")}.`);
// `api` posts Messages API requests; `claude-code` runs each turn through Claude Code as T3 does.
const backend = values.backend;
if (backend !== "api" && backend !== "claude-code")
  throw new Error("Use --backend api or --backend claude-code.");

const PREFIX = MCP_PREFIX;
const DRIVER = ProviderDriverKind.make("claudeAgent");
// The tutor thread's T3 tools for this flow: session questions, background jobs, task_status,
// the Lab's sim, visual and board tools, and html_render.
const sourceTools: ReadonlyArray<Tool.Any> = [
  ...Object.values(LearnToolkit.tools),
  ...Object.values(JobsToolkit.tools),
  OrchestratorToolkit.tools.task_status,
  ...Object.values(PhysicsToolkit.tools),
  ...Object.values(HtmlToolkit.tools),
];
const tools = [
  ...sourceTools.map((tool) => ({
    name: `${PREFIX}${tool.name}`,
    description: Tool.getDescription(tool) ?? "",
    input_schema: advertisedJsonSchema(tool),
  })),
  // The API backend's stand-in for Claude Code's file reader, so a tutor can load a visual's HTML.
  {
    name: "Read",
    description: "Read a file from the Lab workspace.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
];
// The same tools as T3's MCP server lists them, for the claude-code backend.
const mcpTools: ReadonlyArray<McpTool> = sourceTools.map((tool) => ({
  name: tool.name,
  description: Tool.getDescription(tool) ?? "",
  inputSchema: advertisedJsonSchema(tool),
  annotations: {
    ...Option.match(Context.getOption(tool.annotations, Tool.Title), {
      onNone: () => ({}),
      onSome: (title) => ({ title }),
    }),
    readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
    destructiveHint: Context.get(tool.annotations, Tool.Destructive),
    idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
    openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
  },
}));
// The text T3 appends to Claude Code's system prompt; Claude Code's own preset is left out.
const system =
  buildRuntimeInstructions({ harness: "Claude Code" }) + T3_CODE_ORCHESTRATION_INSTRUCTIONS;
// Claude Code's wrapper for the Lab's CLAUDE.md, which it puts at the start of the first user message.
const projectInstructions = `<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\nContents of /home/user/PhysicsLab/CLAUDE.md (project instructions, checked into the codebase):\n\n${tutorInstructions}\n</system-reminder>`;

interface Message {
  readonly role: "user" | "assistant";
  readonly content: ReadonlyArray<Block>;
}

/** Each learner message carries the context block T3 prepends for non-Codex providers. */
const learnerText = (
  entry: PacingCase,
  text: string,
  turn: Pick<PacingCase, "learnJobs" | "learnBreak"> & { readonly parked?: string } = {},
) =>
  prependAppModelContext({
    driver: DRIVER,
    text,
    appContext: [
      {
        key: "mcp_app_physics_session",
        text: [formatSessionContext({ ...entry.session, includeInstructions: true }), turn.parked]
          .filter(Boolean)
          .join("\n"),
      },
      ...(turn.learnJobs === undefined
        ? []
        : [{ key: LEARN_JOBS_CONTEXT_KEY, text: turn.learnJobs }]),
      ...(turn.learnBreak === undefined
        ? []
        : [{ key: LEARN_BREAK_CONTEXT_KEY, text: turn.learnBreak }]),
    ],
  });

const toolResult = (name: SessionToolName, id: string, input: unknown) =>
  JSON.stringify({
    learnSession: { id, name, input, at: "2026-10-30T12:00:00.000Z" },
    message: sessionToolResultMessage(name, id),
  });

const isSessionTool = (name: string): name is SessionToolName => name in LearnToolkit.tools;

/**
 * The thread so far, with each tool result and the learner's next message in one user turn. The
 * claude-code backend leaves out the CLAUDE.md block: Claude Code reads the Lab's file itself.
 */
const history = (entry: PacingCase, instructions = true): Array<Message> => {
  const messages: Array<Message> = [];
  let pending: Array<Block> = instructions ? [{ type: "text", text: projectInstructions }] : [];
  for (const turn of entry.turns) {
    if (turn.role === "learner") {
      messages.push({
        role: "user",
        content: [...pending, { type: "text", text: learnerText(entry, turn.text) }],
      });
      pending = [];
      continue;
    }
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: turn.text },
        ...(turn.call === undefined
          ? []
          : [
              {
                type: "tool_use",
                id: `toolu_${turn.call.id}`,
                name: `${PREFIX}${turn.call.tool}`,
                input: turn.call.input,
              },
            ]),
      ],
    });
    if (turn.call !== undefined)
      pending = [
        {
          type: "tool_result",
          tool_use_id: `toolu_${turn.call.id}`,
          content: toolResult(turn.call.tool, turn.call.id, turn.call.input),
        },
      ];
  }
  // The server lists open parked questions after the session doctrine, as of the sampled turn.
  const gate = historyGate(entry);
  const parked = formatParkedContext({
    plan: gate.plan,
    planStatuses: entry.session.planStatuses ?? { current: null, visited: new Set() },
    parked: gate.parked.values(),
  });
  messages.push({
    role: "user",
    content: [
      ...pending,
      { type: "text", text: learnerText(entry, entry.message, { ...entry, parked }) },
    ],
  });
  return messages;
};

/** What T3 would return to each call. */
const simulate = (
  entry: PacingCase,
  name: string,
  input: unknown,
  index: number,
  session: ReturnType<typeof createEvalSession>,
): ToolOutcome =>
  isSessionTool(name)
    ? session(name, NodeCrypto.randomUUID(), input)
    : simulateTool(entry, name, input, index);

/** A tool result's content as the Messages API takes it. */
const apiContent = (items: ReadonlyArray<ResultItem>) =>
  items.length === 1 && items[0]!.type === "text"
    ? items[0]!.text
    : items.map((item) =>
        item.type === "text"
          ? item
          : {
              type: "image",
              source: { type: "base64", media_type: item.mimeType, data: item.data },
            },
      );

const ApiResponse = Schema.Struct({
  content: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(ApiResponse));
const encodeRow = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBaselineRow = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      case: Schema.String,
      model: Schema.String,
      pass: Schema.optional(Schema.Boolean),
      error: Schema.optional(Schema.String),
    }),
  ),
);

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const endpoint = anthropicKey
  ? { url: "https://api.anthropic.com/v1", headers: { "x-api-key": anthropicKey } }
  : values["dry-run"] || backend === "claude-code"
    ? { url: "unused", headers: {} }
    : proxyConfig(values.proxy);

const post = Effect.fn("evaluateLearnPacing.post")(function* (body: unknown) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 5,
    }),
  );
  const response = yield* HttpClientRequest.post(`${endpoint.url}/messages`).pipe(
    HttpClientRequest.setHeaders({ ...endpoint.headers, "anthropic-version": "2023-06-01" }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200)
    return yield* Effect.die(new Error(`Model API ${response.status}: ${text.slice(0, 500)}`));
  return decodeResponse(text);
});

const runSample = Effect.fn("evaluateLearnPacing.sample")(function* (
  entry: PacingCase,
  model: string,
  sample: number,
) {
  const messages = history(entry);
  const session = createEvalSession(entry);
  const steps: Array<Step> = [];
  const usage = { input: 0, output: 0 };
  for (let index = 0; index < maxSteps; index++) {
    const response = yield* post({ model, max_tokens: 4096, system, tools, messages });
    usage.input +=
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);
    usage.output += response.usage.output_tokens;
    const calls = response.content.flatMap((block) =>
      block.type === "tool_use"
        ? [
            {
              id: String(block.id),
              tool: String(block.name).replace(PREFIX, ""),
              input: block.input,
            },
          ]
        : [],
    );
    const outcomes = calls.map((call, offset) =>
      simulate(entry, call.tool, call.input, index * 10 + offset, session),
    );
    steps.push(stepFrom(response.content, outcomes, response.stop_reason, PREFIX));
    if (response.stop_reason !== "tool_use") break;
    messages.push(
      { role: "assistant", content: response.content },
      {
        role: "user",
        content: calls.map((call, offset) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: apiContent(outcomes[offset]!.content),
          ...(outcomes[offset]!.isError ? { is_error: true } : {}),
        })),
      },
    );
  }
  return {
    case: entry.id,
    kind: entry.kind,
    model,
    sample,
    ...grade(steps, entry.expect),
    usage,
    steps,
  };
});

/** The claude-code backend: one Claude Code turn that resumes the case's prior turns. */
const runClaudeCode = Effect.fn("evaluateLearnPacing.claudeCodeSample")(function* (
  entry: PacingCase,
  model: string,
  sample: number,
  server: McpServerHandle,
) {
  const session = createEvalSession(entry);
  let index = 0;
  const run = yield* Effect.promise(() =>
    runClaudeCodeSample({
      entry,
      model,
      maxSteps,
      root: NodePath.join(outDirectory, "claude-code"),
      server,
      messages: history(entry, false),
      simulate: (name, input) => simulate(entry, name, input, index++, session),
      ...(values["base-url"] === undefined ? {} : { baseUrl: values["base-url"] }),
    }),
  );
  return {
    case: entry.id,
    kind: entry.kind,
    model,
    sample,
    ...grade(run.steps, entry.expect),
    usage: run.usage,
    costUsd: run.costUsd,
    rateLimit: run.rateLimit,
    sessionId: run.sessionId,
    steps: run.steps,
  };
});

const program = Effect.gen(function* () {
  if (values["dry-run"]) {
    const entry = selected[0]!;
    yield* Console.log(encodeRow({ model: models[0], system, tools, messages: history(entry) }));
    return;
  }
  NodeFS.mkdirSync(outDirectory, { recursive: true });
  const resultsPath = NodePath.join(outDirectory, "results.jsonl");
  NodeFS.writeFileSync(resultsPath, "");
  const tutorText = `Tutor text sha256 ${NodeCrypto.createHash("sha256").update(tutorInstructions).digest("hex").slice(0, 12)}.`;
  yield* Console.log(tutorText);
  const jobs = models.flatMap((model) =>
    selected.flatMap((entry) =>
      Array.from({ length: samples }, (_, sample) => ({ entry, model, sample })),
    ),
  );
  const mcp =
    backend === "claude-code" ? yield* Effect.promise(() => startMcpServer(mcpTools)) : undefined;
  const rows = yield* Effect.forEach(
    jobs,
    ({ entry, model, sample }) =>
      (mcp === undefined
        ? runSample(entry, model, sample)
        : runClaudeCode(entry, model, sample, mcp)
      ).pipe(
        Effect.catchDefect((defect) =>
          Effect.succeed({
            case: entry.id,
            kind: entry.kind,
            model,
            sample,
            error: String(defect),
          }),
        ),
        // Rows land as they finish, so a stopped run keeps its samples.
        Effect.tap((row) =>
          Effect.sync(() => NodeFS.appendFileSync(resultsPath, encodeRow(row) + "\n")),
        ),
      ),
    { concurrency: Number(values.concurrency) },
  );
  if (mcp !== undefined) yield* Effect.promise(mcp.close);
  const baseline = values.baseline
    ? NodeFS.readFileSync(values.baseline, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => decodeBaselineRow(line))
    : [];
  const rate = (
    list: ReadonlyArray<{
      readonly pass?: boolean | undefined;
      readonly error?: string | undefined;
    }>,
  ) => {
    const graded = list.filter((row) => row.error === undefined);
    return `${graded.filter((row) => row.pass).length}/${graded.length}`;
  };
  const lines = [
    `Backend: ${backend}. ${tutorText}`,
    "",
    "| Case | Kind | Model | Passes | Baseline | Failures |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const model of models)
    for (const entry of selected) {
      const mine = rows.filter((row) => row.case === entry.id && row.model === model);
      const before = baseline.filter((row) => row.case === entry.id && row.model === model);
      const failures = mine.flatMap((row) =>
        "failures" in row ? row.failures : "error" in row ? [`error: ${row.error}`] : [],
      );
      lines.push(
        `| ${entry.id} | ${entry.kind} | ${model} | ${rate(mine)} | ${before.length === 0 ? "" : rate(before)} | ${[...new Set(failures)].join("; ")} |`,
      );
    }
  const tokens = rows.reduce(
    (sum, row) =>
      "usage" in row
        ? { input: sum.input + row.usage.input, output: sum.output + row.usage.output }
        : sum,
    { input: 0, output: 0 },
  );
  lines.push("", `Tokens: ${tokens.input} input, ${tokens.output} output.`);
  NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), lines.join("\n") + "\n");
  yield* Console.log(lines.join("\n"));
});

if (import.meta.main) await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)));
