import { describe, expect, it } from "vite-plus/test";
import { parseAnswerMessage, parseLearnerMessage } from "@t3tools/learn/session";
import { useLearnAnswerExtras } from "./answerExtras";
import { call, choice, conclude, message, numberQuestion, problem } from "./fixtures.test-utils";
import { practiceMessage, type SessionKind } from "./logic";
import {
  isLearnRequestId,
  learnDismissMessage,
  learnPendingInput,
  learnResponseMessage,
  parseNumberAnswer,
} from "./pending";

function pendingOf(events: Parameters<typeof learnPendingInput>[0], kind: SessionKind = "teach") {
  const pending = learnPendingInput(events, kind);
  if (!pending) throw new Error("no pending input");
  return pending;
}

describe("learn pending input", () => {
  it("maps a choice quiz to a native single-select request without free text", () => {
    const pending = pendingOf([call(choice)], "practice");
    expect(isLearnRequestId(pending.input.requestId)).toBe(true);
    const [question] = pending.input.questions;
    expect(question).toMatchObject({
      header: "Quiz",
      question: "Which force?",
      multiSelect: false,
    });
    expect(question.allowCustomAnswer).toBe(false);
    expect(question.options.map((option) => option.label).sort()).toEqual([
      "Friction",
      "Gravity",
      "Normal",
      "Tension",
    ]);
  });

  it("labels questions asked during the probe phase as probes", () => {
    expect(pendingOf([call(choice)]).input.questions[0].header).toBe("Probe");
  });

  it("accepts typed text for numeric quizzes", () => {
    expect(pendingOf([call(numberQuestion)]).input.questions[0].allowCustomAnswer).toBe(true);
    expect(parseNumberAnswer("9.8 m/s²")).toEqual({ value: 9.8, unit: "m/s²" });
    expect(parseNumberAnswer("-2e3")).toEqual({ value: -2000, unit: "" });
    expect(parseNumberAnswer("about two")).toBeNull();
  });

  it("grades a choice answer with the collected confidence and notes", () => {
    const pending = pendingOf([call(choice)]);
    useLearnAnswerExtras.getState().set(choice.id, { confidence: 90, thinking: "mass pulls" });
    const answer = parseAnswerMessage(learnResponseMessage(pending, { [choice.id]: "gravity" }));
    expect(answer).toMatchObject({ verdict: "correct", confidence: 90, thinking: "mass pulls" });
  });

  it("sends I don't know without an answer", () => {
    const pending = pendingOf([call(choice)]);
    const answer = parseAnswerMessage(learnResponseMessage(pending, {}, { dontKnow: true }));
    expect(answer?.verdict).toBe("dont-know");
  });

  it("grades a typed number with its unit", () => {
    const pending = pendingOf([call(numberQuestion)]);
    const answer = parseAnswerMessage(
      learnResponseMessage(pending, { [numberQuestion.id]: "2 s" }),
    );
    expect(answer).toMatchObject({ verdict: "correct", answer: { value: 2, unit: "s" } });
    expect(() => learnResponseMessage(pending, { [numberQuestion.id]: "two" })).toThrow();
  });

  it("keeps predict/check roles, committed answers and free recall semantics", () => {
    for (const type of ["predict", "check"] as const) {
      const question = { ...choice, input: { ...choice.input, type, nodeId: "inertia" } };
      const pending = pendingOf([
        {
          type: "tool-call",
          id: "done",
          name: "probe_done",
          at: choice.at,
          input: { assessment: { strands: [{ strand: "Inertia", assessment: "Ready" }] } },
        },
        {
          type: "tool-call",
          id: "plan",
          name: "plan_init",
          at: choice.at,
          input: { mermaid: "graph TD\ninertia[Inertia]" },
        },
        call(question),
      ]);
      expect(pending.input.questions[0].header).toBe(type === "predict" ? "Predict" : "Check");
      expect(pending.input.questions[0].question).not.toContain(question.input.explanation);
      expect(
        parseAnswerMessage(learnResponseMessage(pending, { [choice.id]: "friction" })),
      ).toMatchObject({ verdict: "incorrect" });
    }
    const question = {
      id: "recall",
      toolCallId: "recall",
      at: choice.at,
      name: "explain" as const,
      input: { question: "What is inertia?", correctAnswer: "Resistance to acceleration." },
    };
    const pending = pendingOf([call(question)]);
    expect(pending.input.questions[0]).toMatchObject({ options: [], allowCustomAnswer: true });
    expect(() => learnResponseMessage(pending, { recall: " " })).toThrow(
      "Write your answer first.",
    );
    expect(
      parseAnswerMessage(learnResponseMessage(pending, { recall: "Mass resists acceleration." })),
    ).toMatchObject({ verdict: "pending-grade", answer: "Mass resists acceleration." });
  });

  it("offers a practice problem with work, hint and dismiss, then a next-problem option", () => {
    const pending = pendingOf([problem], "practice");
    expect(pending.input.dismissible).toBe(true);
    expect(pending.input.questions[0].header).toBe("Practice");
    expect(parseLearnerMessage(learnResponseMessage(pending, { p1: "F = ma" }))).toEqual(
      parseLearnerMessage(practiceMessage("p1", "work", "F = ma")),
    );
    expect(() => learnResponseMessage(pending, { p1: "" })).toThrow();
    expect(
      parseLearnerMessage(learnResponseMessage(pending, { p1: "" }, { action: "hint" })),
    ).toEqual(parseLearnerMessage(practiceMessage("p1", "hint", "")));
    expect(learnDismissMessage(pending)).toBe(practiceMessage("p1", "dismiss", ""));

    const paused = pendingOf([problem, conclude], "practice");
    expect(paused.input.questions[0].options.map((option) => option.label)).toEqual([
      "Next problem",
    ]);
    expect(parseLearnerMessage(learnResponseMessage(paused, { x: "next" })).type).toBe(
      "next-problem",
    );
    expect(
      learnPendingInput([problem, conclude, message("[next problem]")], "practice"),
    ).toBeNull();
  });
});
