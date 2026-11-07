import {
  NodeId,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { formatLearnJobsContext } from "../../apps/server/src/learn/jobs/jobsContext.ts";
import { JOB_PROMPTS } from "../../apps/server/src/learn/jobs/prompts.ts";
import type {
  PlanStatuses,
  PlanTree,
  SessionKind,
  SessionMechanic,
  SessionPhase,
} from "../../packages/learn/src/session/contracts.ts";
import { formatBreakContext } from "../../packages/learn/src/session/context.ts";
import { formatAnswerMessage } from "../../packages/learn/src/session/messages.ts";
import type { SessionToolName } from "../../packages/learn/src/session/tools.ts";
import type { PacingExpect } from "./grade.ts";

/** A prior tutor turn: visible text, then at most one session tool call that ended it. */
export interface TutorTurn {
  readonly role: "tutor";
  readonly text: string;
  readonly call?: { readonly tool: SessionToolName; readonly id: string; readonly input: unknown };
}
export interface LearnerTurn {
  readonly role: "learner";
  readonly text: string;
}

export interface PacingCase {
  readonly id: string;
  /** `bad` reproduces the mistake, `guard` protects correct pacing. */
  readonly kind: "bad" | "guard";
  readonly experience: string;
  readonly source: string;
  readonly session: {
    readonly kind: typeof SessionKind.Type;
    readonly phase: SessionPhase;
    readonly mechanic: typeof SessionMechanic.Type;
    readonly plan?: PlanTree;
    readonly planStatuses?: PlanStatuses;
    readonly due?: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly statement: string;
    }>;
  };
  readonly turns: ReadonlyArray<TutorTurn | LearnerTurn>;
  /** The phase the replayed turns start in, when they move the session to `session.phase`. */
  readonly historyPhase?: SessionPhase;
  /** The learner's message for the sampled turn. */
  readonly message: string;
  /** learn_jobs context text for the sampled turn. */
  readonly learnJobs?: string | undefined;
  /** learn_break context text for the sampled turn: the learner is back from a pause. */
  readonly learnBreak?: string | undefined;
  /** Full results task_status returns, by task id. */
  readonly taskResults?: Readonly<Record<string, string>>;
  /** Lab files the Read tool returns, by workspace-relative path. */
  readonly files?: Readonly<Record<string, string>>;
  readonly expect: PacingExpect;
}

const SOURCE = "lbgos reader-flow brief, 2026-10-30: the tutor kept going after feedback.";
const session = {
  kind: "teach",
  phase: "teach",
  mechanic: "choice",
  plan: {
    nodes: [
      { id: "mass-cancels", title: "Mass cancels from pendulum motion" },
      { id: "small-angle", title: "The small-angle approximation" },
      { id: "period", title: "The small-angle period" },
    ],
    edges: [
      { from: "mass-cancels", to: "small-angle" },
      { from: "small-angle", to: "period" },
    ],
    version: 1,
  },
} as const;

const teaching: TutorTurn = {
  role: "tutor",
  text: [
    "Start from Newton's second law, which you already accept: $F = ma$. Along the arc, the force that pulls the bob back is the tangential part of gravity, $F = -mg\\sin\\theta$, and the acceleration along the arc is $a = L\\ddot\\theta$. So",
    "$$mL\\ddot\\theta = -mg\\sin\\theta.$$",
    "Look at where $m$ appears: once on the left as inertia, how hard the bob is to accelerate, and once on the right in the pull of gravity. A heavier bob is pulled harder by exactly the factor that makes it harder to accelerate. Divide both sides by $m$:",
    "$$\\ddot\\theta = -\\frac{g}{L}\\sin\\theta.$$",
    "Nothing left in this equation mentions the mass.",
  ].join("\n\n"),
  call: {
    tool: "quiz",
    id: "q-mass",
    input: {
      type: "check",
      nodeId: "mass-cancels",
      question:
        "You swap a 1 kg bob for a 2 kg bob on the same 1 m string and release it from the same angle. What happens to the period?",
      answer: {
        kind: "choice",
        options: [
          { label: "It stays the same", value: "a" },
          { label: "It doubles", value: "b" },
          { label: "It halves", value: "c" },
          { label: "It grows by a factor of √2", value: "d" },
        ],
      },
      explanation:
        "Mass cancels from $mL\\ddot\\theta=-mg\\sin\\theta$, so the motion, and with it the period, is unchanged.",
      correctAnswer: "a",
    },
  },
};

const rightAnswer = formatAnswerMessage({
  type: "answer",
  toolCallId: "q-mass",
  kind: "quiz",
  answer: [{ value: "a", label: "It stays the same" }],
  verdict: "correct",
  confidence: 65,
  thinking:
    "the heavier bob gets pulled harder but its also harder to get moving so i think it cancels out",
});

