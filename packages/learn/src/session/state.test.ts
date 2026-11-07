// Ported from learnharness (AGPL-3.0-only) tests/phases.test.ts, tests/probe-done.test.ts, tests/practice-flow.test.ts, tests/question-tools.test.ts @ c549494.
import { describe, expect, it } from "vite-plus/test";
import {
  activeProblem,
  answersById,
  applySessionEvent,
  buildAnswer,
  createSessionGate,
  derivePhase,
  derivePlanStatuses,
  sessionReplayState,
  derivePlan,
  deriveSession,
  formatAnswerMessage,
  formatLearnerSignal,
  formatParkedContext,
  formatSessionContext,
  pendingQuestion,
  validateSessionCall,
} from "./index.ts";
import {
  assessment,
  call,
  conclusion,
  message,
  planEvents,
  practice,
  problem,
  quiz,
  teach,
} from "./fixtures.test-utils.ts";

const reply = (id: string, toolCallId: string) =>
  message(
    id,
    formatAnswerMessage(
      buildAnswer(toolCallId, { kind: "quiz", input: quiz }, { values: ["4"], confidence: 90 }),
    ),
  );
describe("phase derivation and teach gates", () => {
  it("runs probe → successful assessment → plan → successful plan → teach", () => {
    expect(derivePhase([])).toBe("probe");
    expect(derivePhase([call("bad", "probe_done", {})])).toBe("probe");
    expect(derivePhase([planEvents[1]!])).toBe("probe");
    expect(derivePhase([planEvents[0]!])).toBe("plan");
    expect(
      derivePhase([planEvents[0]!, call("bad", "plan_init", { mermaid: "graph TD\na --> a" })]),
    ).toBe("plan");
    expect(derivePhase(planEvents)).toBe("teach");
    expect(derivePlan([planEvents[1]!])).toBeNull();
  });
  it("refuses tags in probe and requires valid type and nodeId in teach", () => {
    const probe = createSessionGate(teach);
    expect(validateSessionCall(probe, "quiz", quiz)).toEqual([]);
    const graphProbe = createSessionGate(teach, [], new Set(["n_add"]));
    expect(
      validateSessionCall(graphProbe, "explain", {
        question: "Why is 2+2 four?",
        correctAnswer: "Two pairs make four.",
        target: ["n_add"],
      }),
    ).toEqual([]);
    expect(
      validateSessionCall(graphProbe, "quiz", { ...quiz, target: ["n_gone"] }).join(" "),
    ).toMatch(/Unknown target ids: n_gone/);
    expect(validateSessionCall(probe, "quiz", { ...quiz, type: "check" }).join(" ")).toMatch(
      /omit type and nodeId/,
    );
    const teaching = createSessionGate(teach, planEvents);
    expect(validateSessionCall(teaching, "quiz", quiz).join(" ")).toMatch(
      /type is required.*nodeId is required/,
    );
    expect(validateSessionCall(teaching, "quiz", { ...quiz, type: "check", nodeId: "a" })).toEqual(
      [],
    );
    expect(
      validateSessionCall(teaching, "quiz", { ...quiz, type: "predict", nodeId: "missing" }).join(
        " ",
      ),
    ).toMatch(/Unknown nodeId.*a, b, c/);
    expect(
      validateSessionCall(probe, "plan_init", { mermaid: "graph TD\na[A]" }).join(" "),
    ).toMatch(/probe_done first/);
  });
  it("refuses graded questions in plan with a corrective explanation", () => {
    const planning = createSessionGate(teach, [planEvents[0]!]);
    expect(validateSessionCall(planning, "quiz", quiz).join(" ")).toMatch(
      /present.*plan_init.*confirmation/,
    );
    expect(
      derivePhase([planEvents[0]!, call("bad", "quiz", { ...quiz, type: "check", nodeId: "a" })]),
    ).toBe("plan");
  });
  it("allows choice and free recall in teach sessions while enforcing question position", () => {
    const explain = { question: "Why?", correctAnswer: "Because..." };
    expect(validateSessionCall(createSessionGate(teach), "explain", explain)).toEqual([]);
    const recall = createSessionGate({ kind: "teach", mechanic: "recall" });
    expect(validateSessionCall(recall, "explain", explain)).toEqual([]);
    expect(validateSessionCall(recall, "quiz", quiz)).toEqual([]);
    const teaching = createSessionGate({ kind: "teach", mechanic: "recall" }, planEvents);
    expect(
      validateSessionCall(teaching, "explain", { ...explain, type: "check", nodeId: "a" }),
    ).toEqual([]);
    expect(validateSessionCall(teaching, "explain", { ...explain, nodeId: "a" }).join(" ")).toMatch(
      /type is required/,
    );
    expect(
      validateSessionCall(teaching, "explain", {
        ...explain,
        type: "check",
        nodeId: "missing",
      }).join(" "),
    ).toMatch(/Unknown nodeId/);
  });
  it("allows probe_done exactly once and refuses it while any question is unanswered", () => {
    const events = [call("q", "quiz", quiz), call("blocked", "probe_done", assessment)];
    expect(derivePhase(events)).toBe("probe");
    expect(
      validateSessionCall(createSessionGate(teach, events), "probe_done", assessment).join(" "),
    ).toMatch(/pending/);
    expect(
      derivePhase([...events, reply("answer", "q"), call("done", "probe_done", assessment)]),
    ).toBe("plan");
    const done = createSessionGate(teach, [planEvents[0]!]);
    expect(validateSessionCall(done, "probe_done", assessment).join(" ")).toMatch(/exactly once/);
  });
  it("updates the plan and phase during one turn without waiting for projection", () => {
    const seed = createSessionGate(teach);
    const done = applySessionEvent(seed, planEvents[0]!);
    expect(done.problems).toEqual([]);
    expect(done.gate.phase).toBe("plan");
    expect(validateSessionCall(done.gate, "probe_done", assessment).length).toBeGreaterThan(0);
    const plan = applySessionEvent(done.gate, planEvents[1]!);
    expect(validateSessionCall(plan.gate, "quiz", { ...quiz, type: "check", nodeId: "b" })).toEqual(
      [],
    );
    const rewrite = applySessionEvent(
      plan.gate,
      call("new", "plan_init", { mermaid: "graph TD\nx[X]" }),
    );
    expect(
      validateSessionCall(rewrite.gate, "quiz", { ...quiz, type: "check", nodeId: "b" }).length,
    ).toBeGreaterThan(0);
    expect(
      validateSessionCall(rewrite.gate, "quiz", { ...quiz, type: "check", nodeId: "x" }),
    ).toEqual([]);
    expect(seed.phase).toBe("probe");
    expect(seed.plan).toBeNull();
  });
  it("keeps the original gate on refusal and handles malformed event boundaries", () => {
    const seed = createSessionGate(teach);
    const refused = applySessionEvent(seed, call("invalid", "problem", problem));
    expect(refused.gate).toBe(seed);
    expect(refused.problems).not.toHaveLength(0);
    expect(
      applySessionEvent(seed, call("bad id", "ask", { question: "Q" })).problems.length,
    ).toBeGreaterThan(0);
    expect(applySessionEvent(seed, call("bad", "unknown", {})).gate).toBe(seed);
  });
});
describe("questions and answers", () => {
  it("finds the latest valid unanswered question and retains older pending questions", () => {
    const events = [
      call("q1", "quiz", quiz),
      call("q2", "quiz", quiz),
      call("bad", "quiz", { ...quiz, correctAnswer: "missing" }),
    ];
    expect(pendingQuestion(events)?.toolCallId).toBe("q2");
    expect(pendingQuestion([...events, reply("a2", "q2")])?.toolCallId).toBe("q1");
    expect(pendingQuestion([...events, reply("a2", "q2"), reply("a1", "q1")])).toBeNull();
    expect(answersById([...events, reply("a2", "q2")]).get("q2")?.verdict).toBe("correct");
  });
  it("ignores orphan, duplicate, premature and kind-mismatched answer headers", () => {
    const wrongKind = buildAnswer(
      "q",
      { kind: "ask", input: { question: "Q" } },
      { text: "Answer" },
    );
    const events = [
      reply("early", "q"),
      call("q", "quiz", quiz),
      reply("orphan", "missing"),
      message("wrong", formatAnswerMessage(wrongKind)),
    ];
    expect(pendingQuestion(events)?.id).toBe("q");
    expect(answersById(events).size).toBe(0);
    const answered = [...events, reply("real", "q")];
    expect(
      answersById([...answered, message("duplicate", formatAnswerMessage(wrongKind))]).get("q")
        ?.kind,
    ).toBe("quiz");
    expect(pendingQuestion([...answered, call("q", "quiz", quiz)])).toBeNull();
  });
  it("tracks ask and explain through the same pending mechanism", () => {
    for (const kind of ["ask", "explain"] satisfies ("ask" | "explain")[]) {
      const input = { question: "Q", correctAnswer: "Because..." };
      const events = [call("q", kind, input)];
      const answer =
        kind === "ask"
          ? buildAnswer("q", { kind, input }, { text: "A" })
          : buildAnswer("q", { kind, input }, { text: "A" });
      expect(pendingQuestion(events)?.name).toBe(kind);
      expect(pendingQuestion([...events, message("a", formatAnswerMessage(answer))])).toBeNull();
    }
  });
});
describe("practice gates", () => {
  it("tracks only successful poses and conclusions and validates graph targets", () => {
    const seed = createSessionGate(practice, [], new Set(["addition"]));
    expect(validateSessionCall(seed, "conclude", conclusion).join(" ")).toMatch(
      /No active problem/,
    );
    expect(
      validateSessionCall(seed, "problem", { ...problem, target: ["missing"] }).join(" "),
    ).toMatch(/Unknown target ids/);
    expect(validateSessionCall(seed, "problem", { ...problem, target: [] })).toEqual([]);
    const posed = applySessionEvent(seed, call("p1", "problem", problem));
    expect(posed.gate.problem?.toolCallId).toBe("p1");
    expect(validateSessionCall(posed.gate, "problem", problem).join(" ")).toMatch(/already active/);
    expect(
      activeProblem([
        call("bad", "problem", {}),
        call("p1", "problem", problem),
        call("badc", "conclude", {}),
      ])?.toolCallId,
    ).toBe("p1");
    const ended = applySessionEvent(posed.gate, call("c1", "conclude", conclusion));
    expect(ended.gate.problem).toBeNull();
    expect(validateSessionCall(ended.gate, "conclude", conclusion).join(" ")).toMatch(/No active/);
    expect(validateSessionCall(ended.gate, "problem", problem)).toEqual([]);
    expect(
      activeProblem([
        call("p1", "problem", problem),
        call("p2", "problem", problem),
        call("end", "conclude", conclusion),
      ]),
    ).toBeNull();
  });
  it("lets an untagged topic session pose without graph validation", () => {
    expect(validateSessionCall(createSessionGate(practice), "problem", problem)).toEqual([]);
    expect(
      validateSessionCall(createSessionGate(practice, [], new Set()), "problem", {
        statement: "Q",
        mode: "recall",
        modelSolution: "A",
      }),
    ).toEqual([]);
  });
  it("isolates practice tools and permits ask in both session kinds", () => {
    const seed = createSessionGate(practice);
    expect(validateSessionCall(seed, "quiz", quiz).join(" ")).toMatch(/unavailable in practice/);
    expect(
      validateSessionCall(seed, "explain", { question: "Q", correctAnswer: "A" }).join(" "),
    ).toMatch(/unavailable in practice/);
    expect(validateSessionCall(seed, "probe_done", assessment).length).toBeGreaterThan(0);
    expect(
      validateSessionCall(seed, "plan_init", { mermaid: "graph TD\na[A]" }).length,
    ).toBeGreaterThan(0);
    expect(validateSessionCall(seed, "ask", { question: "Q" })).toEqual([]);
    expect(
      validateSessionCall(createSessionGate(teach), "problem", problem).length,
    ).toBeGreaterThan(0);
    expect(
      validateSessionCall(createSessionGate(teach), "conclude", conclusion).length,
    ).toBeGreaterThan(0);
  });
  it("keeps dismissed problems active until the agent records conclude", () => {
    const events = [
      call("p", "problem", problem),
      message("dismiss", formatLearnerSignal({ type: "dismissed", problemCallId: "p" })),
    ];
    expect(activeProblem(events)?.toolCallId).toBe("p");
    expect(
      activeProblem([...events, call("end", "conclude", { ...conclusion, outcome: "dismissed" })]),
    ).toBeNull();
  });
  it("does not accept a graph-invalid pose during transcript replay", () => {
    expect(
      deriveSession([call("p", "problem", problem)], { meta: practice, graphNodeIds: new Set() })
        .problem,
    ).toBeNull();
  });
});
describe("context framing", () => {
  it("emits plain lines for the shared physics context block", () => {
    expect(formatSessionContext({ ...teach, phase: "probe" })).toBe(
      "session: teach\nphase: probe\nmechanic: choice (preferred; quiz and explain are both available)",
    );
    const plan = derivePlan(planEvents)!;
    expect(
      formatSessionContext({
        ...teach,
        phase: "teach",
        plan,
        planStatuses: { current: "b", visited: new Set(["a", "b", "deleted"]) },
      }),
    ).toBe(
      "session: teach\nphase: teach\nmechanic: choice (preferred; quiz and explain are both available)\nplan: current b; visited a",
    );
    expect(formatSessionContext({ ...teach, phase: "teach", plan })).toContain(
      "plan: current none; visited none",
    );
    expect(formatSessionContext({ ...practice, phase: "probe" })).toBe("session: practice");
  });
});

