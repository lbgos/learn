import { createEvalSession } from "./session.ts";
import { cases } from "./cases.ts";
import { assert, it } from "@effect/vitest";
import { grade, type Step } from "./grade.ts";

const expect = { maxQuestions: 0, maxWords: 40, minWords: 5, noTrailingQuestion: true };
const step = (text: string, tools: ReadonlyArray<string> = [], stopReason = "end_turn"): Step => ({
  text,
  calls: tools.map((tool) => ({ tool, input: {} })),
  stopReason,
});

it("passes feedback that ends the turn and fails each way of continuing", () => {
  const feedback = "Correct. The extra pull of gravity matches the extra inertia, so mass cancels.";
  assert.isTrue(grade([step(feedback)], expect).pass);
  assert.deepEqual(grade([step(feedback, ["quiz"], "tool_use"), step("")], expect).failures, [
    "posed 1 questions (max 0)",
  ]);
  assert.deepEqual(grade([step(`${feedback}\n\nWhat happens on the Moon?**`)], expect).failures, [
    "ends by asking the learner a question",
  ]);
  assert.deepEqual(grade([step(feedback, ["research"], "tool_use")], expect).failures, [
    "did not end its turn (tool_use)",
  ]);
  assert.deepEqual(grade([step("Right.")], expect).failures, ["1 words and no question (min 5)"]);
  assert.deepEqual(
    grade([step(`${feedback} Send \`Continue\` for the step that shows it line by line.`)], expect)
      .failures,
    ["tells the learner to send Continue"],
  );
  assert.isTrue(grade([step(`${feedback} Next we continue with the period.`)], expect).pass);
});

it("allows one question as a chunk only when the turn ends after it", () => {
  const chunk = { ...expect, maxQuestions: 1, noTrailingQuestion: false };
  assert.isTrue(
    grade([step("Next, predict the period.", ["quiz"], "tool_use"), step("")], chunk).pass,
  );
  assert.isFalse(
    grade(
      [
        { ...step("Predict.", ["quiz"], "tool_use"), afterQuestionText: "Option A is correct." },
        step(""),
      ],
      chunk,
    ).pass,
  );
  assert.isFalse(
    grade([step("Predict.", ["quiz"], "tool_use"), step("Option A is correct.")], chunk).pass,
  );
  assert.deepEqual(
    grade(
      [step("Predict.", ["quiz"], "tool_use"), step("", ["research"], "tool_use"), step("")],
      chunk,
    ).failures,
    ["kept working after posing a question"],
  );
  assert.deepEqual(
    grade([step("one two three ".repeat(20), ["quiz"], "tool_use"), step("")], chunk).failures,
    ["60 words (max 40)"],
  );
});

it("checks required and forbidden content, the review target and forbidden tools", () => {
  const content = {
    ...expect,
    noTrailingQuestion: false,
    require: [/confiden/i],
    forbid: [/stays the same/i],
  };
  assert.isTrue(grade([step("Your low confidence fits a guess: mass cancels.")], content).pass);
  assert.deepEqual(grade([step("The period stays the same.")], content).failures, [
    "missing confiden",
    'says "stays the same"',
  ]);
  const warmUp = { ...expect, minQuestions: 1, maxQuestions: 1, target: "n_period" };
  const pose = (input: unknown): Step => ({
    text: "",
    calls: [{ tool: "quiz", input }],
    stopReason: "tool_use",
  });
  assert.isTrue(
    grade([pose({ question: "Period?", target: ["n_period"] }), step("")], warmUp).pass,
  );
  assert.isTrue(
    grade([pose({ question: "Period?", target: '["n_period"]' }), step("")], warmUp).pass,
  );
  assert.deepEqual(grade([pose({ question: "Period?" }), step("")], warmUp).failures, [
    "no question targets n_period",
  ]);
  const recall = {
    ...expect,
    minQuestions: 1,
    maxQuestions: 1,
    askAbout: /mass/,
    avoidAsking: /length/,
  };
  assert.isTrue(grade([pose({ question: "Why does mass cancel?" }), step("")], recall).pass);
  const choices = { kind: "choice", options: [{ label: "Tripling the mass", value: "a" }] };
  assert.isTrue(
    grade([pose({ question: "Which change matters?", answer: choices }), step("")], recall).pass,
  );
  assert.deepEqual(
    grade([pose({ question: "What does the length do?" }), step("")], recall).failures,
    ["no question asks about mass", 'asks "What does the length do?"'],
  );
  assert.deepEqual(
    grade(
      [step("Here is the worked solution, step by step.", ["conclude"], "tool_use"), step("")],
      {
        ...expect,
        forbidTools: ["conclude"],
      },
    ).failures,
    ["called conclude"],
  );
  const parking = { ...expect, parkAt: "period", opensWith: /earlier you asked/i };
  const parked = { tool: "park_question", input: { question: "Why?", nodeId: "period" } };
  assert.isTrue(
    grade(
      [{ text: "Earlier you asked why. Later.", calls: [parked], stopReason: "end_turn" }],
      parking,
    ).pass,
  );
  assert.deepEqual(
    grade([step("Later.\n\nEarlier you asked why.", ["park_question"])], parking).failures,
    ["parked nothing at period", "does not open with earlier you asked"],
  );
  const interactive = {
    ...expect,
    minQuestions: 1,
    maxQuestions: 1,
    show: true,
    questionType: "predict" as const,
    requireTools: [["plan_init"]],
  };
  const plan = { text: "", calls: [{ tool: "plan_init", input: {} }], stopReason: "tool_use" };
  assert.isTrue(
    grade(
      [plan, pose({ question: "Predict T.", type: "predict", simPath: "sims/p.sim.js" }), step("")],
      interactive,
    ).pass,
  );
  assert.deepEqual(
    grade([pose({ question: "T?", type: "check" }), step("")], interactive).failures,
    ["showed nothing to use", "no predict question", "called none of plan_init"],
  );
});