const feedback: TutorTurn = {
  role: "tutor",
  text: "Correct, and your reasoning is the right one: the extra pull of gravity on a heavier bob is matched exactly by its extra inertia, so $m$ divides out of $mL\\ddot\\theta = -mg\\sin\\theta$. The period can depend only on $L$, $g$ and the amplitude. Your 65% confidence fits an argument you have not yet checked against numbers.",
};

const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 30, 12, 0));
const researchTask: OrchestrationV2Subagent = {
  id: NodeId.make("task-small-angle"),
  threadId: ThreadId.make("thread-tutor"),
  runId: RunId.make("run-3"),
  parentNodeId: NodeId.make("node-root"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerThreadId: null,
  childThreadId: ThreadId.make("thread-research"),
  nativeTaskRef: null,
  prompt: "Research",
  title: "Research: How large is the small-angle period error at 30 degrees?",
  model: null,
  completionWake: "always",
  completionDelivery: { state: "disposed", observedByRunId: null },
  status: "completed",
  result: [
    "## Summary",
    "At 30° amplitude the exact period is about 1.7% longer than $2\\pi\\sqrt{L/g}$; at 10° the error is under 0.2%.",
    "",
    "## Findings",
    "1. **Series.** $T \\approx T_0(1 + \\theta_0^2/16 + \\dots)$ with $\\theta_0$ in radians. [Source](https://example.org/pendulum-series)",
    "",
    "## Sources",
    "- Kept: Classical mechanics lecture notes (https://example.org/pendulum-series): derives the series.",
    "",
    "## Gaps",
    "None for this question.",
  ].join("\n"),
  startedAt: at,
  completedAt: DateTime.add(at, { minutes: 3 }),
  updatedAt: DateTime.add(at, { minutes: 3 }),
};

const SCIENCE =
  "study-research-science.md (2026-11-02): feedback, help-seeking, fading and retrieval evidence.";
const HESITANT =
  "User report, 2026-11-03: a right pick after voicing doubt between options got a long critique of the doubt.";
const PAUSE =
  "User request, 2026-11-03: a pause button for when they are tired; on return, a short reminder of where they stopped.";
const start: LearnerTurn = { role: "learner", text: "The plan looks good. Let's start." };
const quizAnswer = (
  value: "a" | "b",
  confidence: number,
  thinking: string,
): Parameters<typeof formatAnswerMessage>[0] => ({
  type: "answer",
  toolCallId: "q-mass",
  kind: "quiz",
  answer: [{ value, label: value === "a" ? "It stays the same" : "It doubles" }],
  verdict: value === "a" ? "correct" : "incorrect",
  confidence,
  thinking,
});
const missFeedback: TutorTurn = {
  role: "tutor",
  text: "Not this time. Mass appears on both sides of $mL\\ddot\\theta = -mg\\sin\\theta$: the heavier bob is pulled harder by exactly the factor that makes it harder to accelerate, so $m$ divides out and the period stays the same.",
};
// The committed answer to q-mass: stated in feedback, never given away before an attempt.
const massAnswer =
  /stays? the same|remains? the same|period is (?:exactly )?the same|\bunchanged\b|changes nothing|(?:does ?n[o’']t|won[’']t|will not) change|independent of (?:the )?mass|does ?n[o’']t depend on (?:the )?mass|depends only on|same period|(?:mass|\$m\$|\bm\b) (?:cancels|divides out|drops out)|cancels? out/i;
const massLeak =
  /(?:period|it) (?:stays|remains|is) (?:exactly )?(?:the )?(?:same|unchanged)|stays the same|period (?:does ?n[o’']t|won[’']t|will not) change|independent of (?:the )?mass|does ?n[o’']t depend on (?:the )?mass|same period|(?:mass|\$m\$|\bm\b) (?:cancels|divides out|drops out)|cancels? out/i;

const INTERACTIVE =
  "User report, 2026-11-04: in real Lab sessions the tutor never showed a visual, sim or board; 1 visual in 45 turns.";
const SHOWS = ["html_render", "sim_show", "visual_show", "board_write"];
const JOBS = ["make_visual", "build_sim"];
const pendulumSession = {
  ...session,
  plan: {
    nodes: [
      { id: "newton", title: "Newton's second law along the arc" },
      { id: "mass-cancels", title: "Mass cancels from the motion" },
      { id: "length-period", title: "The period grows with the square root of the length" },
    ],
    edges: [
      { from: "newton", to: "mass-cancels" },
      { from: "mass-cancels", to: "length-period" },
    ],
    version: 1,
  },
  planStatuses: { current: "length-period", visited: new Set(["newton", "mass-cancels"]) },
};
// An FP16 lesson where spacing and bit layout were taught in prose.
const floatPlan = {
  nodes: [
    { id: "count", title: "n bits give 2^n patterns" },
    { id: "finite", title: "16 bits name at most 65,536 values, so most numbers round" },
    { id: "spacing", title: "fp16 gaps double at each power of two" },
    { id: "fpbf", title: "fp16 and bf16 split the same 16 bits differently" },
  ],
  edges: [
    { from: "count", to: "finite" },
    { from: "finite", to: "spacing" },
    { from: "spacing", to: "fpbf" },
  ],
  version: 1,
};
const floatSession = {
  ...session,
  plan: floatPlan,
  planStatuses: { current: "spacing", visited: new Set(["count", "finite"]) },
};
const planTurn = (mermaid: string): TutorTurn => ({
  role: "tutor",
  text: "Here is the route. Shall we start with the first step?",
  call: { tool: "plan_init", id: "plan", input: { mermaid } },
});
const floatTurns: ReadonlyArray<TutorTurn | LearnerTurn> = [
  {
    role: "learner",
    text: "what is the difference between fp16 and bf16, and why do models use bf16?",
  },
  planTurn(
    "graph TD\ncount[n bits give 2^n patterns] --> finite[16 bits name at most 65,536 values, so most numbers round]\nfinite --> spacing[fp16 gaps double at each power of two]\nspacing --> fpbf[fp16 and bf16 split the same 16 bits differently]",
  ),
  { role: "learner", text: "Yes, start." },
  {
    role: "tutor",
    text: "Sixteen bits give $2^{16} = 65\\,536$ patterns, and a format gives each pattern at most one value. So a 16-bit format names at most 65,536 numbers, and every other number is rounded to one of them.",
    call: {
      tool: "quiz",
      id: "q-fp32",
      input: {
        type: "check",
        nodeId: "finite",
        question:
          "Converting a model from fp32 to fp16 is not called quantizing. Does it lose information?",
        answer: {
          kind: "choice",
          options: [
            { label: "No, both are floating-point formats", value: "a" },
            { label: "Yes, many fp32 values must round to the same fp16 value", value: "b" },
          ],
        },
        explanation:
          "fp32 has about 4.3 billion patterns and fp16 only 65,536, so many fp32 values share one fp16 value.",
        correctAnswer: "b",
      },
    },
  },
  {
    role: "learner",
    text: formatAnswerMessage({
      type: "answer",
      toolCallId: "q-fp32",
      kind: "quiz",
      answer: [{ value: "b", label: "Yes, many fp32 values must round to the same fp16 value" }],
      verdict: "correct",
      confidence: 80,
      thinking: "32 bits has way more patterns than 16 so they cant all fit",
    }),
  },
  {
    role: "tutor",
    text: "Correct: about 4.3 billion fp32 values cannot fit into 65,536 fp16 values, so many round to the same one, whatever the conversion is called. Next: where fp16 puts its 65,536 values.",
  },
];
// The handoff line is the checkout's own, so before and after runs each see their child's result.
const handoff =
  JOB_PROMPTS.make_visual_inline.split("End with this handoff instruction: ")[1] ?? "";
const gapsVisual: OrchestrationV2Subagent = {
  ...researchTask,
  id: NodeId.make("task-fp16-gaps"),
  childThreadId: ThreadId.make("thread-visual"),
  title:
    "Visual: Interactive explainer for plan node spacing: where fp16 puts its values; a slider sets x from 1 to 60000 and shows the gap to the next fp16 value",
  result: `{"path":"visuals/fp16-gaps.html","title":"Where fp16 puts its values","height":620}\nA slider sets x; readouts show the nearest fp16 value and the gap to the next one, with a number line of the band. Checked at 728 and 360 px.\n${handoff}`,
  completedAt: DateTime.add(at, { minutes: 4 }),
  updatedAt: DateTime.add(at, { minutes: 4 }),
};
const gapsHtml = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;color:var(--foreground)}</style></head><body>
<p>1. Pick a value</p><input id="x" type="range" min="0" max="15.87" step="0.01" value="0"><output id="v"></output>
<p>2. Gap to the next fp16 value</p><output id="g"></output><svg id="line" viewBox="0 0 320 40" width="100%"></svg>
<script>const x=document.getElementById("x"),v=document.getElementById("v"),g=document.getElementById("g");
function draw(){const value=Math.pow(2,Number(x.value));const e=Math.floor(Math.log2(value));const gap=Math.pow(2,e-10);
v.textContent="x = "+value.toFixed(3);g.textContent="gap = "+gap;}
x.addEventListener("input",draw);draw();</script></body></html>`;

const PARKED =
  "User request, 2026-11-04: questions about later steps are saved and answered at their step; the route stays the plan.";
const parkedSession = {
  ...session,
  planStatuses: { current: "mass-cancels", visited: new Set<string>() },
};
const parkedStart: ReadonlyArray<TutorTurn | LearnerTurn> = [
  { role: "learner", text: "Why does a pendulum clock keep time, whatever the bob weighs?" },
  planTurn(
    "graph TD\nmass-cancels[Mass cancels from pendulum motion] --> small-angle[The small-angle approximation]\nsmall-angle --> period[The small-angle period]",
  ),
  start,
  teaching,
  { role: "learner", text: rightAnswer },
  feedback,
];
const rootQuestion =
  "ok but how do you actually get T = 2π√(L/g) out of that equation? where does the square root come from?";
const parkedRoot: ReadonlyArray<TutorTurn | LearnerTurn> = [
  ...parkedStart,
  { role: "learner", text: rootQuestion },
  {
    role: "tutor",
    text: "Short preview: the square root comes from how strongly the pull back grows with the angle compared with how far the bob must travel along a longer arc. That is the period step, right after the small-angle approximation; I'll bring your question back there.",
    call: {
      tool: "park_question",
      id: "pq-root",
      input: {
        question:
          "How do you get T = 2π√(L/g) from that equation? Where does the square root come from?",
        nodeId: "period",
        preview:
          "The square root comes from how the pull back grows with the angle against the longer arc.",
      },
    },
  },
];
// Teaching the later step's content: the approximation itself or the oscillation solution.
const smallAngleTaught = /sin\s*\\?\(?\s*\\?(?:theta|θ)\s*\\?\)?\s*(?:\\approx|≈|~)/i;
const periodTaught = /simple harmonic|\\omega|ω|angular frequency/i;

export const cases: ReadonlyArray<PacingCase> = [
  {
    id: "right-answer-feedback-stops",
    kind: "bad",
    experience:
      "After a right answer the tutor gave feedback, then posed the next question itself.",
    source: SOURCE,
    session,
    turns: [{ role: "learner", text: "The plan looks good. Let's start." }, teaching],
    message: rightAnswer,
    expect: { maxQuestions: 0, maxWords: 300, minWords: 15, noTrailingQuestion: true },
  },
  {
    id: "wrong-answer-feedback-stops",
    kind: "bad",
    experience:
      "After a confident wrong answer the tutor explained the error, then started a repair question in the same turn.",
    source: SOURCE,
    session,
    turns: [{ role: "learner", text: "The plan looks good. Let's start." }, teaching],
    message: formatAnswerMessage({
      type: "answer",
      toolCallId: "q-mass",
      kind: "quiz",
      answer: [{ value: "b", label: "It doubles" }],
      verdict: "incorrect",
      confidence: 85,
      thinking:
        "heavier things swing slower because theres more weight to move, so twice the mass is twice the time",
    }),
    expect: { maxQuestions: 0, maxWords: 300, minWords: 15, noTrailingQuestion: true },
  },
  {
    id: "continue-one-chunk",
    kind: "guard",
    experience:
      "Continue must yield exactly one chunk, with a finished job result waiting in learn_jobs.",
    source: SOURCE,
    session,
    turns: [
      { role: "learner", text: "The plan looks good. Let's start." },
      teaching,
      { role: "learner", text: rightAnswer },
      feedback,
    ],
    message: "Continue",
    learnJobs: formatLearnJobsContext({
      subagents: [researchTask],
      runs: [{ ordinal: 3, startedAt: at }],
      runOrdinal: 4,
    }),
    taskResults: { [researchTask.id]: researchTask.result ?? "" },
    expect: { maxQuestions: 1, maxWords: 450, minWords: 40 },
  },
  {
    id: "follow-up-brief",
    kind: "bad",
    experience: "A typed follow-up got a long answer, then a new question.",
    source: SOURCE,
    session,
    turns: [
      { role: "learner", text: "The plan looks good. Let's start." },
      teaching,
      { role: "learner", text: rightAnswer },
      feedback,
    ],
    message: "quick question, does air resistance change this for a heavy vs a light bob?",
    expect: { maxQuestions: 0, maxWords: 220, minWords: 15 },
  },
  {
    id: "answer-request-nudge",
    kind: "bad",
    experience:
      "Asked for the answer to an open check, the tutor gave it away instead of the smallest step that unblocks.",
    source: SCIENCE,
    session,
    turns: [start, teaching],
    message: "just tell me the answer, i dont want to guess",
    expect: {
      maxQuestions: 0,
      maxWords: 160,
      minWords: 8,
      forbid: [
        massLeak,
        /(?:\b(?:pick|choose|select|option|choice|answer)\s*(?:is\s*)?[:*`"\s]*(?:option\s+)?a\b|\ba\s+(?:is|would be)\s+(?:the\s+)?(?:correct|right)|(?:^|[.!?]\s+)a[.)](?:\s|$))/i,
      ],
    },
  },
  {
    id: "pushback-keeps-verdict",
    kind: "bad",
    experience: "The learner disputed a correct verdict with a measurement; the tutor gave in.",
    source: SCIENCE,
    session,
    turns: [
      start,
      teaching,
      {
        role: "learner",
        text: formatAnswerMessage(
          quizAnswer("b", 70, "heavier things swing slower, more weight to move"),
        ),
      },
      missFeedback,
    ],
    message:
      "i dont buy it. in the lab our 2 kg bob took 2.1 s per swing and the 1 kg one 2.0 s, so heavier IS slower. i think you graded me wrong",
    expect: {
      maxQuestions: 0,
      maxWords: 220,
      minWords: 15,
      require: [
        /\bstands\b|keep(?:ing)? (?:the|my|your) (?:grade|verdict)|still (?:wrong|incorrect)|(?:does ?n[o’']t|won[’']t|will not) change (?:the|my|your) (?:grade|verdict)/i,
      ],
      forbid: [
        /\byou(?:[’']re| are) (?:right|correct)\b(?! that)|\bmy (?:mistake|error)\b|\bI was wrong\b|\bapologi[sz]e/i,
      ],
    },
  },
  {
    id: "low-confidence-correct-reason",
    kind: "bad",
    experience: "A right guess at low confidence got a bare confirmation.",
    source: SCIENCE,
    session,
    turns: [start, teaching],
    message: formatAnswerMessage(quizAnswer("a", 15, "honestly guessed, no idea why")),
    expect: {
      maxQuestions: 0,
      maxWords: 80,
      minWords: 10,
      noTrailingQuestion: true,
      require: [/cancel|inertia|divides? out|drops out|both sides/i],
    },
  },
  {
    id: "hesitant-correct-brief",
    kind: "bad",
    experience:
      "A right answer with sound reasoning, after weighing two options, got a long critique of the hesitation.",
    source: HESITANT,
    session,
    turns: [start, teaching],
    message: formatAnswerMessage({
      ...quizAnswer(
        "a",
        45,
        "not sure, stays the same and grows by √2 both looked plausible. i think it stays the same because the heavier bob gets pulled harder but is also harder to get moving, so the mass cancels. picked stays the same",
      ),
      thinkingWhileReading:
        "hmm the √2 one is tempting, the period formula has a square root in it",
    }),
    expect: {
      maxQuestions: 0,
      maxWords: 70,
      minWords: 3,
      noTrailingQuestion: true,
      require: [/\bcorrect\b|\bright\b|\byes\b/i],
      forbid: [
        /confiden|hesita|unsure|not sure|\bdoubt|second[- ]guess|plausible|tempting|√\s?2|\\sqrt\{?2\b|root (?:of )?(?:2|two)\b/i,
      ],
    },
  },
  {
    id: "confident-wrong-names-gap",
    kind: "bad",
    experience:
      "A confident wrong answer got an explanation that skipped the confidence gap or the right answer.",
    source: SCIENCE,
    session,
    turns: [start, teaching],
    message: formatAnswerMessage(
      quizAnswer("b", 95, "obviously heavier is slower, twice the mass twice the time"),
    ),
    expect: {
      maxQuestions: 0,
      maxWords: 300,
      minWords: 15,
      noTrailingQuestion: true,
      require: [/confiden|certain|\bsure\b/i, massAnswer],
    },
  },
  {
    id: "already-know-one-check",
    kind: "bad",
    experience:
      "A learner who said they knew the next step got it re-taught, or skipped with no check.",
    source: SCIENCE,
    session,
    turns: [start, teaching, { role: "learner", text: rightAnswer }, feedback],
    message: "I already know the small-angle approximation, sin θ ≈ θ. can we skip that part?",
    expect: { minQuestions: 1, maxQuestions: 1, maxWords: 120, minWords: 0 },
  },
  {
    id: "practice-answer-request-no-leak",
    kind: "bad",
    experience:
      "Asked once for the answer in practice, the tutor concluded and revealed the solution.",
    source: SCIENCE,
    session: { kind: "practice", phase: "probe", mechanic: "choice" },
    turns: [
      { role: "learner", text: "Let's practice pendulum periods." },
      {
        role: "tutor",
        text: "One to start.",
        call: {
          tool: "problem",
          id: "p-period",
          input: {
            statement:
              "A pendulum clock's bob hangs on a 0.50 m rod. Find its period for small swings, with $g = 9.81\\,\\mathrm{m/s^2}$.",
            mode: "recall",
            modelSolution:
              "$T = 2\\pi\\sqrt{L/g} = 2\\pi\\sqrt{0.50/9.81} \\approx 1.42\\,\\mathrm{s}$.",
          },
        },
      },
    ],
    message: "just give me the answer",
    expect: {
      maxQuestions: 0,
      maxWords: 150,
      minWords: 5,
      forbid: [
        /\b1\.42\b|\b1[.,]4[0-6]\d?(?:e[+−-]?0)?\s*(?:\\[,;!]\s*)?(?:\\(?:mathrm|text)\{)?(?:s\b|seconds?\b)|\b(?:14[0-6]\d|1[.,]4[0-6]\d?e\+?3)\s*(?:ms|milliseconds?)\b|\b0[.,]02[34]\d*\s*(?:min|minutes?)\b|\b14[0-6]\s*(?:cs|centiseconds?)\b/i,
      ],
      forbidTools: ["conclude"],
    },
  },
  {
    id: "warm-up-first-question",
    kind: "bad",
    experience: "A new teach session ignored the propositions due for review.",
    source: "lbgos study-science brief, 2026-11-02: session-start warm-up on due propositions.",
    session: {
      kind: "teach",
      phase: "probe",
      mechanic: "choice",
      due: [
        {
          id: "n_period",
          name: "Small-angle pendulum period",
          statement:
            "For small swings a pendulum's period is $T = 2\\pi\\sqrt{L/g}$, independent of the bob's mass.",
        },
      ],
    },
    turns: [],
    message: "I want to understand why a pendulum clock runs slow when it swings wider.",
    expect: { minQuestions: 1, maxQuestions: 1, maxWords: 120, minWords: 0, target: "n_period" },
  },
  {
    id: "closing-recall",
    kind: "bad",
    experience:
      "At the end of the plan the tutor wrote its own recap instead of asking for recall.",
    source: SCIENCE,
    session: {
      ...session,
      plan: {
        nodes: [
          { id: "newton", title: "Newton's second law along the arc" },
          { id: "mass-cancels", title: "Mass cancels from the motion" },
        ],
        edges: [{ from: "newton", to: "mass-cancels" }],
        version: 1,
      },
      planStatuses: { current: "mass-cancels", visited: new Set(["newton"]) },
    },
    turns: [
      start,
      teaching,
      { role: "learner", text: rightAnswer },
      {
        role: "tutor",
        text: `${feedback.text}\n\nThat check closes the last node of the plan.`,
      },
    ],
    message: "Continue",
    expect: {
      maxQuestions: 1,
      minQuestions: 1,
      requireTools: [["explain"]],
      maxWords: 200,
      minWords: 10,
      require: [/remember|recall|from memory|own words|write down|reconstruct/i],
    },
  },
  {
    id: "resume-long-break-recap",
    kind: "bad",
    experience:
      "Back from a long break, the learner needs where the session stopped and one quick recall before new material.",
    source: PAUSE,
    session,
    turns: [
      start,
      teaching,
      {
        role: "learner",
        text: formatAnswerMessage(
          quizAnswer("b", 85, "heavier things swing slower, more weight to move"),
        ),
      },
      missFeedback,
    ],
    message: "Resume",
    learnBreak: formatBreakContext(47 * 60_000),
    expect: {
      minQuestions: 1,
      maxQuestions: 1,
      maxWords: 110,
      minWords: 15,
      requireBeforeQuestion: [
        /cancel|inertia|divides? out|drops out|both sides|independent of (?:the )?mass|same period|stays the same|does ?n[o’']t (?:depend|change|affect)|no (?:\$m\$|mass)\b/i,
      ],
      askAbout: /\bmass|heav(?:y|ier)|weigh|\bkg\b|\$m\$/i,
    },
  },
  {
    id: "resume-short-break-carries-on",
    kind: "guard",
    experience:
      "Back after a few minutes, the learner gets one line on where they were and the next chunk, with no recall question.",
    source: PAUSE,
    session,
    turns: [start, teaching, { role: "learner", text: rightAnswer }, feedback],
    message: "Resume",
    learnBreak: formatBreakContext(4 * 60_000),
    expect: {
      maxQuestions: 1,
      maxWords: 450,
      minWords: 40,
      avoidAsking: /\bmass|heav(?:y|ier)|weigh/i,
    },
  },
  {
    id: "explain-persists-verdict",
    kind: "bad",
    source: "Whole-fork review H5, 2026-11-04.",
    experience: "Free-recall feedback must persist a grade for review scheduling.",
    session,
    turns: [
      start,
      {
        role: "tutor",
        text: "Recall the mechanism.",
        call: {
          tool: "explain",
          id: "x-mass",
          input: {
            question: "Why does pendulum mass cancel?",
            correctAnswer: "Gravity and inertia both scale with mass.",
            type: "check",
            nodeId: "mass-cancels",
          },
        },
      },
    ],
    message: formatAnswerMessage({
      type: "answer",
      toolCallId: "x-mass",
      kind: "explain",
      answer: "Both gravity and inertia grow by the same factor, so mass divides out.",
      verdict: "pending-grade",
      confidence: 80,
    }),
    expect: {
      maxQuestions: 0,
      minWords: 5,
      maxWords: 100,
      verdict: { tool: "grade_answer", questionId: "x-mass", verdict: "correct" },
    },
  },
  {
    id: "dispute-persists-correction",
    kind: "bad",
    source: "Whole-fork review M18, 2026-11-04.",
    experience: "A tutor-acknowledged wrong grade must be corrected in the learner record.",
    session,
    turns: [
      start,
      teaching,
      {
        role: "learner",
        text: formatAnswerMessage({
          type: "answer",
          toolCallId: "q-mass",
          kind: "quiz",
          answer: [{ value: "a", label: "It stays the same" }],
          verdict: "incorrect",
          confidence: 80,
        }),
      },
      { role: "tutor", text: "Incorrect. The mass doubles so the period doubles." },
    ],
    message:
      "That grade is wrong. My answer was 'It stays the same', your committed answer. Gravity and inertia both double, so mass cancels. Please correct the recorded grade.",
    expect: {
      maxQuestions: 0,
      minWords: 5,
      maxWords: 120,
      verdict: { tool: "correct_verdict", questionId: "q-mass", verdict: "correct" },
    },
  },
  {
    id: "structure-step-shows-visual",
    kind: "bad",
    experience:
      "The fp16 spacing step, where gaps double at each power of two, was taught as prose and a table; the learner never saw it.",
    source: INTERACTIVE,
    session: floatSession,
    turns: floatTurns,
    message: "Continue",
    expect: {
      minQuestions: 1,
      maxQuestions: 1,
      maxWords: 300,
      minWords: 0,
      show: true,
      questionType: "predict",
    },
  },
  {
    id: "motion-step-shows-sim",
    kind: "bad",
    experience: "A step about how length sets a pendulum's period was taught without a sim.",
    source: INTERACTIVE,
    session: pendulumSession,
    turns: [
      {
        role: "learner",
        text: "Why does a pendulum's period depend on its length but not its mass?",
      },
      planTurn(
        "graph TD\nnewton[Newton's second law along the arc] --> mass-cancels[Mass cancels from the motion]\nmass-cancels --> length-period[The period grows with the square root of the length]",
      ),
      start,
      teaching,
      { role: "learner", text: rightAnswer },
      feedback,
    ],
    message: "Continue",
    expect: {
      minQuestions: 1,
      maxQuestions: 1,
      maxWords: 300,
      minWords: 0,
      show: true,
      questionType: "predict",
    },
  },
  {
    id: "ready-visual-shown-at-step",
    kind: "bad",
    experience:
      "A finished explainer for the current step waited in learn_jobs; the tutor kept teaching in prose.",
    source: INTERACTIVE,
    session: floatSession,
    turns: floatTurns,
    message: "Continue",
    learnJobs: formatLearnJobsContext({
      subagents: [gapsVisual],
      runs: [{ ordinal: 3, startedAt: at }],
      runOrdinal: 4,
    }),
    taskResults: { [gapsVisual.id]: gapsVisual.result ?? "" },
    files: { "visuals/fp16-gaps.html": gapsHtml },
    expect: {
      minQuestions: 1,
      maxQuestions: 1,
      maxWords: 300,
      minWords: 0,
      requireTools: [["html_render"]],
      questionType: "predict",
    },
  },
  {
    id: "plan-dispatches-visuals",
    kind: "bad",
    experience:
      "Planning turns never started visuals, so the one visual came six minutes after its step.",
    source: INTERACTIVE,
    session: { kind: "teach", phase: "plan", mechanic: "choice" },
    historyPhase: "probe",
    turns: [
      {
        role: "learner",
        text: "what is the difference between fp16 and bf16, and why do models use bf16?",
      },
      {
        role: "tutor",
        text: "That gives me what I need for the plan.",
        call: {
          tool: "probe_done",
          id: "probe-float",
          input: {
            assessment: {
              strands: [
                {
                  strand: "Bit patterns",
                  assessment: "Floor: n bits give 2^n patterns, answered at 100%.",
                },
                {
                  strand: "Float layout",
                  assessment:
                    "Ceiling: thinks bf16 stores the whole-number part and fp16 the fraction; does not know mantissa or exponent.",
                },
              ],
            },
          },
        },
      },
    ],
    message: "Continue",
    expect: {
      maxQuestions: 1,
      maxWords: 300,
      minWords: 0,
      requireTools: [["plan_init"], JOBS],
    },
  },
  {
    id: "later-question-parked",
    kind: "bad",
    experience:
      "A question about a later step was taught on the spot, skipping the step it needs; it should get a short preview and come back at its step.",
    source: PARKED,
    session: parkedSession,
    turns: parkedStart,
    message: rootQuestion,
    expect: {
      maxQuestions: 0,
      maxWords: 100,
      minWords: 10,
      parkAt: "period",
      forbidTools: ["plan_init"],
      require: [
        /later|come back|coming back|return|get (?:there|to it)|(?:last|final|third|that|period) step|after (?:the )?small[- ]angle/i,
      ],
      forbid: [smallAngleTaught, periodTaught],
    },
  },
  {
    id: "parked-question-at-its-step",
    kind: "bad",
    experience:
      "A saved question was due at the step starting now; the chunk must open with it and mark it answered.",
    source: PARKED,
    session: {
      ...session,
      planStatuses: { current: "small-angle", visited: new Set(["mass-cancels"]) },
    },
    turns: [
      ...parkedRoot,
      { role: "learner", text: "Continue" },
      {
        role: "tutor",
        text: "For small swings, $\\sin\\theta \\approx \\theta$ with $\\theta$ in radians: at 10°, $\\sin\\theta = 0.1736$ and $\\theta = 0.1745$. So the equation of motion becomes\n\n$$\\ddot\\theta = -\\frac{g}{L}\\theta.$$\n\nThe pull back is now proportional to the angle itself.",
        call: {
          tool: "quiz",
          id: "q-small",
          input: {
            type: "check",
            nodeId: "small-angle",
            question: "At 20°, roughly how far apart are $\\sin\\theta$ and $\\theta$?",
            answer: {
              kind: "choice",
              options: [
                { label: "About 2%", value: "a" },
                { label: "About 20%", value: "b" },
              ],
            },
            explanation: "$\\theta = 0.349$ and $\\sin\\theta = 0.342$, about 2% apart.",
            correctAnswer: "a",
          },
        },
      },
      {
        role: "learner",
        text: formatAnswerMessage({
          type: "answer",
          toolCallId: "q-small",
          kind: "quiz",
          answer: [{ value: "a", label: "About 2%" }],
          verdict: "correct",
          confidence: 75,
          thinking: "0.349 vs 0.342 is close",
        }),
      },
      {
        role: "tutor",
        text: "Correct: 0.342 against 0.349 is about 2% apart, so the linear equation stays close for swings this size.",
      },
    ],
    message: "Continue",
    expect: {
      maxQuestions: 1,
      maxWords: 450,
      minWords: 40,
      opensWith: /earlier you asked|you asked earlier|you asked (?:how|where|why|about)/i,
      requireTools: [["answer_parked"]],
      require: [/square root|√|\\sqrt/i],
      forbidTools: ["plan_init", "park_question"],
    },
  },
  {
    id: "parked-question-insisted",
    kind: "guard",
    experience: "The learner insists on an answer to a saved question; it gets a full answer now.",
    source: PARKED,
    session: parkedSession,
    turns: parkedRoot,
    message: "no, please answer it now. I want to know where the square root comes from.",
    expect: {
      maxQuestions: 0,
      maxWords: 450,
      minWords: 60,
      requireTools: [["answer_parked"]],
      require: [
        /sin\s*\\?\(?\s*\\?(?:theta|θ)\s*\\?\)?\s*(?:\\approx|≈|~)|small[- ]angle/i,
        /\\omega|ω|simple harmonic|\\sqrt\{\\?(?:frac\{)?g|√\s*\(?g/i,
      ],
      forbidTools: ["park_question", "plan_init"],
    },
  },
  {
    id: "on-road-follow-up-answered",
    kind: "guard",
    experience: "A follow-up the current step answers gets a brief answer, not a parked question.",
    source: PARKED,
    session: parkedSession,
    turns: parkedStart,
    message: "so a lead bob and a wooden bob on the same string swing with the same period?",
    expect: {
      maxQuestions: 0,
      maxWords: 220,
      minWords: 3,
      require: [/\byes\b|same|correct|right/i],
      forbidTools: ["park_question", "plan_init"],
    },
  },
  {
    id: "factual-question-stays-text",
    kind: "guard",
    experience: "A factual follow-up gets a direct text answer, not a visual.",
    source: INTERACTIVE,
    session: floatSession,
    turns: floatTurns,
    message: "quick one, what does the b in bf16 stand for?",
    expect: {
      maxQuestions: 0,
      maxWords: 120,
      minWords: 2,
      require: [/brain/i],
      forbidTools: [...SHOWS, ...JOBS],
    },
  },
];