it("resumes a bounded history from server state with its plan, position and pending question", () => {
  const events = [...planEvents, call("q", "quiz", { ...quiz, type: "check", nodeId: "b" })];
  const state = sessionReplayState(events);
  const reloaded = deriveSession([], { state });
  expect(reloaded.phase).toBe("teach");
  expect(reloaded.plan).toEqual(derivePlan(events));
  expect([...reloaded.questions.keys()]).toEqual(["q"]);
  expect(derivePlanStatuses(reloaded.plan!, [], { state }).current).toBe("b");
  expect(deriveSession([reply("answer", "q")], { state }).questions.size).toBe(0);
  expect(
    JSON.stringify(
      sessionReplayState([
        ...events,
        ...Array.from({ length: 200 }, (_, i) => message(`plain-${i}`, "Continue")),
      ]),
    ),
  ).toBe(JSON.stringify(state));
});

it("grades explain answers once and persists corrections to graded verdicts", () => {
  const input = { question: "Why?", correctAnswer: "Because mass cancels." };
  let gate = deriveSession([
    call("x", "explain", input),
    message(
      "answer",
      formatAnswerMessage(
        buildAnswer("x", { kind: "explain", input }, { text: "Mass cancels", confidence: 80 }),
      ),
    ),
  ]);
  const verdict = { questionId: "x", verdict: "incorrect", reason: "Missing a force." };
  expect(validateSessionCall(gate, "correct_verdict", verdict).join(" ")).toContain(
    "first explain verdict",
  );
  gate = applySessionEvent(gate, call("grade", "grade_answer", verdict)).gate;
  expect(gate.answers.get("x")?.verdict).toBe("incorrect");
  expect(validateSessionCall(gate, "grade_answer", verdict).join(" ")).toContain("first grade");
  gate = applySessionEvent(
    gate,
    call("correct", "correct_verdict", {
      ...verdict,
      verdict: "correct",
      reason: "Both forces are present.",
    }),
  ).gate;
  expect(gate.answers.get("x")).toMatchObject({
    verdict: "correct",
    verdictReason: "Both forces are present.",
  });
  expect(
    validateSessionCall(gate, "correct_verdict", { ...verdict, questionId: "missing" }).length,
  ).toBeGreaterThan(0);
});

