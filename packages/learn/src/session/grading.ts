// Ported from learnharness (AGPL-3.0-only) src/core/question-core.ts @ c549494.
import * as Schema from "effect/Schema";
import { finiteNumber } from "./contracts.ts";
import { AnswerMessage, type AnswerVerdict } from "./messages.ts";
import {
  coerceCorrectAnswer,
  quizInputSchema,
  explainInputSchema,
  askInputSchema,
  type QuizInput,
  type ExplainInput,
  type AskInput,
} from "./tools.ts";

export const AnswerRequest = Schema.Struct({
  dontKnow: Schema.optional(Schema.Boolean),
  values: Schema.optional(Schema.Array(Schema.String)),
  value: Schema.optional(finiteNumber),
  unit: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  confidence: Schema.optional(finiteNumber),
  thinking: Schema.optional(Schema.String),
  thinkingWhileReading: Schema.optional(Schema.String),
});
export type AnswerRequest = typeof AnswerRequest.Type;
const decodeRequest = Schema.decodeUnknownSync(AnswerRequest);
const decodeAnswer = Schema.decodeUnknownSync(AnswerMessage);
const decodeQuiz = Schema.decodeUnknownSync(quizInputSchema);
const decodeExplain = Schema.decodeUnknownSync(explainInputSchema);
const decodeAsk = Schema.decodeUnknownSync(askInputSchema);

function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Always key the shuffle by tool-call id, including after a reload. */
export function shuffleOptions<T>(options: readonly T[], toolCallId: string): T[] {
  const random = seededRandom(toolCallId);
  const out = [...options];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const value = out[i]!;
    out[i] = out[j]!;
    out[j] = value;
  }
  return out;
}
export function isCorrect(selected: readonly string[], correct: readonly string[]): boolean {
  const expected = new Set(correct);
  return (
    selected.length === new Set(selected).size &&
    selected.length === expected.size &&
    selected.every((value) => expected.has(value))
  );
}
export function gradeChoice(input: QuizInput, values: readonly string[]): AnswerVerdict {
  const quiz = decodeQuiz(input);
  if (quiz.answer.kind !== "choice" || typeof quiz.correctAnswer === "number")
    throw new Error("gradeChoice requires a choice quiz.");
  const keys = quiz.answer.options.map((option) => option.value.trim());
  const correct = coerceCorrectAnswer(quiz.correctAnswer, keys);
  return isCorrect(
    values.map((value) => value.trim()),
    correct,
  )
    ? "correct"
    : "incorrect";
}
const normalizedUnit = (unit: string | undefined) => (unit ?? "").trim().replace(/\s+/g, " ");
export function gradeNumber(input: QuizInput, value: number, unit?: string): AnswerVerdict {
  const quiz = decodeQuiz(input);
  if (quiz.answer.kind !== "number" || typeof quiz.correctAnswer !== "number")
    throw new Error("gradeNumber requires a number quiz.");
  if (!Number.isFinite(value) || normalizedUnit(unit) !== normalizedUnit(quiz.answer.unit))
    return "incorrect";
  const tolerance = quiz.answer.tolerance ?? 0.05;
  if (tolerance === 0) return value === quiz.correctAnswer ? "correct" : "incorrect";
  const error = Math.abs(value - quiz.correctAnswer);
  const allowed = Math.abs(quiz.correctAnswer) * tolerance;
  // Account for floating-point error at the inclusive tolerance boundary. Zero remains exact.
  const roundoff =
    quiz.correctAnswer === 0
      ? 0
      : Number.EPSILON * Math.max(Math.abs(value), Math.abs(quiz.correctAnswer)) * 4;
  return error <= allowed + roundoff ? "correct" : "incorrect";
}

export type AnswerableQuestion =
  | { readonly kind: "quiz"; readonly input: QuizInput }
  | { readonly kind: "explain"; readonly input: ExplainInput }
  | { readonly kind: "ask"; readonly input: AskInput };
export function buildAnswer(
  toolCallId: string,
  question: AnswerableQuestion,
  request: AnswerRequest,
): AnswerMessage {
  const req = decodeRequest(request);
  const notes = { thinking: req.thinking, thinkingWhileReading: req.thinkingWhileReading };
  const base = { type: "answer", toolCallId, kind: question.kind, ...notes };
  const confidence = Math.max(0, Math.min(100, Math.round(req.confidence ?? 50)));
  if (question.kind === "ask") {
    const ask = decodeAsk(question.input);
    const selected = (ask.options ?? [])
      .filter((option) => req.values?.includes(option.label))
      .map(({ label }) => ({ value: label, label }));
    const answer =
      req.text === undefined
        ? selected
        : selected.length
          ? { choices: selected, text: req.text }
          : req.text;
    return decodeAnswer({ ...base, verdict: "ungraded", answer });
  }
  if (question.kind === "quiz") decodeQuiz(question.input);
  else decodeExplain(question.input);
  if (req.dontKnow) return decodeAnswer({ ...base, verdict: "dont-know", answer: "I don't know" });
  if (question.kind === "explain") {
    return decodeAnswer({ ...base, verdict: "pending-grade", answer: req.text ?? "", confidence });
  }
  // Narrow the quiz separately: the commitment above is validated even for I-don't-know.
  const quiz = decodeQuiz(question.input);
  if (quiz.answer.kind === "number") {
    if (req.value === undefined) throw new Error("A numeric answer requires value.");
    return decodeAnswer({
      ...base,
      answer: { value: req.value, unit: req.unit },
      verdict: gradeNumber(quiz, req.value, req.unit),
      confidence,
    });
  }
  const values = (req.values ?? []).map((value) => value.trim());
  const options = quiz.answer.options.map((option) => ({
    label: option.label,
    value: option.value.trim(),
  }));
  if (values.some((value) => !options.some((option) => option.value === value)))
    throw new Error("Answer contains an unknown option value.");
  if (values.length !== new Set(values).size || (!quiz.answer.multiSelect && values.length > 1))
    throw new Error("Answer contains an invalid selection.");
  return decodeAnswer({
    ...base,
    answer: options.filter((option) => values.includes(option.value)),
    verdict: gradeChoice(quiz, values),
    confidence,
  });
}
