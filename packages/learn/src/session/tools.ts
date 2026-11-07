import { callId } from "./contracts.ts";
// Ported from learnharness (AGPL-3.0-only) src/core/question-core.ts, src/agent/tools.ts, src/agent/tools/practice.ts, src/agent/tools/probe.ts @ c549494.
import * as Schema from "effect/Schema";
import { nonEmptyText, finiteNumber, ProbeAssessment } from "./contracts.ts";
import { parseMermaidPlan } from "./plan.ts";

export const QuizOption = Schema.Struct({ label: nonEmptyText, value: nonEmptyText });
export type QuizOption = typeof QuizOption.Type;
export const AskOption = Schema.Struct({
  label: nonEmptyText,
  description: Schema.optional(Schema.String),
});
export const QuestionType = Schema.Literals(["predict", "check"]);
const graphTarget = Schema.optional(Schema.Array(nonEmptyText).check(Schema.isMinLength(1)));
const position = {
  type: Schema.optional(QuestionType),
  nodeId: Schema.optional(nonEmptyText),
  target: graphTarget.annotate({
    description: "Graph ids of the propositions this question retrieves; omit for new material.",
  }),
};
export const askInputObject = Schema.Struct({
  question: nonEmptyText,
  details: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(AskOption).check(Schema.isMinLength(2))),
  multiSelect: Schema.optional(Schema.Boolean),
});
export type AskInput = typeof askInputObject.Type;
function askOptionProblems(options: readonly { readonly label: string }[]): string[] {
  const seen = new Set<string>();
  return options.flatMap(({ label }, i) => {
    const key = label.trim();
    if (!key) return [`options[${i}].label must not be empty.`];
    if (seen.has(key)) return [`Duplicate option label "${key}"; options must be distinct.`];
    seen.add(key);
    return [];
  });
}
export const askInputSchema = askInputObject.check(
  Schema.makeFilter((input) => {
    const problems = askOptionProblems(input.options ?? []);
    if (input.multiSelect && !input.options) problems.push("multiSelect requires options.");
    return problems.length ? problems.join("\n") : true;
  }),
);
export const quizInputObject = Schema.Struct({
  ...position,
  question: nonEmptyText,
  answer: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("choice"),
      options: Schema.Array(QuizOption).check(Schema.isMinLength(2), Schema.isMaxLength(8)),
      multiSelect: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({
      kind: Schema.Literal("number"),
      unit: Schema.optional(nonEmptyText),
      tolerance: Schema.optional(finiteNumber.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ]).annotate({
    description:
      "Answer form: choice options with stable values, or a number with optional unit and relative tolerance (default 0.05).",
  }),
  explanation: nonEmptyText.annotate({
    description: "Reasoning revealed after answering. Write this before correctAnswer.",
  }),
  correctAnswer: Schema.Union([Schema.String, Schema.Array(Schema.String), finiteNumber]).annotate({
    description: "Committed option value(s), or the numeric answer. Must match the answer form.",
  }),
  simPath: Schema.optional(
    Schema.String.check(Schema.isPattern(/^sims\/[a-z0-9]+(?:[-_][a-z0-9]+)*\.sim\.js$/)),
  ),
});
export type QuizInput = typeof quizInputObject.Type;

export function coerceCorrectAnswer(
  answer: string | readonly string[],
  keys: readonly string[],
): string[] {
  const clean = (value: string) =>
    keys.includes(value.trim())
      ? value.trim()
      : value.replace(/^[\s:."'`]+/, "").replace(/[\s:."'`]+$/, "");
  if (typeof answer !== "string") return answer.map(clean);
  if (keys.includes(answer.trim())) return [answer.trim()];
  try {
    const decoded: unknown = JSON.parse(answer);
    if (Array.isArray(decoded) && decoded.every((item): item is string => typeof item === "string"))
      return decoded.map(clean);
  } catch {
    /* A literal option value need not be JSON. */
  }
  return [clean(answer)];
}
function quizInputProblems(input: QuizInput): string[] {
  if (input.answer.kind === "number")
    return typeof input.correctAnswer === "number"
      ? []
      : ["A number answer requires a numeric correctAnswer."];
  const problems: string[] = [];
  const keys = input.answer.options.map((option) => option.value.trim());
  if (new Set(keys).size !== keys.length)
    problems.push("Option values must be distinct after trimming.");
  if (typeof input.correctAnswer === "number")
    return [...problems, "A choice answer requires option value(s), not a number."];
  const correct = [...new Set(coerceCorrectAnswer(input.correctAnswer, keys))];
  if (!correct.length || correct.some((value) => !value))
    problems.push("correctAnswer must contain at least one option value.");
  for (const value of correct)
    if (!keys.includes(value))
      problems.push(
        `correctAnswer "${value}" does not match an option value; copy an exact value.`,
      );
  if (correct.length > 1 && !input.answer.multiSelect)
    problems.push("Multiple correct answers require multiSelect: true.");
  return problems;
}
export const quizInputSchema = quizInputObject.check(
  Schema.makeFilter((input) => quizInputProblems(input).join("\n") || true),
);
export const explainInputObject = Schema.Struct({
  ...position,
  question: nonEmptyText,
  correctAnswer: nonEmptyText,
});
export const explainInputSchema = explainInputObject;
export type ExplainInput = typeof explainInputSchema.Type;
export const probeDoneInputSchema = Schema.Struct({ assessment: ProbeAssessment });
export type ProbeDoneInput = typeof probeDoneInputSchema.Type;
export const planInitInputObject = Schema.Struct({ mermaid: nonEmptyText });
export const planInitInputSchema = planInitInputObject.check(
  Schema.makeFilter(({ mermaid }) => {
    const parsed = parseMermaidPlan(mermaid);
    return parsed.ok || parsed.problems.join("\n");
  }),
);
export const problemInputObject = Schema.Struct({
  statement: nonEmptyText,
  mode: Schema.Literals(["recall", "discrimination", "composition"]),
  target: graphTarget,
  modelSolution: nonEmptyText,
});
export const problemInputSchema = problemInputObject;
export type ProblemInput = typeof problemInputSchema.Type;
export const concludeInputObject = Schema.Struct({
  outcome: Schema.Literals(["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"]),
  verdict: nonEmptyText,
  rung: Schema.NullOr(Schema.Literals(["R0", "R1", "R2", "R3", "R4", "R5"])),
  missClass: Schema.NullOr(
    Schema.Literals(["cue", "discrimination", "execution", "careless", "structural"]),
  ),
  retest: Schema.Boolean,
});
export const concludeInputSchema = concludeInputObject;
export type ConcludeInput = typeof concludeInputSchema.Type;

export const answerVerdictInputSchema = Schema.Struct({
  questionId: callId,
  verdict: Schema.Literals(["correct", "incorrect"]),
  reason: nonEmptyText,
});

/** The nodeId a park_question call uses for a question answered once the plan is done. */
export const PARKED_AFTER_PLAN = "after-plan";
export const parkQuestionInputSchema = Schema.Struct({
  question: nonEmptyText.annotate({ description: "The learner's question, in their words." }),
  nodeId: nonEmptyText.annotate({
    description: `The plan node id whose step answers it, or "${PARKED_AFTER_PLAN}".`,
  }),
  preview: Schema.optional(nonEmptyText).annotate({
    description:
      "The one-to-two-sentence preview given now, if any: what the answer turns on, without the later step's content.",
  }),
});
export type ParkQuestionInput = typeof parkQuestionInputSchema.Type;
export const answerParkedInputSchema = Schema.Struct({ id: callId });

export const sessionToolSchemas = {
  grade_answer: answerVerdictInputSchema,
  correct_verdict: answerVerdictInputSchema,
  ask: askInputSchema,
  quiz: quizInputSchema,
  explain: explainInputSchema,
  probe_done: probeDoneInputSchema,
  plan_init: planInitInputSchema,
  problem: problemInputSchema,
  conclude: concludeInputSchema,
  park_question: parkQuestionInputSchema,
  answer_parked: answerParkedInputSchema,
};
export type SessionToolName = keyof typeof sessionToolSchemas;
/** Tools that pose something for the learner to answer; an accepted call ends the tutor's turn. */
export const questionToolNames: ReadonlySet<string> = new Set<SessionToolName>([
  "ask",
  "quiz",
  "explain",
  "problem",
]);
export const SessionToolCall = Schema.Union([
  Schema.Struct({ name: Schema.Literal("grade_answer"), input: answerVerdictInputSchema }),
  Schema.Struct({ name: Schema.Literal("correct_verdict"), input: answerVerdictInputSchema }),
  Schema.Struct({ name: Schema.Literal("ask"), input: askInputSchema }),
  Schema.Struct({ name: Schema.Literal("quiz"), input: quizInputSchema }),
  Schema.Struct({ name: Schema.Literal("explain"), input: explainInputSchema }),
  Schema.Struct({ name: Schema.Literal("probe_done"), input: probeDoneInputSchema }),
  Schema.Struct({ name: Schema.Literal("plan_init"), input: planInitInputSchema }),
  Schema.Struct({ name: Schema.Literal("problem"), input: problemInputSchema }),
  Schema.Struct({ name: Schema.Literal("conclude"), input: concludeInputSchema }),
  Schema.Struct({ name: Schema.Literal("park_question"), input: parkQuestionInputSchema }),
  Schema.Struct({ name: Schema.Literal("answer_parked"), input: answerParkedInputSchema }),
]);
export type SessionToolCall = typeof SessionToolCall.Type;

export function parseOptionsIfString(options: unknown): unknown {
  if (typeof options !== "string") return options;
  try {
    const parsed: unknown = JSON.parse(options);
    return Array.isArray(parsed) ? parsed : options;
  } catch {
    return options;
  }
}
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function parseEncoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
/** Heal only machine fields; question text and commitments stay verbatim. */
export function prepareToolInput(name: string, raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (name === "ask" && raw.options !== undefined)
    return { ...raw, options: parseOptionsIfString(raw.options) };
  if (name === "quiz" || name === "explain" || name === "problem") {
    const target = parseOptionsIfString(raw.target);
    const { target: _target, ...rest } = raw;
    const healed = {
      ...rest,
      ...(target === undefined || (Array.isArray(target) && target.length === 0) ? {} : { target }),
    };
    if (name === "problem") return { ...healed, mode: parseEncoded(raw.mode) };
    const answer = parseEncoded(raw.answer);
    if (name === "quiz" && isRecord(answer) && answer.options !== undefined)
      return { ...healed, answer: { ...answer, options: parseOptionsIfString(answer.options) } };
    return name === "quiz" && answer !== raw.answer ? { ...healed, answer } : healed;
  }
  if (name === "conclude")
    return {
      ...raw,
      outcome: parseEncoded(raw.outcome),
      rung: parseEncoded(raw.rung),
      missClass: parseEncoded(raw.missClass),
      retest: parseEncoded(raw.retest),
    };
  return raw;
}
const decodeCall = Schema.decodeUnknownSync(SessionToolCall);
export type ToolInputResult =
  | { readonly ok: true; readonly call: SessionToolCall; readonly problems: [] }
  | { readonly ok: false; readonly problems: string[] };
export function validateToolInput(name: string, input: unknown): ToolInputResult {
  try {
    return {
      ok: true,
      call: decodeCall({ name, input: prepareToolInput(name, input) }),
      problems: [],
    };
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  }
}

/** The stop rule every question tool states where the model reads it, at call time. */
const ENDS_TURN = " This call ends your turn, so make it last.";
function example(name: string, input: unknown): string {
  return `\nExample: ${name}(${JSON.stringify(input)})`;
}
const quizExampleBody = {
  question: "A signal is $y=\\sin(2x)$ and $\\frac{dx}{dt}=3$. What is $\\frac{dy}{dt}$?",
  answer: {
    kind: "choice",
    options: [
      { label: "$6\\cos(2x)$", value: "a" },
      { label: "$2\\cos(2x)$", value: "b" },
    ],
  },
  explanation: "Apply the chain rule:\n$$\\frac{dy}{dt}=\\cos(2x)\\cdot2\\cdot3=6\\cos(2x).$$",
  correctAnswer: "a",
};
const askDescription =
  "Ask one ungraded question. Options have labels and optional descriptions; the learner can always write freely." +
  ENDS_TURN +
  example("ask", {
    question: "What do you want to measure?",
    options: [{ label: "Period" }, { label: "Amplitude" }],
  });
const quizDescription =
  "Pose one graded choice or number question. Choice takes 2–8 {label,value} options and optional multiSelect; number takes optional unit and relative tolerance (default 0.05). The dock grades, accepts I don't know, and opens simPath on answer. In teach, type and nodeId are required; in probe, omit both. Inside JSON, escape LaTeX backslashes and newlines." +
  ENDS_TURN +
  example("quiz", quizExampleBody);
const explainDescription =
  "Pose one free-recall question with the full correctAnswer and reasoning committed in advance. The answer arrives with verdict pending-grade; call grade_answer before feedback. In teach, type and nodeId are required; in probe, omit both." +
  ENDS_TURN +
  example("explain", {
    question: "Why does $T$ increase with $L$?",
    correctAnswer: "$T=2\\pi\\sqrt{L/g}$, so increasing $L$ increases $T$.",
  });
const probeDoneDescription =
  "Record the strand assessment and change phase from probe to plan. Refused with an unanswered question or after the first successful call. End the turn after it succeeds." +
  example("probe_done", {
    assessment: {
      strands: [
        {
          strand: "Period",
          assessment: "Floor: measures a cycle. Ceiling: cannot derive the period.",
        },
      ],
    },
  });
const planInitDescription =
  "Write or replace the plan using a mermaid graph. Use permanent lowercase slug ids, single-line labels, and prerequisite --> dependent edges. Chains, ==> and -.-> are supported; subgraphs and styles are not. Cycles are refused. Available after probe_done; re-calls replace the map." +
  example("plan_init", { mermaid: "graph TD\nforce[Restoring force] --> period[Period]" });
const problemDescription =
  "Pose one practice problem with a committed modelSolution, hidden until conclude. Refused while a problem is active." +
  ENDS_TURN +
  example("problem", {
    statement: "Find the period for L=1 m and g=9.81 m/s².",
    mode: "recall",
    modelSolution: "T=2π√(L/g)≈2.01 s.",
  });
const concludeDescription =
  "Conclude the active practice problem, record its outcome and reveal the committed modelSolution. Use dismissed for the learner's dismissal signal. Refused without an active problem. End the turn; the next problem waits for the learner." +
  example("conclude", {
    outcome: "solved",
    verdict: "Used the period relation correctly.",
    rung: null,
    missClass: null,
    retest: false,
  });
/** The text a successful session tool call returns to the tutor. */
export function sessionToolResultMessage(name: SessionToolName, id: string) {
  if (name === "grade_answer" || name === "correct_verdict")
    return `Verdict recorded. Give brief feedback and end your turn.`;
  if (name === "park_question")
    return `Parked as ${id} until its step. Say which step it returns at, then end your turn.`;
  if (name === "answer_parked") return "Marked answered.";
  return questionToolNames.has(name)
    ? `id: ${id}\nPosed. End your turn now. The answer arrives as the next message, starting with [answer ${id}].`
    : name === "probe_done"
      ? "Probe recorded. Phase: plan. End your turn."
      : name === "plan_init"
        ? "Plan recorded. Wait for the learner's confirmation before teaching."
        : "Problem concluded. The committed solution is revealed. End your turn; wait for the learner.";
}
export const sessionToolDescriptions = {
  grade_answer:
    "Persist the verdict on an answered explain question, with a brief reason against the committed answer, before feedback. Refused without a pending grade." +
    example("grade_answer", {
      questionId: "question-id",
      verdict: "correct",
      reason: "Both forces scale with mass.",
    }),
  correct_verdict:
    "Correct an acknowledged wrong verdict on an answered quiz or explain question, with its specific reason. This fixes the displayed grade, calibration and review schedule without another attempt." +
    example("correct_verdict", {
      questionId: "question-id",
      verdict: "incorrect",
      reason: "The length is squared in the learner's expression.",
    }),
  ask: askDescription,
  quiz: quizDescription,
  explain: explainDescription,
  probe_done: probeDoneDescription,
  plan_init: planInitDescription,
  problem: problemDescription,
  conclude: concludeDescription,
  park_question:
    `Save a learner question for the plan step that answers it, or "${PARKED_AFTER_PLAN}" for one outside the plan. learn_session lists it and marks it due at its step. Teach sessions with a plan only.` +
    example("park_question", {
      question: "Why does a wide swing run slow?",
      nodeId: "large-angle",
      preview: "It turns on how far the pull back falls short of the small-swing case.",
    }),
  answer_parked:
    "Mark the parked question you answer in this turn as answered, by the id learn_session lists. Call it before the turn's question." +
    example("answer_parked", { id: "parked-id" }),
};
