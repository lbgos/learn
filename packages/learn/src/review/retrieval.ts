import type { SessionEvent } from "../session/contracts.ts";
import { applySessionEvent, deriveSession, type ReplayOptions } from "../session/state.ts";
import { validateToolInput, type ConcludeInput } from "../session/tools.ts";

export type RetrievalOutcome =
  | Exclude<ConcludeInput["outcome"], "dismissed">
  | "correct"
  | "incorrect"
  | "dont-know";

/** One attempt to bring a graph proposition to mind, from a concluded problem or a graded answer. */
export interface RetrievalEvent {
  readonly nodeId: string;
  readonly at: string;
  readonly outcome: RetrievalOutcome;
  readonly rung: ConcludeInput["rung"];
  readonly missClass: ConcludeInput["missClass"];
  /** Learner's 0-100 confidence; graded answers carry it, practice problems do not. */
  readonly confidence: number | null;
}
export interface GradedAnswer {
  readonly at: string;
  readonly confidence: number;
  readonly correct: boolean;
}
export interface LearnerRecord {
  readonly retrievals: readonly RetrievalEvent[];
  /** Every quiz answer graded right or wrong, for calibration. */
  readonly answers: readonly GradedAnswer[];
}

/** Replays one session through its gate, so only calls and answers the session accepted count. */
export function learnerRecord(
  events: readonly SessionEvent[],
  options: ReplayOptions = {},
): LearnerRecord {
  const retrievals: RetrievalEvent[] = [];
  const answers: GradedAnswer[] = [];
  const final = deriveSession(events, options);
  let gate = deriveSession([], options);
  for (const event of events) {
    const next = applySessionEvent(gate, event).gate;
    // The gate drops a question from pending only when its answer is accepted.
    for (const [id, question] of event.type === "learner-message" ? gate.questions : []) {
      const answer =
        next.questions.has(id) || !next.answers.has(id) ? undefined : final.answers.get(id);
      if (!answer || question.name === "ask") continue;
      if (
        answer.confidence !== undefined &&
        (answer.verdict === "correct" || answer.verdict === "incorrect")
      )
        answers.push({
          at: event.at,
          confidence: answer.confidence,
          correct: answer.verdict === "correct",
        });
      // Predictions precede teaching and do not count as retrievals.
      const outcome =
        answer.verdict === "correct" ||
        answer.verdict === "incorrect" ||
        answer.verdict === "dont-know"
          ? answer.verdict
          : null;
      if (outcome && question.input.type !== "predict")
        for (const nodeId of new Set(question.input.target ?? []))
          retrievals.push({
            nodeId,
            at: event.at,
            outcome,
            rung: null,
            missClass: null,
            confidence: answer.confidence ?? null,
          });
    }
    if (
      event.type === "tool-call" &&
      event.name === "conclude" &&
      gate.problem &&
      !gate.acceptedCallIds.has(event.id) &&
      next.acceptedCallIds.has(event.id)
    ) {
      const parsed = validateToolInput("conclude", event.input);
      if (parsed.ok && parsed.call.name === "conclude") {
        const { outcome, rung, missClass } = parsed.call.input;
        if (outcome !== "dismissed")
          for (const nodeId of new Set(gate.problem.input.target ?? []))
            retrievals.push({ nodeId, at: event.at, outcome, rung, missClass, confidence: null });
      }
    }
    gate = next;
  }
  return { retrievals, answers };
}