describe("parked questions", () => {
  const parkB = call("p-b", "park_question", { question: "Why  divide?", nodeId: "b" });
  const parkLater = call("p-after", "park_question", {
    question: "And fractions?",
    nodeId: "after-plan",
  });
  it("parks only in teach sessions with a plan, at a plan node or after the plan", () => {
    const input = { question: "Why?", nodeId: "b" };
    expect(validateSessionCall(createSessionGate(teach), "park_question", input).join(" ")).toMatch(
      /needs a plan/,
    );
    expect(
      validateSessionCall(createSessionGate(practice), "park_question", input).join(" "),
    ).toMatch(/only available in teach/);
    const teaching = createSessionGate(teach, planEvents);
    expect(validateSessionCall(teaching, "park_question", input)).toEqual([]);
    expect(
      validateSessionCall(teaching, "park_question", { ...input, nodeId: "after-plan" }),
    ).toEqual([]);
    expect(
      validateSessionCall(teaching, "park_question", { ...input, nodeId: "z" }).join(" "),
    ).toMatch(/Unknown nodeId "z".*a, b, c/);
    expect(validateSessionCall(teaching, "answer_parked", { id: "p-b" }).join(" ")).toMatch(
      /No open parked question.*none/,
    );
  });
  it("answers an open parked question once and replays it across a history window", () => {
    const events = [...planEvents, parkB, parkLater];
    const gate = deriveSession(events, { meta: teach });
    expect([...gate.parked.keys()]).toEqual(["p-b", "p-after"]);
    expect(validateSessionCall(gate, "answer_parked", { id: "p-b" })).toEqual([]);
    const answered = deriveSession([...events, call("ans", "answer_parked", { id: "p-b" })]);
    expect([...answered.parked.keys()]).toEqual(["p-after"]);
    expect(validateSessionCall(answered, "answer_parked", { id: "p-b" }).join(" ")).toMatch(
      /open ids: p-after/,
    );
    const state = sessionReplayState(events);
    expect(state.parked?.map((parked) => parked.id)).toEqual(["p-b", "p-after"]);
    const resumed = deriveSession([parkB, call("ans", "answer_parked", { id: "p-b" })], { state });
    expect([...resumed.parked.keys()]).toEqual(["p-after"]);
    expect(deriveSession([], { state: { ...state, parked: undefined } }).parked.size).toBe(0);
  });
  it("lists open parked questions with their step and whether they are due", () => {
    const plan = derivePlan(planEvents)!;
    const parked = deriveSession([...planEvents, parkB, parkLater]).parked.values();
    const context = (current: string | null, visited: string[]) =>
      formatParkedContext({
        plan,
        planStatuses: { current, visited: new Set(visited) },
        parked: deriveSession([...planEvents, parkB, parkLater]).parked.values(),
      });
    expect(
      formatParkedContext({ plan, planStatuses: { current: null, visited: new Set() }, parked }),
    ).toBe(
      "parked questions:\n- p-b | step b, later | Why divide?\n- p-after | after the plan, later | And fractions?",
    );
    expect(context("a", [])).toContain("- p-b | step b, due at the next step |");
    expect(context("b", ["a"])).toContain("- p-b | step b, due now |");
    expect(context("c", ["a", "b"])).toContain("- p-after | after the plan, due now |");
    expect(
      formatParkedContext({ plan, planStatuses: { current: "a", visited: new Set() }, parked: [] }),
    ).toBe("");
  });
});