it("requires a closing recall question", () => {
  const closing = cases.find((entry) => entry.id === "closing-recall")!;
  assert.isFalse(
    grade([step("Remember how mass and gravity scale together in a pendulum.")], closing.expect)
      .pass,
  );
});

it("requires a long-break recap in prose before its question", () => {
  const resume = cases.find((entry) => entry.id === "resume-long-break-recap")!;
  const question = { tool: "explain", input: { question: "Why does mass cancel on both sides?" } };
  assert.isFalse(
    grade(
      [{ text: "Welcome back.", calls: [question], stopReason: "tool_use" }, step("")],
      resume.expect,
    ).pass,
  );
  assert.isTrue(
    grade(
      [
        {
          text: "We stopped where mass cancels from both sides of the equation.",
          calls: [question],
          stopReason: "tool_use",
        },
        step(""),
      ],
      resume.expect,
    ).pass,
  );
});

it("detects committed answers revealed by option id or converted units", () => {
  const choice = cases.find((entry) => entry.id === "answer-request-nudge")!;
  for (const reveal of ["Pick A.", "The correct option is **a**.", "A is correct.", "a."]) {
    assert.isFalse(grade([step(`Here is a hint. ${reveal}`)], choice.expect).pass, reveal);
  }
  const practice = cases.find((entry) => entry.id === "practice-answer-request-no-leak")!;
  for (const reveal of [
    "1420 ms",
    "1.42e3 milliseconds",
    "0.0237 minutes",
    "142 centiseconds",
    "1.42 seconds",
  ]) {
    assert.isFalse(
      grade([step(`The period is approximately ${reveal}.`)], practice.expect).pass,
      reveal,
    );
  }
  assert.isTrue(
    grade(
      [step("Start by substituting the length and gravity into the period formula.")],
      practice.expect,
    ).pass,
  );
});

it("refuses invalid simulated calls without advancing the production gate", () => {
  for (const entry of cases) createEvalSession(entry);
  const entry = cases.find((entry) => entry.id === "continue-one-chunk")!;
  const invoke = createEvalSession(entry);
  const input = { question: "Why?", correctAnswer: "Gravity and inertia scale together." };
  const refused = invoke("explain", "invalid-position", input);
  assert.isNotEmpty(refused.problems);
  // Production returns a refusal as the encoded failure, flagged as an error.
  assert.isTrue(refused.isError);
  assert.include(
    refused.content[0]?.type === "text" ? refused.content[0].text : "",
    '{"_tag":"OrchestratorMcpFailure","code":"invalid_request","message":"explain was not applied:',
  );
  assert.isNotEmpty(
    invoke("quiz", "invalid-answer", {
      type: "check",
      nodeId: "mass-cancels",
      question: "Which?",
      answer: { kind: "choice", options: [{ label: "Same", value: "a" }] },
      correctAnswer: "z",
      explanation: "Mass cancels.",
    }).problems,
  );
  const accepted = invoke("explain", "valid", { ...input, type: "check", nodeId: "mass-cancels" });
  assert.isEmpty(accepted.problems);
  assert.include(
    accepted.content[0]?.type === "text" ? accepted.content[0].text : "",
    '"id":"valid"',
  );
  assert.isFalse(
    grade(
      [
        {
          text: "",
          calls: [{ tool: "quiz", input: {}, problems: ["invalid"] }],
          stopReason: "end_turn",
        },
      ],
      { maxQuestions: 1, minQuestions: 1, maxWords: 100, minWords: 0 },
    ).pass,
  );
});

it("requires the persisted verdict and its question, outcome and reason", () => {
  const verdict = { tool: "grade_answer", questionId: "x", verdict: "correct" } as const;
  assert.isFalse(
    grade([step("Correct. Both forces scale together.")], { ...expect, verdict }).pass,
  );
  assert.isTrue(
    grade(
      [
        {
          text: "Correct. Both forces scale together.",
          calls: [
            {
              tool: "grade_answer",
              input: { questionId: "x", verdict: "correct", reason: "Both scale." },
            },
          ],
          stopReason: "end_turn",
        },
      ],
      { ...expect, verdict },
    ).pass,
  );
});
