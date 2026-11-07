// Maps unanswered learn questions and practice problems onto T3's pending user-input request,
// so they render in the native question panel and answer through the composer.
import { RuntimeRequestId, type UserInputQuestion } from "@t3tools/contracts";
import { formatLearnerSignal } from "@t3tools/learn/session";
import type {
  ActiveProblem,
  PendingQuestion,
  SessionEvent,
  ReplayOptions,
} from "@t3tools/learn/session";
import { useLearnAnswerExtras } from "./answerExtras";
import {
  buildQuestionMessage,
  learnDockState,
  learnPhase,
  practiceMessage,
  questionIsMultiSelect,
  questionOptions,
  type PracticeAction,
  type SessionKind,
} from "./logic";

const REQUEST_PREFIX = "learn:";

/** The native panel's request shape, derived from the session instead of a provider request. */
export interface LearnPendingInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: readonly [UserInputQuestion & { readonly multiSelect: boolean }];
  readonly responseCapability: "message";
  readonly responseMode: "message";
  readonly dismissible: boolean;
}
export type LearnPending =
  | {
      readonly kind: "question";
      readonly input: LearnPendingInput;
      readonly question: PendingQuestion;
    }
  | { readonly kind: "problem"; readonly input: LearnPendingInput; readonly problem: ActiveProblem }
  | {
      readonly kind: "paused";
      readonly input: LearnPendingInput;
      readonly conclusionId: string;
    };

export interface LearnResponseExtras {
  readonly dontKnow?: boolean;
  /** Practice buttons next to the composer's own send ("work"). */
  readonly action?: Exclude<PracticeAction, "dismiss" | "work">;
}

export function isLearnRequestId(requestId: string): boolean {
  return requestId.startsWith(REQUEST_PREFIX);
}

function makeInput(
  id: string,
  at: string,
  question: Omit<UserInputQuestion, "id" | "multiSelect"> & { multiSelect?: boolean },
  dismissible: boolean,
): LearnPendingInput {
  return {
    requestId: RuntimeRequestId.make(`${REQUEST_PREFIX}${id}`),
    createdAt: at,
    questions: [{ ...question, id, multiSelect: question.multiSelect ?? false }],
    responseCapability: "message",
    responseMode: "message",
    dismissible,
  };
}

function questionHeader(question: PendingQuestion, probing: boolean): string {
  if (probing) return "Probe";
  if (question.name === "explain") return "Explain";
  if (question.name === "ask") return "Question";
  return question.input.type === "predict"
    ? "Predict"
    : question.input.type === "check"
      ? "Check"
      : "Quiz";
}

/** What the learner must answer next, or null when the composer is free. */
export function learnPendingInput(
  events: readonly SessionEvent[],
  kind: SessionKind,
  replay: ReplayOptions = {},
): LearnPending | null {
  const state = learnDockState(events, kind, replay);
  if (!state) return null;
  if (state.type === "question") {
    const { question } = state;
    const options = questionOptions(question);
    const numeric = question.name === "quiz" && question.input.answer.kind === "number";
    const text =
      question.name === "ask" && question.input.details
        ? `${question.input.question}\n\n${question.input.details}`
        : question.input.question;
    return {
      kind: "question",
      question,
      input: makeInput(
        question.id,
        question.at,
        {
          header: questionHeader(question, learnPhase(events, kind, replay) === "probe"),
          question: text,
          options: options.map((option) => ({
            label: option.label,
            value: option.value,
            description: typeof option.description === "string" ? option.description : "",
          })),
          multiSelect: questionIsMultiSelect(question),
          // Graded choice questions take no free text; numbers, recall and ask do.
          allowCustomAnswer: question.name !== "quiz" || numeric,
        },
        false,
      ),
    };
  }
  if (state.type === "problem") {
    if (state.dismissed) return null;
    return {
      kind: "problem",
      problem: state.problem,
      input: makeInput(
        state.problem.id,
        state.problem.at,
        { header: "Practice", question: state.problem.input.statement, options: [] },
        true,
      ),
    };
  }
  return {
    kind: "paused",
    conclusionId: state.id,
    input: makeInput(
      `paused:${state.id}`,
      "",
      {
        header: "Practice paused",
        question: "Ready for the next problem?",
        options: [{ label: "Next problem", value: "next", description: "" }],
        allowCustomAnswer: false,
      },
      false,
    ),
  };
}

/** "9.8 m/s²" → value and optional unit. */
export function parseNumberAnswer(text: string): { value: number; unit: string } | null {
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*?)\s*$/.exec(text);
  const value = match ? Number(match[1]) : Number.NaN;
  return match && Number.isFinite(value) ? { value, unit: match[2] ?? "" } : null;
}

function answerList(answer: unknown): string[] {
  return Array.isArray(answer)
    ? answer.filter((item): item is string => typeof item === "string")
    : typeof answer === "string"
      ? [answer]
      : [];
}

/** The tutor-facing message for the learner's panel answer. Throws on an unusable answer. */
export function learnResponseMessage(
  pending: LearnPending,
  answers: Record<string, unknown>,
  extras: LearnResponseExtras = {},
): string {
  if (pending.kind === "paused") return formatLearnerSignal({ type: "next-problem" });
  const id = pending.input.questions[0].id;
  const list = answerList(answers[id]);
  if (pending.kind === "problem") {
    const work = list.join("\n").trim();
    if (extras.action === undefined && !work) throw new Error("Write your work first.");
    return practiceMessage(pending.problem.id, extras.action ?? "work", work);
  }
  const { question } = pending;
  const notes = useLearnAnswerExtras.getState().get(question.id);
  // Confidence is only graded for quiz and explain.
  const graded = {
    confidence: notes.confidence,
    thinking: notes.thinking,
    thinkingWhileReading: notes.reading,
  };
  const dontKnow = extras.dontKnow === true;
  if (question.name === "ask") {
    if (!dontKnow && list.every((item) => item.trim() === ""))
      throw new Error("Answer the question first.");
    const labels = new Set((question.input.options ?? []).map((option) => option.label));
    const text = dontKnow
      ? "I don't know"
      : list
          .filter((item) => !labels.has(item))
          .join(" ")
          .trim() || undefined;
    return buildQuestionMessage(question, {
      values: dontKnow ? [] : list.filter((item) => labels.has(item)),
      text,
      thinking: notes.thinking,
      thinkingWhileReading: notes.reading,
    });
  }
  if (dontKnow) return buildQuestionMessage(question, { dontKnow, ...graded });
  if (question.name === "explain") {
    const text = list.join(" ").trim();
    if (!text) throw new Error("Write your answer first.");
    return buildQuestionMessage(question, { text, ...graded });
  }
  if (question.input.answer.kind === "number") {
    const parsed = parseNumberAnswer(list.join(" "));
    if (!parsed) throw new Error("Type a number, with its unit if it has one.");
    return buildQuestionMessage(question, {
      value: parsed.value,
      unit: parsed.unit || undefined,
      ...graded,
    });
  }
  return buildQuestionMessage(question, { values: list, ...graded });
}

/** The tutor learns that the learner stepped away from the active problem. */
export function learnDismissMessage(pending: LearnPending): string | null {
  return pending.kind === "problem" ? practiceMessage(pending.problem.id, "dismiss", "") : null;
}

/** Simulation to open once the graded answer is in. */
export function learnSimulationAfterAnswer(pending: LearnPending): string | undefined {
  return pending.kind === "question" && pending.question.name === "quiz"
    ? pending.question.input.simPath
    : undefined;
}
