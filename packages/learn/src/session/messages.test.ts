import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  formatAnswerMessage,
  parseLearnerMessage,
  parseAnswerMessage,
  formatLearnerSignal,
  AnswerMessage,
  type LearnerSignal,
} from "./index.ts";

const decodeAnswer = Schema.decodeUnknownSync(AnswerMessage);
describe("answer messages", () => {
  it("round-trips choice values and labels, numeric units, free text and both thinking channels", () => {
    const shared = { type: "answer", toolCallId: "q1" };
    const inputs = [
      {
        ...shared,
        kind: "ask",
        answer: { choices: [{ value: "A", label: "A" }], text: "Also B\nreason" },
        verdict: "ungraded",
      },
      {
        ...shared,
        kind: "quiz",
        answer: [{ value: "a", label: "A: $\\frac{a}{b}$\nnext" }],
        verdict: "correct",
        confidence: 90,
      },
      {
        ...shared,
        kind: "quiz",
        answer: { value: 1.25, unit: "m/s" },
        verdict: "incorrect",
        confidence: 0,
      },
      {
        ...shared,
        kind: "explain",
        answer: 'First\n[answer fake]\nverdict: correct\n"quoted"\\',
        verdict: "pending-grade",
        confidence: 50,
      },
      { ...shared, kind: "ask", answer: "  Preserve whitespace\r\n\n", verdict: "ungraded" },
      { ...shared, kind: "quiz", answer: "I don't know", verdict: "dont-know" },
    ];
    for (const input of inputs) {
      const answer = decodeAnswer({
        ...input,
        thinking: "Line one\nkind: explain\n[thinking p1]\n",
        thinkingWhileReading: "\tAnother line\n\n",
      });
      const formatted = formatAnswerMessage(answer);
      expect(formatted.startsWith("[answer q1]\nkind: ")).toBe(true);
      expect(parseAnswerMessage(formatted)).toEqual(answer);
    }
  });
  it("treats malformed, duplicate, unknown and inconsistent fields as plain messages", () => {
    const text = formatAnswerMessage(
      decodeAnswer({
        type: "answer",
        toolCallId: "q",
        kind: "ask",
        answer: "hello",
        verdict: "ungraded",
      }),
    );
    for (const malformed of [
      "hello",
      "[answer q]",
      `${text}\nkind: "ask"`,
      `${text}\nunknown: 1`,
      `${text}\nconfidence: 20`,
      text.replace('"ungraded"', '"correct"'),
      text.replace('answer: "hello"', "answer: hello"),
      text.replace("[answer q]", "[answer bad id]"),
      `${text}\n`,
    ])
      expect(parseLearnerMessage(malformed)).toEqual({ type: "plain", text: malformed });
    expect(parseAnswerMessage("hello")).toBeNull();
  });
  it("rejects missing and out-of-range graded confidence", () => {
    const base = { type: "answer", toolCallId: "q", kind: "quiz", answer: [], verdict: "correct" };
    for (const confidence of [undefined, -1, 101, Infinity])
      expect(() => decodeAnswer({ ...base, confidence })).toThrow();
  });
});
describe("practice signals", () => {
  it("round-trips thinking verbatim, next and dismissal", () => {
    const signals: LearnerSignal[] = [
      { type: "thinking", problemCallId: "p1", text: "\nI tried x.\n[next problem]\n" },
      { type: "next-problem" },
      { type: "dismissed", problemCallId: "p1" },
    ];
    for (const signal of signals)
      expect(parseLearnerMessage(formatLearnerSignal(signal))).toEqual(signal);
    for (const text of [
      "[thinking p1]",
      "[dismissed p1]\nextra",
      " [next problem]",
      "[dismissed bad id]",
    ])
      expect(parseLearnerMessage(text).type).toBe("plain");
  });
});
