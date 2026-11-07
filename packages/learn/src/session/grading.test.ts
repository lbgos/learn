// Ported from learnharness (AGPL-3.0-only) tests/question-core.test.ts @ c549494.
import { describe, expect, it } from "vite-plus/test";
import {
  buildAnswer,
  gradeChoice,
  gradeNumber,
  isCorrect,
  shuffleOptions,
  type QuizInput,
} from "./index.ts";
import { quiz, numberQuiz } from "./fixtures.test-utils.ts";

describe("choice grading", () => {
  it("matches single choices and exact multi-select sets by value", () => {
    expect(gradeChoice(quiz, ["4"])).toBe("correct");
    expect(gradeChoice(quiz, ["5"])).toBe("incorrect");
    expect(gradeChoice(quiz, [])).toBe("incorrect");
    const multi = {
      ...quiz,
      answer: { ...quiz.answer, multiSelect: true },
      correctAnswer: ["4", "5"],
    };
    expect(gradeChoice(multi, ["5", "4"])).toBe("correct");
    expect(gradeChoice(multi, ["4"])).toBe("incorrect");
    expect(gradeChoice(multi, ["4", "5", "6"])).toBe("incorrect");
    expect(isCorrect(["4", "4"], ["4"])).toBe(false);
    expect(() => gradeChoice({ ...quiz, correctAnswer: "missing" }, ["4"])).toThrow();
  });
  it("shuffles deterministically by call id without mutating options or changing grading", () => {
    const values = Array.from({ length: 8 }, (_, i) => ({ label: `${i}`, value: `${i}` }));
    expect(shuffleOptions(values, "q1")).toEqual(shuffleOptions(values, "q1"));
    expect(shuffleOptions(values, "q1")).not.toEqual(shuffleOptions(values, "q2"));
    expect(shuffleOptions(values, "q1")).toHaveLength(values.length);
    expect(values.map((value) => value.value)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    expect(
      gradeChoice(
        {
          ...quiz,
          answer: { kind: "choice", options: shuffleOptions(values, "q1") },
          correctAnswer: "2",
        },
        ["2"],
      ),
    ).toBe("correct");
  });
});
describe("number grading", () => {
  it("uses inclusive relative tolerance defaulting to 5%", () => {
    for (const value of [9.5, 10, 10.5])
      expect(gradeNumber(numberQuiz, value, "m/s")).toBe("correct");
    for (const value of [9.49, 10.51, NaN, Infinity])
      expect(gradeNumber(numberQuiz, value, "m/s")).toBe("incorrect");
    const small: QuizInput = {
      ...numberQuiz,
      answer: { kind: "number", tolerance: 0.01 },
      correctAnswer: 0.001,
    };
    expect(gradeNumber(small, 0.00101)).toBe("correct");
    expect(gradeNumber(small, 0.001011)).toBe("incorrect");
  });
  it("handles negative and zero commitments and checks units without guessing conversions", () => {
    const negative = { ...numberQuiz, correctAnswer: -10 };
    expect(gradeNumber(negative, -10.5, "m/s")).toBe("correct");
    expect(gradeNumber(negative, 10, "m/s")).toBe("incorrect");
    expect(gradeNumber({ ...numberQuiz, correctAnswer: 0 }, 0, "m/s")).toBe("correct");
    expect(gradeNumber({ ...numberQuiz, correctAnswer: 0 }, 1e-20, "m/s")).toBe("incorrect");
    for (const unit of [undefined, "cm/s", "M/S"])
      expect(gradeNumber(numberQuiz, 10, unit)).toBe("incorrect");
    expect(gradeNumber(numberQuiz, 10, " m/s ")).toBe("correct");
    expect(gradeNumber({ ...numberQuiz, answer: { kind: "number" } }, 10)).toBe("correct");
    expect(
      gradeNumber(
        { ...numberQuiz, answer: { kind: "number", unit: "m/s", tolerance: 0 } },
        10.01,
        "m/s",
      ),
    ).toBe("incorrect");
    expect(
      gradeNumber(
        { ...numberQuiz, answer: { kind: "number", unit: "m/s", tolerance: 0 } },
        10 + Number.EPSILON * 10,
        "m/s",
      ),
    ).toBe("incorrect");
  });
});
describe("answer construction", () => {
  it("normalizes option values consistently between validation and grading", () => {
    const spaced: QuizInput = {
      ...quiz,
      answer: {
        kind: "choice",
        options: [
          { label: "Four", value: " 4 " },
          { label: "Five", value: "5" },
        ],
      },
    };
    expect(gradeChoice(spaced, [" 4 "])).toBe("correct");
    expect(buildAnswer("q", { kind: "quiz", input: spaced }, { values: [" 4 "] }).verdict).toBe(
      "correct",
    );
  });
  it("preserves ask selections alongside the learner's free text", () => {
    const input = {
      question: "Which?",
      options: [{ label: "A" }, { label: "B" }],
      multiSelect: true,
    };
    const answer = buildAnswer(
      "a",
      { kind: "ask", input },
      { values: ["A", "B"], text: "And C\nwith a reason" },
    );
    expect(answer.answer).toEqual({
      choices: [
        { value: "A", label: "A" },
        { value: "B", label: "B" },
      ],
      text: "And C\nwith a reason",
    });
  });
  it("handles I-don't-know without confidence and preserves both thinking channels", () => {
    const answer = buildAnswer(
      "q",
      { kind: "quiz", input: quiz },
      { dontKnow: true, confidence: 100, thinking: "gap", thinkingWhileReading: "confused" },
    );
    expect(answer.verdict).toBe("dont-know");
    expect(answer.confidence).toBeUndefined();
    expect(answer.thinking).toBe("gap");
    expect(answer.thinkingWhileReading).toBe("confused");
  });
  it("grades quiz answers, clamps confidence and defaults confidence to 50", () => {
    const answer = buildAnswer(
      "q",
      { kind: "quiz", input: quiz },
      { values: ["4"], confidence: 150 },
    );
    expect(answer.answer).toEqual([{ label: "Four", value: "4" }]);
    expect(answer.verdict).toBe("correct");
    expect(answer.confidence).toBe(100);
    expect(
      buildAnswer("n", { kind: "quiz", input: numberQuiz }, { value: 10, unit: "m/s" }).verdict,
    ).toBe("correct");
    expect(
      buildAnswer("q", { kind: "quiz", input: quiz }, { values: ["5"], confidence: -10 })
        .confidence,
    ).toBe(0);
    expect(buildAnswer("q", { kind: "quiz", input: quiz }, { values: ["4"] }).confidence).toBe(50);
    expect(() =>
      buildAnswer("q", { kind: "quiz", input: quiz }, { values: ["unknown"] }),
    ).toThrow();
    expect(() => buildAnswer("q", { kind: "quiz", input: quiz }, { values: ["4", "4"] })).toThrow();
    expect(() => buildAnswer("n", { kind: "quiz", input: numberQuiz }, {})).toThrow();
  });
  it("leaves recall pending agent grading and ask ungraded", () => {
    const recall = {
      kind: "explain",
      input: { question: "Why?", correctAnswer: "Because..." },
    } satisfies Parameters<typeof buildAnswer>[1];
    expect(buildAnswer("e", recall, { text: "My reasoning" }).verdict).toBe("pending-grade");
    expect(buildAnswer("e", recall, { dontKnow: true }).verdict).toBe("dont-know");
    const ask = buildAnswer(
      "a",
      { kind: "ask", input: { question: "Which?", options: [{ label: "A" }, { label: "B" }] } },
      { text: "Something else", confidence: 100 },
    );
    expect(ask.answer).toBe("Something else");
    expect(ask.verdict).toBe("ungraded");
    expect(ask.confidence).toBeUndefined();
  });
});
