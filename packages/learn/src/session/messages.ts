import * as Schema from "effect/Schema";
import { callId, finiteNumber } from "./contracts.ts";

export const QuestionKind = Schema.Literals(["quiz", "explain", "ask"]);
export type QuestionKind = typeof QuestionKind.Type;
export const AnswerVerdict = Schema.Literals([
  "correct",
  "incorrect",
  "dont-know",
  "ungraded",
  "pending-grade",
]);
export type AnswerVerdict = typeof AnswerVerdict.Type;
const selectedOptions = Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String }));
export const LearnerAnswer = Schema.Union([
  Schema.String,
  selectedOptions,
  Schema.Struct({ choices: selectedOptions, text: Schema.String }),
  Schema.Struct({ value: finiteNumber, unit: Schema.optional(Schema.String) }),
]);
export type LearnerAnswer = typeof LearnerAnswer.Type;
export const AnswerMessage = Schema.Struct({
  type: Schema.Literal("answer"),
  toolCallId: callId,
  kind: QuestionKind,
  answer: LearnerAnswer,
  verdict: AnswerVerdict,
  confidence: Schema.optional(finiteNumber.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  thinking: Schema.optional(Schema.String),
  thinkingWhileReading: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter((message) => {
    if (
      (message.verdict === "dont-know" || message.verdict === "ungraded") &&
      message.confidence !== undefined
    )
      return "dont-know and ungraded answers omit confidence";
    if (!["dont-know", "ungraded"].includes(message.verdict) && message.confidence === undefined)
      return "graded answers require confidence";
    if (message.kind === "ask")
      return message.verdict === "ungraded" || "ask answers must be ungraded";
    if (message.kind === "explain")
      return (
        ["pending-grade", "dont-know"].includes(message.verdict) ||
        "explain answers must be pending-grade or dont-know"
      );
    return (
      ["correct", "incorrect", "dont-know"].includes(message.verdict) ||
      "quiz answers must be correct, incorrect or dont-know"
    );
  }),
);
export type AnswerMessage = typeof AnswerMessage.Type;
export const LearnerSignal = Schema.Union([
  Schema.Struct({ type: Schema.Literal("thinking"), problemCallId: callId, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("next-problem") }),
  Schema.Struct({ type: Schema.Literal("dismissed"), problemCallId: callId }),
]);
export type LearnerSignal = typeof LearnerSignal.Type;
export const LearnerMessage = Schema.Union([
  AnswerMessage,
  LearnerSignal,
  Schema.Struct({ type: Schema.Literal("plain"), text: Schema.String }),
]);
export type LearnerMessage = typeof LearnerMessage.Type;
const decodeAnswer = Schema.decodeUnknownSync(AnswerMessage);
const decodeSignal = Schema.decodeUnknownSync(LearnerSignal);

/** JSON field values preserve newlines and header-like text without ambiguous continuation rules. */
export function formatAnswerMessage(input: AnswerMessage): string {
  const answer = decodeAnswer(input);
  const fields: [string, unknown][] = [
    ["kind", answer.kind],
    ["answer", answer.answer],
    ["verdict", answer.verdict],
    ["confidence", answer.confidence],
    ["thinking", answer.thinking],
    ["thinkingWhileReading", answer.thinkingWhileReading],
  ];
  return [
    `[answer ${answer.toolCallId}]`,
    ...fields
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
  ].join("\n");
}
export function formatLearnerSignal(input: LearnerSignal): string {
  const signal = decodeSignal(input);
  switch (signal.type) {
    case "thinking":
      return `[thinking ${signal.problemCallId}]\n${signal.text}`;
    case "next-problem":
      return "[next problem]";
    case "dismissed":
      return `[dismissed ${signal.problemCallId}]`;
  }
}
export function parseLearnerMessage(text: string): LearnerMessage {
  const plain: LearnerMessage = { type: "plain", text };
  if (text === "[next problem]") return { type: "next-problem" };
  const dismissed = text.match(/^\[dismissed ([^\s[\]]+)\]$/);
  if (dismissed?.[1]) return { type: "dismissed", problemCallId: dismissed[1] };
  const thinking = text.match(/^\[thinking ([^\s[\]]+)\]\r?\n([\s\S]*)$/);
  if (thinking?.[1] && thinking[2] !== undefined)
    return { type: "thinking", problemCallId: thinking[1], text: thinking[2] };
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.match(/^\[answer ([^\s[\]]+)\]$/);
  if (!header?.[1]) return plain;
  const fields: Record<string, unknown> = {};
  const keys = new Set([
    "kind",
    "answer",
    "verdict",
    "confidence",
    "thinking",
    "thinkingWhileReading",
  ]);
  try {
    for (const line of lines.slice(1)) {
      const match = line.match(/^([a-zA-Z]+): (.*)$/);
      if (
        !match?.[1] ||
        match[2] === undefined ||
        !keys.has(match[1]) ||
        Object.hasOwn(fields, match[1])
      )
        return plain;
      fields[match[1]] = JSON.parse(match[2]);
    }
    return decodeAnswer({ ...fields, type: "answer", toolCallId: header[1] });
  } catch {
    return plain;
  }
}
export function parseAnswerMessage(text: string): AnswerMessage | null {
  const parsed = parseLearnerMessage(text);
  return parsed.type === "answer" ? parsed : null;
}
