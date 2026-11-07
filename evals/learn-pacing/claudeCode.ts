// The `--backend claude-code` path: a sampled turn runs through Claude Code the way T3 runs a Lab
// tutor turn. The Agent SDK gets the Claude adapter's own query options, the Lab's CLAUDE.md sits in
// the working directory and the T3 tools come from a local HTTP MCP server.
//
// The case's prior turns are played into the same Claude Code session first, against a local
// scripted Messages endpoint, so Claude Code records them with its own attachments and with the
// ToolSearch load a tutor makes before its first T3 tool call. The sampled turn then resumes that
// session on the host's Claude login. Built-in tools other than Lab reads are refused.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  query,
  type HookCallback,
  type Options,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  claudeMcpQueryOverrides,
  makeClaudeQueryOptions,
} from "../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { learnResultMeta } from "../../apps/server/src/mcp/toolkits/learn/tools.ts";
import { tutorInstructions } from "../../apps/server/src/physics/templates/index.ts";
import type { PacingCase } from "./cases.ts";
import { stepFrom, type Block, type Step } from "./grade.ts";
import { LAB_FILES, type ResultItem, type ToolOutcome } from "./results.ts";

export const MCP_PREFIX = "mcp__t3-code__";

/** A tool as T3's MCP server lists it. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}
interface Message {
  readonly role: "user" | "assistant";
  readonly content: ReadonlyArray<Block>;
}
type Simulate = (name: string, input: unknown) => ToolOutcome;
/** A scripted Messages API response: content blocks and why it stopped. */
interface Scripted {
  readonly content: ReadonlyArray<Block>;
  readonly stop: "end_turn" | "tool_use";
}

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(JsonRpcRequest));
const MessagesRequest = Schema.Struct({
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeMessagesRequest = Schema.decodeUnknownSync(Schema.fromJsonString(MessagesRequest));
const decodeBlocks = Schema.decodeUnknownSync(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const mcpContent = (item: ResultItem) =>
  item.type === "text" ? item : { type: "image", data: item.data, mimeType: item.mimeType };

/** A Messages API stream for one scripted response. */
const sse = (scripted: Scripted, model: string) => {
  const events: Array<[string, Record<string, unknown>]> = [
    [
      "message_start",
      {
        message: {
          id: `msg_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ],
  ];
  scripted.content.forEach((block, index) => {
    const text = block.type === "text";
    events.push(
      [
        "content_block_start",
        { index, content_block: text ? { type: "text", text: "" } : { ...block, input: {} } },
      ],
      [
        "content_block_delta",
        {
          index,
          delta: text
            ? { type: "text_delta", text: block.text }
            : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      ],
      ["content_block_stop", { index }],
    );
  });
  events.push(
    [
      "message_delta",
      { delta: { stop_reason: scripted.stop, stop_sequence: null }, usage: { output_tokens: 0 } },
    ],
    ["message_stop", {}],
  );
  return events
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    .join("");
};

const readBody = (request: NodeHttp.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => resolve(body));
  });

/**
 * One local server for the run. `/mcp/<id>` is a streamable-HTTP MCP server answering with JSON
 * bodies, one per sample so calls reach that sample's simulator. `/anthropic/<id>` is the scripted
 * Messages endpoint that plays a sample's prior turns.
 */
export async function startMcpServer(tools: ReadonlyArray<McpTool>) {
  const mcp = new Map<string, Simulate>();
  const scripts = new Map<string, { readonly model: string; readonly queue: Array<Scripted> }>();
  const answer = (simulate: Simulate, method: string, params: Record<string, unknown>) => {
    if (method === "initialize")
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "lbgos learn", version: "0.0.0" },
      };
    if (method === "tools/list") return { tools };
    if (method === "tools/call") {
      const name = String(params.name);
      const outcome = simulate(name, params.arguments ?? {});
      // T3's own `_meta`: an accepted question ends Claude Code's turn after its result.
      const meta = learnResultMeta(name, outcome.isError);
      return {
        content: outcome.content.map(mcpContent),
        isError: outcome.isError,
        ...(outcome.isError || outcome.structured === undefined
          ? {}
          : { structuredContent: outcome.structured }),
        ...(meta === undefined ? {} : { _meta: meta }),
      };
    }
    return {};
  };
  const server = NodeHttp.createServer(async (request, response) => {
    const [, kind, id, ...rest] = (request.url ?? "").split("/");
    const body = await readBody(request);
    if (kind === "anthropic") {
      const script = scripts.get(id ?? "");
      if (script === undefined) return void response.writeHead(404).end();
      if (rest.join("/").startsWith("v1/messages/count_tokens"))
        return void response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"input_tokens":1000}');
      if (!rest.join("/").startsWith("v1/messages"))
        return void response.writeHead(200, { "content-type": "application/json" }).end("{}");
      // Requests without tools are Claude Code's side calls, such as a title; they take no turn.
      const main = (decodeMessagesRequest(body).tools ?? []).length > 0;
      const next = main ? script.queue.shift() : undefined;
      response.writeHead(200, { "content-type": "text/event-stream" });
      return void response.end(
        sse(
          next ?? { content: main ? [] : [{ type: "text", text: "Lab" }], stop: "end_turn" },
          script.model,
        ),
      );
    }
    const simulate = mcp.get(id ?? "");
    if (kind !== "mcp" || simulate === undefined) return void response.writeHead(404).end();
    if (request.method === "DELETE") return void response.writeHead(200).end();
    if (request.method !== "POST") return void response.writeHead(405).end();
    const message = decodeRequest(body);
    if (message.id === undefined) return void response.writeHead(202).end();
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: answer(simulate, message.method, message.params ?? {}),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Local server has no port.");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    /** A sample's MCP endpoint; `use` swaps its simulator between the history and the turn. */
    mcp: (id: string, simulate: Simulate) => {
      mcp.set(id, simulate);
      return {
        endpoint: `${origin}/mcp/${id}`,
        use: (next: Simulate) => mcp.set(id, next),
        close: () => mcp.delete(id),
      };
    },
    /** A Messages endpoint that answers a sample's main-loop requests from `queue`, in order. */
    script: (id: string, model: string, queue: Array<Scripted>) => {
      scripts.set(id, { model, queue });
      return { baseUrl: `${origin}/anthropic/${id}`, close: () => scripts.delete(id) };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type McpServerHandle = Awaited<ReturnType<typeof startMcpServer>>;

/** The Claude adapter excludes every CLAUDE.md above the Lab; this repeats its list. */
const ancestorExcludes = (lab: string) => {
  const excludes: Array<string> = [];
  let ancestor = NodePath.dirname(NodePath.resolve(lab));
  while (true) {
    excludes.push(
      NodePath.join(ancestor, "CLAUDE.md"),
      NodePath.join(ancestor, "CLAUDE.local.md"),
      NodePath.join(ancestor, ".claude", "CLAUDE.md"),
      NodePath.join(ancestor, ".claude", "rules", "**"),
    );
    const parent = NodePath.dirname(ancestor);
    if (parent === ancestor) return excludes;
    ancestor = parent;
  }
};

const Credentials = Schema.Struct({
  claudeAiOauth: Schema.Struct({ accessToken: Schema.String, expiresAt: Schema.Number }),
});
const decodeCredentials = Schema.decodeUnknownSync(Schema.fromJsonString(Credentials));
/** The host CLI's OAuth login, read per sample so a refresh by another process is picked up. */
const oauthToken = () => {
  const { claudeAiOauth } = decodeCredentials(
    NodeFS.readFileSync(NodePath.join(NodeOS.homedir(), ".claude", ".credentials.json"), "utf8"),
  );
  if (claudeAiOauth.expiresAt < DateTime.toEpochMillis(DateTime.nowUnsafe()) + 5 * 60_000)
    throw new Error("The Claude Code OAuth token expires within 5 minutes; refresh the login.");
  return claudeAiOauth.accessToken;
};

/**
 * Claude Code's environment: this process's, without its own Claude session or proxy settings,
 * plus the entrypoint T3 sets. A `baseUrl` replaces the OAuth login with a placeholder key.
 */
const cliEnvironment = (
  configDir: string,
  baseUrl: string | undefined,
  extra: Readonly<Record<string, string>> = {},
) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !/^(ANTHROPIC_|CLAUDE)/.test(key),
    ),
  ),
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_ENTRYPOINT: "t3-code",
  ...(baseUrl === undefined
    ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken() }
    : { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "local" }),
  ...extra,
});

const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);
/** Reads stay inside the Lab; T3 tools and ToolSearch run; everything else is refused. */
const guard =
  (lab: string): HookCallback =>
  async (hook) => {
    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    });
    if (hook.hook_event_name !== "PreToolUse") return {};
    if (hook.tool_name.startsWith(MCP_PREFIX) || hook.tool_name === "ToolSearch") return {};
    if (!READ_TOOLS.has(hook.tool_name)) return deny("Not available in this Lab.");
    const input = hook.tool_input;
    const target =
      typeof input === "object" && input !== null
        ? Object.entries(input).find(([key]) => key === "file_path" || key === "path")?.[1]
        : undefined;
    const resolved = NodePath.resolve(lab, typeof target === "string" ? target : ".");
    return resolved === lab || resolved.startsWith(`${lab}${NodePath.sep}`)
      ? {}
      : deny("Only files inside the Lab can be read.");
  };

/**
 * The prior turns as prompts and scripted responses. A tutor turn that calls a T3 tool first loads
 * it with ToolSearch, as tutors do. A question's result ends the turn, as T3 marks it; after any
 * other call the turn ends with an empty reply.
 */
const historyScript = (messages: ReadonlyArray<Message>) => {
  const prompts: Array<string> = [];
  const queue: Array<Scripted> = [];
  const results: Array<ToolOutcome> = [];
  const loaded = new Set<string>();
  // Naming the tools terminal keeps Claude Code from nudging those empty replies.
  const terminalTools = () => [...loaded].join(",");
  for (const message of messages) {
    if (message.role === "user") {
      for (const block of message.content) {
        if (block.type === "text") prompts.push(String(block.text));
        if (block.type === "tool_result") {
          const text = String(block.content);
          results.push({
            input: undefined,
            problems: [],
            isError: false,
            content: [{ type: "text", text }],
            structured: decodeJson(text),
          });
        }
      }
      continue;
    }
    const call = message.content.find((block) => block.type === "tool_use");
    const name = call === undefined ? undefined : String(call.name);
    if (name !== undefined && !loaded.has(name)) {
      loaded.add(name);
      queue.push({
        content: [
          {
            type: "tool_use",
            id: `toolu_load_${loaded.size}`,
            name: "ToolSearch",
            input: { query: `select:${name}`, max_results: 1 },
          },
        ],
        stop: "tool_use",
      });
    }
    queue.push({
      content: message.content.filter(
        (block) => block.type !== "text" || String(block.text) !== "",
      ),
      stop: call === undefined ? "end_turn" : "tool_use",
    });
    if (name !== undefined && learnResultMeta(name.slice(MCP_PREFIX.length), false) === undefined)
      queue.push({ content: [], stop: "end_turn" });
  }
  return { prompts, queue, results, terminalTools: terminalTools() };
};

/** Prompts sent one per turn: each waits for the previous turn's result. */
const turnByTurn = (prompts: ReadonlyArray<string>) => {
  let finished: () => void = () => {};
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    for (const text of prompts) {
      const done = new Promise<void>((resolve) => (finished = resolve));
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
      await done;
    }
  }
  return { stream: stream(), turnEnded: () => finished() };
};

// Once a subscription limit refuses a request or the weekly use passes this share, later
// samples stop before they start, so a long run cannot spend the account's week.
const WEEKLY_CEILING = 0.5;
let rateLimit: SDKRateLimitInfo | undefined;
const limitReached = (info: SDKRateLimitInfo | undefined) =>
  info !== undefined &&
  (info.status === "rejected" ||
    (info.rateLimitType?.startsWith("seven_day") === true &&
      (info.utilization ?? 0) >= WEEKLY_CEILING));

const SAMPLE_TIMEOUT_MS = 15 * 60_000;

export async function runClaudeCodeSample(input: {
  readonly entry: PacingCase;
  readonly model: string;
  readonly maxSteps: number;
  readonly root: string;
  readonly server: McpServerHandle;
  /** The API backend's history, without the CLAUDE.md block; its last message is the prompt. */
  readonly messages: ReadonlyArray<Message>;
  readonly simulate: Simulate;
  /** Send the sampled turn here with a placeholder key instead of the OAuth login. */
  readonly baseUrl?: string;
}) {
  if (limitReached(rateLimit))
    throw new Error(`Stopped by the rate-limit guard: ${JSON.stringify(rateLimit)}`);
  const id = NodeCrypto.randomUUID();
  const lab = NodePath.resolve(input.root, "labs", id);
  const configDir = NodePath.resolve(input.root, "claude");
  // The Lab as T3 creates it: both instruction files, the templates, and a git repo with no commits.
  NodeFS.mkdirSync(NodePath.join(lab, "boards"), { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: lab });
  for (const [path, text] of Object.entries({
    "AGENTS.md": tutorInstructions,
    "CLAUDE.md": tutorInstructions,
    ...LAB_FILES,
    ...input.entry.files,
  })) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(lab, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(lab, path), text);
  }
  const last = input.messages.at(-1);
  if (last === undefined || last.role !== "user") throw new Error("History ends without a prompt.");
  const prompt = last.content.flatMap((block) =>
    block.type === "text" ? [String(block.text)] : [],
  );
  const history = historyScript(input.messages);

  // Calls by tool and arguments, so each tool_use block finds the outcome its MCP call got.
  const outcomes = new Map<string, Array<ToolOutcome>>();
  const key = (name: string, args: unknown) => `${name}\n${JSON.stringify(args)}`;
  const mcp = input.server.mcp(id, () => {
    const result = history.results.shift();
    if (result === undefined) throw new Error("History made more T3 calls than it recorded.");
    return result;
  });
  const script = input.server.script(id, input.model, history.queue);
  const optionsFor = (
    resume: boolean,
    baseUrl: string | undefined,
    extra?: Readonly<Record<string, string>>,
  ): Options => ({
    ...makeClaudeQueryOptions({
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: input.model },
      nativeThreadId: id,
      resume,
      cwd: lab,
      projectOnlySettings: true,
      projectInstructionExcludes: ancestorExcludes(lab),
      environment: cliEnvironment(configDir, baseUrl, extra),
      ...claudeMcpQueryOverrides({
        mcpSession: {
          environmentId: EnvironmentId.make("local"),
          threadId: ThreadId.make(id),
          providerSessionId: id,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          endpoint: mcp.endpoint,
          authorizationHeader: "Bearer eval",
          browserToolsAvailable: false,
        },
        readOnlySandbox: false,
      }),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    }),
    // ToolSearch loads take model calls the api backend does not make.
    maxTurns: input.maxSteps + 4,
    pathToClaudeCodeExecutable: "claude",
    hooks: { PreToolUse: [{ hooks: [guard(lab)] }] },
  });
  const abort = new AbortController();
  AbortSignal.timeout(SAMPLE_TIMEOUT_MS).addEventListener("abort", () => abort.abort());
  const stderr: Array<string> = [];
  const contents = new Map<string, Array<Block>>();
  const stops = new Map<string, string | null>();
  let result: SDKResultMessage | undefined;
  // The last prompt is the sampled turn's; a case without prior turns starts a new session.
  const replayed = history.prompts.length > 1;
  try {
    const turns = turnByTurn(history.prompts.slice(0, -1));
    if (replayed)
      for await (const message of query({
        prompt: turns.stream,
        options: {
          ...optionsFor(false, script.baseUrl, {
            CLAUDE_CODE_TERMINAL_MCP_TOOLS: history.terminalTools,
          }),
          abortController: abort,
          stderr: (text) => stderr.push(text),
        },
      }) as AsyncIterable<SDKMessage>)
        if (message.type === "result") {
          if (message.is_error) throw new Error(`History replay failed: ${message.subtype}`);
          turns.turnEnded();
        }
    if (history.queue.length || history.results.length)
      throw new Error("History replay left scripted turns unused.");

    mcp.use((name, args) => {
      const outcome = input.simulate(name, args);
      outcomes.set(key(name, args), [...(outcomes.get(key(name, args)) ?? []), outcome]);
      return outcome;
    });
    let current = "";
    const turn = turnByTurn([prompt.join("\n\n")]);
    for await (const message of query({
      prompt: turn.stream,
      options: {
        ...optionsFor(replayed, input.baseUrl),
        abortController: abort,
        stderr: (text) => stderr.push(text),
      },
    }) as AsyncIterable<SDKMessage>) {
      if (message.type === "result") {
        result = message;
        turn.turnEnded();
      }
      if (message.type === "rate_limit_event") rateLimit = message.rate_limit_info;
      if (message.type === "stream_event" && message.parent_tool_use_id === null) {
        if (message.event.type === "message_start") current = message.event.message.id;
        if (message.event.type === "message_delta")
          stops.set(current, message.event.delta.stop_reason);
      }
      if (message.type === "assistant" && message.parent_tool_use_id === null)
        contents.set(message.message.id, [
          ...(contents.get(message.message.id) ?? []),
          ...decodeBlocks(message.message.content),
        ]);
    }
  } finally {
    mcp.close();
    script.close();
  }
  if (result === undefined)
    throw new Error(`Claude Code ended without a result: ${stderr.join("").slice(-500)}`);
  if (result.subtype !== "error_max_turns" && (result.subtype !== "success" || result.is_error))
    throw new Error(
      `Claude Code ${result.subtype}: ${"result" in result ? result.result : result.errors.join("; ")}`.slice(
        0,
        500,
      ),
    );
  const taken = new Map<string, number>();
  const steps: Array<Step> = [...contents].map(([messageId, content]) =>
    stepFrom(
      content,
      content.flatMap((block) => {
        if (block.type !== "tool_use") return [];
        const name = String(block.name);
        if (!name.startsWith(MCP_PREFIX)) return [undefined];
        const callKey = key(name.slice(MCP_PREFIX.length), block.input);
        const index = taken.get(callKey) ?? 0;
        taken.set(callKey, index + 1);
        return [outcomes.get(callKey)?.[index]];
      }),
      stops.get(messageId) ??
        (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn"),
      MCP_PREFIX,
    ),
  );
  // `claude/endTurn` ends a successful turn right after the question's tool result.
  const final = steps.at(-1);
  if (final && (result.subtype === "error_max_turns" || final.stopReason === "tool_use"))
    steps[steps.length - 1] = {
      ...final,
      stopReason: result.subtype === "error_max_turns" ? "max_turns" : "end_turn",
    };
  return {
    steps,
    usage: {
      input:
        result.usage.input_tokens +
        (result.usage.cache_read_input_tokens ?? 0) +
        (result.usage.cache_creation_input_tokens ?? 0),
      output: result.usage.output_tokens,
    },
    costUsd: result.total_cost_usd,
    rateLimit,
    sessionId: id,
  };
}
