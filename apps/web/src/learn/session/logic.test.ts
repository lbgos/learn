import { describe, expect, it } from "vite-plus/test";
import {
  sessionReplayState,
  parseAnswerMessage,
  parseLearnerMessage,
  type PendingQuestion,
  type SessionEvent,
} from "@t3tools/learn/session";
import {
  buildQuestionMessage,
  learnDockState,
  learnPhase,
  learnTimelineItems,
  practiceMessage,
  questionOptions,
} from "./logic";
import { learnPendingInput } from "./pending";

import {
  at,
  call,
  choice,
  conclude,
  message,
  numberQuestion,
  problem,
} from "./fixtures.test-utils";

describe("question answer transport", () => {
  it("grades stable choice values and keeps thinking through the parser", () => {
    const text = buildQuestionMessage(choice, {
      values: ["gravity"],
      confidence: 90,
      thinking: "A line\n[answer different]",
      thinkingWhileReading: "Reading note",
    });
    expect(parseAnswerMessage(text)).toMatchObject({
      toolCallId: choice.id,
      verdict: "correct",
      confidence: 90,
      answer: [{ value: "gravity", label: "Gravity" }],
      thinking: "A line\n[answer different]",
    });
    expect(
      parseAnswerMessage(buildQuestionMessage(choice, { values: ["friction"] }))?.verdict,
    ).toBe("incorrect");
  });
  it("uses exact sets for multi-select", () => {
    const multi: PendingQuestion = {
      ...choice,
      name: "quiz",
      input: {
        ...choice.input,
        answer: {
          kind: "choice",
          options: choice.input.answer.kind === "choice" ? choice.input.answer.options : [],
          multiSelect: true,
        },
        correctAnswer: ["gravity", "tension"],
      },
    };
    expect(
      parseAnswerMessage(buildQuestionMessage(multi, { values: ["tension", "gravity"] }))?.verdict,
    ).toBe("correct");
    expect(parseAnswerMessage(buildQuestionMessage(multi, { values: ["gravity"] }))?.verdict).toBe(
      "incorrect",
    );
  });
  it("grades numbers with units and tolerance", () => {
    expect(
      parseAnswerMessage(
        buildQuestionMessage(numberQuestion, { value: 2.1, unit: "s", confidence: 70 }),
      ),
    ).toMatchObject({ answer: { value: 2.1, unit: "s" }, verdict: "correct", confidence: 70 });
    for (const request of [
      { value: 2.11, unit: "s" },
      { value: 2, unit: "ms" },
    ])
      expect(parseAnswerMessage(buildQuestionMessage(numberQuestion, request))?.verdict).toBe(
        "incorrect",
      );
  });
  it("leaves asks ungraded and explanations for the tutor", () => {
    const ask: PendingQuestion = {
      id: "ask1",
      toolCallId: "ask1",
      at,
      name: "ask",
      input: { question: "Next topic?", options: [{ label: "Waves" }, { label: "Optics" }] },
    };
    expect(
      parseAnswerMessage(buildQuestionMessage(ask, { values: ["Waves"], text: "Start slow" })),
    ).toMatchObject({
      kind: "ask",
      verdict: "ungraded",
      answer: { choices: [{ value: "Waves", label: "Waves" }], text: "Start slow" },
    });
    const explain: PendingQuestion = {
      id: "e1",
      toolCallId: "e1",
      at,
      name: "explain",
      input: { question: "Why?", correctAnswer: "Momentum is conserved." },
    };
    expect(
      parseAnswerMessage(buildQuestionMessage(explain, { text: "Conservation", confidence: 30 })),
    ).toMatchObject({
      kind: "explain",
      verdict: "pending-grade",
      confidence: 30,
      answer: "Conservation",
    });
    expect(parseAnswerMessage(buildQuestionMessage(explain, { dontKnow: true }))).toMatchObject({
      verdict: "dont-know",
      answer: "I don't know",
    });
  });
  it("does not attach confidence to don't-know answers", () => {
    const answer = parseAnswerMessage(
      buildQuestionMessage(choice, { dontKnow: true, confidence: 90 }),
    );
    expect(answer?.verdict).toBe("dont-know");
    expect(answer?.confidence).toBeUndefined();
  });
  it("shuffles by question id without mutating source options", () => {
    const before = JSON.stringify(choice.input);
    expect(questionOptions(choice)).toEqual(questionOptions({ ...choice }));
    expect(
      questionOptions(choice)
        .map((option) => option.value)
        .sort(),
    ).toEqual(["friction", "gravity", "normal", "tension"]);
    expect(JSON.stringify(choice.input)).toBe(before);
  });
});

