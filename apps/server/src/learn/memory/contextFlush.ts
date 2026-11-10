import {
  isMemoryFlushMessage,
  learnSessionPaused,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How long a tutor thread stays idle before it saves notes and starts a fresh provider context,
 * per provider driver, or per model where the model sets the price.
 */
const CONTEXT_BOUNDARY: Record<string, number> = {
  // Claude's prompt cache lasts an hour, Codex's often as long; Claude's idle compaction starts at 58 min.
  claudeAgent: 55 * MINUTE,
  codex: 55 * MINUTE,
  // Uncached DeepSeek reads cost little.
  deepseek: 6 * HOUR,
};
const OTHER = 6 * HOUR;
/**
 * A step this far past its boundary (a restart, a busy host) resets without a flush: a late flush
 * reads a cold cache, and a restart would start one for every idle session at once.
 */
const LATE_MS = 5 * MINUTE;

const contextBoundary = (driver: string, model: string) =>
  CONTEXT_BOUNDARY[model.includes("deepseek") ? "deepseek" : driver] ?? OTHER;

export const FLUSH_PROMPT =
  "[Context flush] Your context for this session resets now. Your next turn starts fresh with your instructions, the session state, the learner notes and the session's last messages. With update_memory, save what later sessions need about the learner that the notes lack: preferences, misconceptions, goals, open follow-ups, each quoting the learner's own words. Call no other tool. Then reply with one word.";

const RECAP_MESSAGES = 12;
const RECAP_MESSAGE_CHARS = 600;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

const terminal = (run: Pick<OrchestrationV2Run, "status">) =>
  run.status === "completed" ||
  run.status === "failed" ||
  run.status === "interrupted" ||
  run.status === "cancelled" ||
  run.status === "rolled_back";

type Run = Pick<
  OrchestrationV2Run,
  | "id"
  | "ordinal"
  | "status"
  | "providerThreadId"
  | "providerInstanceId"
  | "userMessageId"
  | "requestedAt"
  | "completedAt"
  | "modelSelection"
  | "contextHandoffId"
>;
type Message = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "runId" | "role" | "text" | "streaming" | "createdAt" | "createdBy"
>;

/** Runs a memory flush prompt started; their messages are not part of the lesson. */
export const flushRunIds = (messages: ReadonlyArray<Pick<Message, "id" | "role" | "runId">>) =>
  new Set(
    messages.flatMap((m) =>
      m.role === "user" && m.runId !== null && isMemoryFlushMessage(m.id) ? [m.runId] : [],
    ),
  );

export type ContextStep =
  | { readonly type: "wait"; readonly untilMs: number }
  | { readonly type: "flush"; readonly runId: OrchestrationV2Run["id"] }
  | { readonly type: "reset"; readonly runId: OrchestrationV2Run["id"] };

/**
 * What an idle tutor thread does next: wait for its boundary, flush notes while the cache is
 * warm, or reset after a flush. Null when the thread is busy, paused, settled, already fresh or
 * has no runs.
 */
export function nextContextStep(
  records: {
    readonly thread: Pick<
      OrchestrationV2AppThread,
      | "activeProviderThreadId"
      | "providerInstanceId"
      | "deletedAt"
      | "archivedAt"
      | "settledAt"
      | "settledOverride"
    >;
    readonly runs: ReadonlyArray<Run>;
    readonly runtimeRequests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "status">>;
    readonly providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "id" | "driver">>;
  },
  pausedAt: string | undefined,
  nowMs: number,
): ContextStep | null {
  const { thread } = records;
  // A settled or archived lesson rarely resumes, so a flush there is a wasted turn.
  if (
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.settledAt !== null ||
    thread.settledOverride === "settled"
  )
    return null;
  if (records.runs.some((run) => !terminal(run))) return null;
  if (records.runtimeRequests.some((request) => request.status === "pending")) return null;
  const latest = records.runs.reduce<Run | undefined>(
    (found, run) => (found === undefined || run.ordinal > found.ordinal ? run : found),
    undefined,
  );
  // A reset makes a new provider thread active; until a run uses it the context is fresh.
  if (
    latest === undefined ||
    latest.providerThreadId === null ||
    latest.providerThreadId !== thread.activeProviderThreadId
  )
    return null;
  // A flush that failed or was cancelled still resets; the recap carries what it did not save.
  if (isMemoryFlushMessage(latest.userMessageId)) return { type: "reset", runId: latest.id };
  if (latest.status !== "completed" || latest.completedAt === null) return null;
  // A paused lesson resumes with its context and a note on the break.
  if (learnSessionPaused(pausedAt, DateTime.formatIso(latest.requestedAt))) return null;
  // The next run moves to another provider, which starts a new conversation anyway.
  if (latest.providerInstanceId !== thread.providerInstanceId) return null;
  const driver = records.providerThreads.find((t) => t.id === latest.providerThreadId)?.driver;
  const dueMs =
    DateTime.toEpochMillis(latest.completedAt) +
    contextBoundary(driver ?? "", latest.modelSelection.model);
  if (nowMs < dueMs) return { type: "wait", untilMs: dueMs };
  if (nowMs > dueMs + LATE_MS) return { type: "reset", runId: latest.id };
  return { type: "flush", runId: latest.id };
}

/**
 * The session's last messages for the first run of a provider conversation that a reset
 * started, oldest first. Undefined for every other run: the conversation's own history or a
 * context handoff already carries them.
 */
export function resetRecap(input: {
  readonly runs: ReadonlyArray<
    Pick<Run, "id" | "ordinal" | "providerThreadId" | "requestedAt" | "contextHandoffId">
  >;
  readonly messages: ReadonlyArray<Message>;
  readonly runId: string;
  readonly providerThreadId: string;
}): string | undefined {
  const run = input.runs.find((candidate) => candidate.id === input.runId);
  if (run === undefined || run.contextHandoffId !== null) return undefined;
  const earlier = input.runs.filter((candidate) => candidate.ordinal < run.ordinal);
  if (
    earlier.length === 0 ||
    earlier.some((candidate) => candidate.providerThreadId === input.providerThreadId)
  )
    return undefined;
  const flush = flushRunIds(input.messages);
  const startMs = DateTime.toEpochMillis(run.requestedAt);
  const lines = input.messages
    .filter(
      (m) =>
        !m.streaming &&
        (m.role === "assistant" || (m.role === "user" && m.createdBy === "user")) &&
        m.text.trim() !== "" &&
        m.runId !== run.id &&
        (m.runId === null || !flush.has(m.runId)) &&
        DateTime.toEpochMillis(m.createdAt) < startMs,
    )
    .toSorted((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt))
    .slice(-RECAP_MESSAGES)
    .map(
      (m) =>
        `${m.role === "user" ? "learner" : "you"} (${DateTime.formatIso(m.createdAt).slice(0, 16).replace("T", " ")}): ${cut(m.text.trim(), RECAP_MESSAGE_CHARS)}`,
    );
  return lines.length === 0
    ? undefined
    : `Your earlier conversation in this session is not in your history. Its last messages, oldest first:\n${lines.join("\n")}`;
}
