import { assert, describe, it } from "@effect/vitest";
import {
  ContextHandoffId,
  MEMORY_FLUSH_MESSAGE_PREFIX,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { type ContextStep, nextContextStep, resetRecap } from "./contextFlush.ts";

const MINUTE = 60_000;
const start = "2026-11-10T09:00:00.000Z";
const startMs = Date.parse(start);
const claude = ProviderInstanceId.make("claude");
const thread1 = ProviderThreadId.make("provider-thread:1");
const thread2 = ProviderThreadId.make("provider-thread:2");
const at = (ms: number) => DateTime.makeUnsafe(ms);

const run = (ordinal: number, fields: Partial<ReturnType<typeof baseRun>> = {}) => ({
  ...baseRun(ordinal),
  ...fields,
});
const baseRun = (ordinal: number) => ({
  id: RunId.make(`run:${ordinal}`),
  ordinal,
  status: "completed" as "completed" | "running" | "failed",
  providerThreadId: thread1 as ProviderThreadId | null,
  providerInstanceId: claude,
  userMessageId: MessageId.make(`message:${ordinal}`),
  requestedAt: at(startMs + (ordinal - 1) * MINUTE),
  completedAt: at(startMs + ordinal * MINUTE) as DateTime.Utc | null,
  modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
  contextHandoffId: null as ContextHandoffId | null,
});
const records = (
  runs: ReadonlyArray<ReturnType<typeof run>>,
  thread: Partial<{ activeProviderThreadId: ProviderThreadId; settledOverride: "settled" }> = {},
  pending = false,
) => ({
  thread: {
    activeProviderThreadId: thread1,
    providerInstanceId: claude,
    deletedAt: null,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    ...thread,
  },
  runs,
  runtimeRequests: pending ? [{ status: "pending" as const }] : [],
  providerThreads: [{ id: thread1, driver: ProviderDriverKind.make("claudeAgent") }],
});
const flushRun = run(2, { userMessageId: MessageId.make(`${MEMORY_FLUSH_MESSAGE_PREFIX}run:1`) });
const done = startMs + MINUTE;

const flush = (runId: string): ContextStep => ({ type: "flush", runId: RunId.make(runId) });
const reset = (runId: string): ContextStep => ({ type: "reset", runId: RunId.make(runId) });
const iso = (ms: number) => DateTime.formatIso(at(ms));

describe("nextContextStep", () => {
  const cases: ReadonlyArray<[string, ReturnType<typeof records>, number, ContextStep | null]> = [
    [
      "waits for Claude's boundary",
      records([run(1)]),
      done + 10 * MINUTE,
      { type: "wait", untilMs: done + 55 * MINUTE },
    ],
    ["flushes at the boundary", records([run(1)]), done + 55 * MINUTE, flush("run:1")],
    [
      "resets without a flush once the cache went cold",
      records([run(1)]),
      done + 61 * MINUTE,
      reset("run:1"),
    ],
    [
      "resets after a failed flush",
      records([run(1), { ...flushRun, status: "failed" }]),
      done,
      reset("run:2"),
    ],
    [
      "flushes a DeepSeek lesson late",
      records([run(1, { modelSelection: { instanceId: claude, model: "deepseek-v4.1-flash" } })]),
      done + 7 * 60 * MINUTE,
      flush("run:1"),
    ],
    [
      "waits while a run is busy",
      records([run(1, { status: "running" })]),
      done + 99 * MINUTE,
      null,
    ],
    ["waits on a pending question", records([run(1)], {}, true), done + 55 * MINUTE, null],
    [
      "leaves a settled lesson",
      records([run(1)], { settledOverride: "settled" }),
      done + 55 * MINUTE,
      null,
    ],
    [
      "leaves a context that is already fresh",
      records([run(1)], { activeProviderThreadId: thread2 }),
      done + 55 * MINUTE,
      null,
    ],
    [
      "leaves a thread whose next run moves to another provider",
      records([run(1, { providerInstanceId: ProviderInstanceId.make("codex") })]),
      done + 55 * MINUTE,
      null,
    ],
  ];
  it.each(cases)("%s", (_name, input, nowMs, expected) => {
    assert.deepStrictEqual(nextContextStep(input, undefined, nowMs), expected);
  });

  it("leaves a paused lesson until the learner resumes it", () => {
    assert.strictEqual(nextContextStep(records([run(1)]), iso(done), done + 55 * MINUTE), null);
    assert.deepStrictEqual(
      nextContextStep(records([run(1)]), iso(startMs - MINUTE), done + 55 * MINUTE),
      flush("run:1"),
    );
  });
});

describe("resetRecap", () => {
  const message = (
    id: string,
    runId: string,
    role: "user" | "assistant",
    text: string,
    minute: number,
    createdBy: "user" | "agent" = role === "user" ? "user" : "agent",
  ) => ({
    id: MessageId.make(id),
    runId: RunId.make(runId),
    role,
    text,
    streaming: false,
    createdAt: at(startMs + minute * MINUTE),
    createdBy,
  });
  const messages = [
    message("message:1", "run:1", "user", "What is impulse?", 0),
    message("reply:1", "run:1", "assistant", "x".repeat(700), 1),
    message(
      `${MEMORY_FLUSH_MESSAGE_PREFIX}run:1`,
      "run:2",
      "user",
      "[Context flush] …",
      60,
      "agent",
    ),
    message("reply:2", "run:2", "assistant", "Saved.", 61),
    message("message:3", "run:3", "user", "And momentum?", 120),
  ];
  const runs = [
    run(1),
    flushRun,
    run(3, { providerThreadId: thread2, requestedAt: at(startMs + 120 * MINUTE) }),
  ];

  it("recaps the lesson without the flush for the first run after a reset", () => {
    const recap = resetRecap({ runs, messages, runId: "run:3", providerThreadId: thread2 });
    assert.deepStrictEqual(recap?.split("\n").slice(1), [
      "learner (2026-11-10 09:00): What is impulse?",
      `you (2026-11-10 09:01): ${"x".repeat(599)}…`,
    ]);
  });

  it("adds nothing where the conversation or a handoff already holds the lesson", () => {
    assert.strictEqual(
      resetRecap({ runs, messages, runId: "run:2", providerThreadId: thread1 }),
      undefined,
    );
    const handedOff = runs.map((r) =>
      r.id === "run:3" ? { ...r, contextHandoffId: ContextHandoffId.make("handoff:1") } : r,
    );
    assert.strictEqual(
      resetRecap({ runs: handedOff, messages, runId: "run:3", providerThreadId: thread2 }),
      undefined,
    );
    assert.strictEqual(
      resetRecap({ runs: [run(1)], messages, runId: "run:1", providerThreadId: thread1 }),
      undefined,
    );
  });
});
