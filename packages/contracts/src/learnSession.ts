import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

const text = Schema.String.check(Schema.isNonEmpty());
export const LearnCreateSessionInput = Schema.Struct({
  kind: Schema.Literals(["teach", "practice"]),
  title: Schema.optional(text),
  graphContext: Schema.optional(
    Schema.Struct({
      nodeIds: Schema.Array(text),
      text,
    }),
  ),
});
export type LearnCreateSessionInput = typeof LearnCreateSessionInput.Type;
export const LearnSessionSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  kind: Schema.Literals(["teach", "practice"]),
  mechanic: Schema.Literals(["choice", "recall"]),
  createdAt: text,
  graphContext: Schema.optional(Schema.Struct({ nodeIds: Schema.Array(text) })),
  /** Present while the session is paused. */
  pausedAt: Schema.optional(text),
});
export type LearnSessionSummary = typeof LearnSessionSummary.Type;

/** A pause holds until the thread's next run is requested: Resume or any other message ends it. */
export function learnSessionPaused(
  pausedAt: string | undefined,
  latestRunRequestedAt: string | null | undefined,
): boolean {
  return (
    pausedAt !== undefined &&
    (latestRunRequestedAt == null || Date.parse(latestRunRequestedAt) < Date.parse(pausedAt))
  );
}

/** Preserved whole in compact tool output: inputs there may otherwise be truncated. */
export const LearnSessionToolEvent = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[^\s[\]]+$/)),
  name: Schema.Literals([
    "grade_answer",
    "correct_verdict",
    "ask",
    "quiz",
    "explain",
    "probe_done",
    "plan_init",
    "problem",
    "conclude",
    "park_question",
    "answer_parked",
  ]),
  input: Schema.Unknown,
  at: text,
});
export const LearnSessionToolResult = Schema.Struct({
  learnSession: LearnSessionToolEvent,
  message: Schema.String,
});
export type LearnSessionToolResult = typeof LearnSessionToolResult.Type;

/** Replay checkpoint immediately before a bounded thread-history window. */
export const LearnSessionState = Schema.Struct({
  phase: Schema.Literals(["probe", "plan", "teach"]),
  plan: Schema.NullOr(
    Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          summary: Schema.optional(Schema.String),
        }),
      ),
      edges: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
      version: Schema.Int,
    }),
  ),
  position: Schema.Struct({
    current: Schema.NullOr(Schema.String),
    visited: Schema.Array(Schema.String),
  }),
  questions: Schema.Array(LearnSessionToolEvent),
  problem: Schema.NullOr(LearnSessionToolEvent),
  conclusionId: Schema.NullOr(Schema.String),
  problemDismissed: Schema.Boolean,
  planBlock: Schema.NullOr(
    Schema.Struct({
      planCallId: Schema.String,
      at: Schema.String,
      current: Schema.NullOr(Schema.String),
      nodes: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          status: Schema.Literals(["current", "visited", "upcoming"]),
        }),
      ),
      edges: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
    }),
  ),
  /** Open parked questions; absent from servers that predate them. */
  parked: Schema.optional(Schema.Array(LearnSessionToolEvent)),
});
export type LearnSessionState = typeof LearnSessionState.Type;