describe("session dock and timeline derivation", () => {
  it("shows the latest pending question and folds answers onto the original call", () => {
    const events = [call(choice), message(buildQuestionMessage(choice, { values: ["gravity"] }))];
    expect(learnDockState([call(choice)], "teach")?.type).toBe("question");
    expect(learnDockState(events, "teach")).toBeNull();
    expect(learnTimelineItems(events)).toMatchObject([
      { kind: "question", anchorId: choice.id, eventIndex: 0, answer: { verdict: "correct" } },
    ]);
    expect(learnTimelineItems([call(choice)])[0]).toMatchObject({
      kind: "question",
      answer: undefined,
    });
  });
  it("places phase dividers at accepted transition calls, including replacements", () => {
    const done: SessionEvent = {
      type: "tool-call",
      id: "done",
      name: "probe_done",
      at,
      input: { assessment: { strands: [{ strand: "Force", assessment: "Ready" }] } },
    };
    const plan: SessionEvent = {
      type: "tool-call",
      id: "plan",
      name: "plan_init",
      at,
      input: { mermaid: "graph TD\nforce[Force] --> motion[Motion]" },
    };
    const items = learnTimelineItems([done, plan, { ...plan, id: "plan2" }]);
    expect(items.filter((item) => item.kind === "phase")).toMatchObject([
      { phase: "plan", eventIndex: 0, anchorId: "done" },
      { phase: "teach", eventIndex: 1, anchorId: "plan" },
    ]);
    expect(items.filter((item) => item.kind === "plan")).toHaveLength(2);
    expect(learnTimelineItems([plan])).toEqual([]);
  });
  it("collapses only a first graph-context message", () => {
    expect(
      learnTimelineItems([message("[graph context]\np1: Mass has inertia.")])[0],
    ).toMatchObject({ kind: "graph-context", text: "p1: Mass has inertia." });
    expect(
      learnTimelineItems([message("hello"), { ...message("[graph context]\nlate"), id: "m2" }]),
    ).toEqual([]);
  });
  it("keeps practice statements in history and reveals the commitment only at conclusion", () => {
    const before = learnTimelineItems([problem], "practice");
    expect(before.find((item) => item.kind === "problem")).toMatchObject({
      statement: "Find the acceleration.",
      active: true,
    });
    expect(JSON.stringify(before)).not.toContain("F/m");
    expect(
      learnTimelineItems([problem, conclude], "practice").find(
        (item) => item.kind === "conclusion",
      ),
    ).toMatchObject({ solution: "F/m", input: { outcome: "solved" } });
  });
  it("keeps a dismissed practice problem active and pauses after conclusion until next", () => {
    const dismissed = message(practiceMessage("p1", "dismiss", ""));
    expect(learnDockState([problem, dismissed], "practice")).toMatchObject({
      type: "problem",
      dismissed: true,
    });
    expect(learnPendingInput([problem, dismissed], "practice")).toBeNull();
    expect(
      learnPendingInput([], "practice", { state: sessionReplayState([problem, dismissed]) }),
    ).toBeNull();
    expect(learnPhase([problem, dismissed], "practice")).toBe("problem active");
    expect(learnDockState([problem, conclude], "practice")?.type).toBe("paused");
    const next = message("[next problem]");
    expect(learnDockState([problem, conclude, next], "practice")).toBeNull();
    expect(
      learnDockState([next], "practice", { state: sessionReplayState([problem, conclude]) }),
    ).toBeNull();
    expect(
      learnDockState([], "practice", { state: sessionReplayState([problem, conclude, next]) }),
    ).toBeNull();
    expect(
      learnTimelineItems([problem, conclude], "practice").filter((item) => item.kind === "phase"),
    ).toMatchObject([
      { phase: "problem active", eventIndex: 0 },
      { phase: "paused", eventIndex: 1 },
    ]);
  });
  it("updates the latest plan statuses from subsequent tagged questions", () => {
    const done: SessionEvent = {
      type: "tool-call",
      id: "done",
      name: "probe_done",
      at,
      input: { assessment: { strands: [{ strand: "Force", assessment: "Ready" }] } },
    };
    const plan: SessionEvent = {
      type: "tool-call",
      id: "plan",
      name: "plan_init",
      at,
      input: { mermaid: "graph TD\nforce[Force] --> motion[Motion]" },
    };
    const force: SessionEvent = {
      ...call(choice),
      input: { ...choice.input, type: "check", nodeId: "force" },
    };
    const motion: SessionEvent = {
      ...force,
      id: "motion-q",
      input: { ...choice.input, type: "check", nodeId: "motion" },
    };
    const item = learnTimelineItems([done, plan, force, motion]).find(
      (item) => item.kind === "plan",
    );
    expect(item?.block.nodes).toMatchObject([
      { id: "force", status: "visited" },
      { id: "motion", status: "current" },
    ]);
  });
  it("shows open parked questions on the latest plan and the question its answer recalls", () => {
    const tool = (id: string, name: string, input: unknown): SessionEvent => ({
      type: "tool-call",
      id,
      name,
      at,
      input,
    });
    const events = [
      tool("done", "probe_done", {
        assessment: { strands: [{ strand: "Force", assessment: "Ready" }] },
      }),
      tool("plan", "plan_init", { mermaid: "graph TD\nforce[Force] --> motion[Motion]" }),
      tool("p1", "park_question", { question: "Why sines?", nodeId: "motion" }),
      tool("p2", "park_question", { question: "And friction?", nodeId: "after-plan" }),
      tool("a1", "answer_parked", { id: "p1" }),
    ];
    const items = learnTimelineItems(events);
    expect(items.find((item) => item.kind === "plan")).toMatchObject({
      parked: [{ id: "p2" }],
    });
    expect(
      items.filter((item) => item.kind === "parked" || item.kind === "recalled"),
    ).toMatchObject([
      { kind: "parked", anchorId: "p1", step: "Motion" },
      { kind: "parked", anchorId: "p2", step: null },
      { kind: "recalled", anchorId: "a1", question: "Why sines?" },
    ]);
  });
  it("ignores refused calls and duplicate tool events", () => {
    expect(learnTimelineItems([conclude], "practice")).toEqual([]);
    expect(learnTimelineItems([call(choice), call(choice)])).toHaveLength(1);
    expect(
      learnTimelineItems([problem, message("[next problem]")], "practice").filter(
        (item) => item.kind === "phase",
      ),
    ).toMatchObject([{ phase: "problem active" }]);
  });
  it("uses trimmed choice keys for selection as well as grading", () => {
    const question: PendingQuestion = {
      ...choice,
      input: {
        ...choice.input,
        answer: {
          kind: "choice",
          options: [
            { label: "Gravity", value: " gravity " },
            { label: "Friction", value: "friction" },
          ],
        },
      },
    };
    expect(questionOptions(question).find((option) => option.label === "Gravity")?.value).toBe(
      "gravity",
    );
    expect(
      parseAnswerMessage(buildQuestionMessage(question, { values: ["gravity"] })),
    ).toMatchObject({ verdict: "correct", answer: [{ label: "Gravity", value: "gravity" }] });
  });
  it("formats each practice request using the shared learner signals", () => {
    for (const [action, text] of [
      ["hint", "Give me a hint."],
      ["check", "Check my answer."],
      ["stuck", "I'm stuck."],
    ] as const)
      expect(parseLearnerMessage(practiceMessage("p1", action, "F = ma"))).toEqual({
        type: "thinking",
        problemCallId: "p1",
        text: `${text}\n\nF = ma`,
      });
    expect(parseLearnerMessage(practiceMessage("p1", "dismiss", ""))).toEqual({
      type: "dismissed",
      problemCallId: "p1",
    });
  });
});
