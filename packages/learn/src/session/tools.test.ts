// Ported from learnharness (AGPL-3.0-only) tests/question-core.test.ts, tests/question-tools.test.ts, tests/practice-heal.test.ts @ c549494.
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  askInputSchema,
  quizInputSchema,
  quizInputObject,
  validateToolInput,
  parseOptionsIfString,
  sessionToolDescriptions,
  sessionToolSchemas,
  LearnSessionMeta,
  SessionEvent,
  coerceCorrectAnswer,
} from "./index.ts";
import { quiz, numberQuiz, problem, conclusion, assessment } from "./fixtures.test-utils.ts";

const valid = (name: string, input: unknown) => validateToolInput(name, input).ok;
const decodeMeta = Schema.decodeUnknownSync(LearnSessionMeta);
const decodeTypedMeta = Schema.decodeSync(LearnSessionMeta);
const decodeEvent = Schema.decodeUnknownSync(SessionEvent);
describe("question contracts", () => {
  it("requires a nonblank commitment, explanation, question and option labels", () => {
    for (const field of ["question", "explanation", "correctAnswer"])
      expect(valid("quiz", { ...quiz, [field]: " " })).toBe(false);
    expect(
      valid("quiz", {
        ...quiz,
        answer: {
          kind: "choice",
          options: [
            { label: " ", value: "4" },
            { label: "Five", value: "5" },
          ],
        },
      }),
    ).toBe(false);
    expect(valid("explain", { question: "Why?", correctAnswer: " " })).toBe(false);
    expect(valid("explain", { question: "Why?", correctAnswer: "Because..." })).toBe(true);
  });
  it("rejects ungradeable choice commitments in the exported MCP schema too", () => {
    const decode = Schema.decodeUnknownSync(quizInputSchema);
    expect(() => decode({ ...quiz, correctAnswer: "missing" })).toThrow();
    expect(valid("quiz", { ...quiz, correctAnswer: [] })).toBe(false);
    expect(valid("quiz", { ...quiz, correctAnswer: ["4", "5"] })).toBe(false);
    expect(
      valid("quiz", {
        ...quiz,
        answer: { ...quiz.answer, multiSelect: true },
        correctAnswer: ["4", "5"],
      }),
    ).toBe(true);
    expect(valid("quiz", { ...quiz, correctAnswer: 4 })).toBe(false);
  });
  it("requires 2–8 options with distinct, explicit values", () => {
    for (const count of [0, 1, 9])
      expect(
        valid("quiz", {
          ...quiz,
          answer: {
            kind: "choice",
            options: Array.from({ length: count }, (_, i) => ({ label: `${i}`, value: `${i}` })),
          },
          correctAnswer: "0",
        }),
      ).toBe(false);
    expect(
      valid("quiz", {
        ...quiz,
        answer: {
          kind: "choice",
          options: [
            { label: "A", value: "4" },
            { label: "B", value: " 4 " },
          ],
        },
      }),
    ).toBe(false);
    expect(
      valid("quiz", {
        ...quiz,
        answer: { kind: "choice", options: [{ label: "Four" }, { label: "Five" }] },
      }),
    ).toBe(false);
  });
  it("preserves exact punctuation-bearing answer keys before healing copy syntax", () => {
    expect(coerceCorrectAnswer("point.", ["point."])).toEqual(["point."]);
    expect(coerceCorrectAnswer('["x"]', ['["x"]'])).toEqual(['["x"]']);
    expect(coerceCorrectAnswer('[":four"]', ["four"])).toEqual(["four"]);
    expect(valid("quiz", { ...quiz, correctAnswer: ':"4"' })).toBe(true);
  });
  it("heals encoded option arrays at the boundary without healing free text", () => {
    const options = [
      { label: "Four", value: "4" },
      { label: "Five", value: "5" },
    ];
    const input = { ...quiz, answer: { kind: "choice", options: JSON.stringify(options) } };
    expect(valid("quiz", input)).toBe(true);
    expect(valid("quiz", { ...quiz, answer: JSON.stringify({ kind: "choice", options }) })).toBe(
      true,
    );
    expect(valid("ask", { question: "Pick", options: '[{"label":"A"},{"label":"B"}]' })).toBe(true);
    expect(parseOptionsIfString("broken")).toBe("broken");
    expect(parseOptionsIfString('{"a":1}')).toBe('{"a":1}');
    expect(input.answer.options).toBe(JSON.stringify(options));
  });
  it("validates ask's ungraded options and allows free-form questions", () => {
    const decode = Schema.decodeUnknownSync(askInputSchema);
    expect(() =>
      decode({ question: "Pick", options: [{ label: "same" }, { label: " same " }] }),
    ).toThrow();
    expect(
      valid("ask", {
        question: "Pick",
        options: [{ label: "A", description: "First" }, { label: "B" }],
      }),
    ).toBe(true);
    expect(valid("ask", { question: "What next?" })).toBe(true);
    expect(valid("ask", { question: "What next?", multiSelect: true })).toBe(false);
  });
  it("validates numeric commitments, nonnegative tolerances, finite numbers and sim paths", () => {
    expect(valid("quiz", numberQuiz)).toBe(true);
    for (const correctAnswer of [NaN, Infinity, "10", ["10"]])
      expect(valid("quiz", { ...numberQuiz, correctAnswer })).toBe(false);
    expect(valid("quiz", { ...numberQuiz, answer: { kind: "number", tolerance: -1 } })).toBe(false);
    expect(valid("quiz", { ...numberQuiz, simPath: "sims/pendulum-2.sim.js" })).toBe(true);
    for (const simPath of ["../sims/a.sim.js", "sims/../a.sim.js", "/sims/a.sim.js", "sims/a.js"])
      expect(valid("quiz", { ...numberQuiz, simPath })).toBe(false);
  });
  it("keeps explanation before correctAnswer in schema property order", () => {
    const fields = Object.keys(quizInputObject.fields);
    expect(fields.indexOf("explanation")).toBeLessThan(fields.indexOf("correctAnswer"));
    expect(fields.slice(0, 4)).toEqual(["type", "nodeId", "target", "question"]);
  });
  it("validates all boundary event and metadata shapes", () => {
    expect(
      decodeTypedMeta({
        kind: "teach",
        mechanic: "recall",
        createdAt: "today",
        graphContext: { nodeIds: ["a"] },
      }).mechanic,
    ).toBe("recall");
    expect(() => decodeMeta({ kind: "other", mechanic: "recall", createdAt: "today" })).toThrow();
    expect(() =>
      decodeEvent({
        type: "tool-call",
        id: "bad id",
        name: "ask",
        at: "today",
        input: {},
      }),
    ).toThrow();
    expect(valid("unknown", {})).toBe(false);
    expect(valid("probe_done", assessment)).toBe(true);
    expect(valid("probe_done", { assessment: { strands: [] } })).toBe(false);
    expect(valid("probe_done", { assessment: "text" })).toBe(false);
  });
});
describe("practice input healing", () => {
  it("heals machine fields and omits empty targets", () => {
    const parsed = validateToolInput("problem", {
      ...problem,
      mode: '"recall"',
      target: '["addition"]',
    });
    expect(parsed.ok && parsed.call.input).toEqual(problem);
    const tagged = validateToolInput("quiz", { ...quiz, target: '["n_add"]' });
    expect(tagged.ok && tagged.call.input).toEqual({ ...quiz, target: ["n_add"] });
    const untagged = validateToolInput("problem", { ...problem, target: [] });
    expect(untagged.ok).toBe(true);
    expect(untagged.ok && "target" in untagged.call.input).toBe(false);
    expect(
      valid("conclude", { ...conclusion, outcome: '"solved"', rung: "null", retest: "true" }),
    ).toBe(true);
    expect(valid("conclude", { ...conclusion, outcome: "dismissed" })).toBe(true);
    expect(valid("problem", { ...problem, mode: '"bogus"' })).toBe(false);
    expect(valid("problem", null)).toBe(false);
    expect(valid("problem", { ...problem, modelSolution: " " })).toBe(false);
  });
});
describe("mechanics descriptions", () => {
  it("exports the seven MCP parameter objects as JSON Schema", () => {
    for (const schema of Object.values(sessionToolSchemas)) {
      const document = Schema.toJsonSchemaDocument(schema);
      expect(document.schema.type).toBe("object");
    }
  });
  it("ends every description with one valid compact example call", () => {
    for (const [name, description] of Object.entries(sessionToolDescriptions)) {
      expect(typeof description).toBe("string");
      const match = String(description).match(/\nExample: ([a-z_]+)\((.*)\)$/);
      expect(match?.[1]).toBe(name);
      expect(valid(name, JSON.parse(match![2]!))).toBe(true);
    }
    expect(sessionToolDescriptions.quiz).toContain("\\\\frac");
  });
});
