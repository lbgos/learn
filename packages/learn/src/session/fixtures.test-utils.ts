import type { SessionEvent, QuizInput, ConcludeInput } from "./index.ts";

export const teach = { kind: "teach", mechanic: "choice" } satisfies {
  kind: "teach";
  mechanic: "choice";
};
export const practice = { kind: "practice", mechanic: "choice" } satisfies {
  kind: "practice";
  mechanic: "choice";
};
export const quiz: QuizInput = {
  question: "What is 2+2?",
  answer: {
    kind: "choice",
    options: [
      { label: "Four", value: "4" },
      { label: "Five", value: "5" },
    ],
  },
  explanation: "Add two pairs.",
  correctAnswer: "4",
};
export const numberQuiz: QuizInput = {
  question: "Speed?",
  answer: { kind: "number", unit: "m/s" },
  explanation: "Distance divided by time.",
  correctAnswer: 10,
};
export const assessment = {
  assessment: {
    strands: [{ strand: "Arithmetic", assessment: "Floor: adds. Ceiling: does not multiply." }],
  },
};
export const problem = {
  statement: "Find 2+2.",
  mode: "recall",
  target: ["addition"],
  modelSolution: "4.",
};
export const conclusion: ConcludeInput = {
  outcome: "solved",
  verdict: "Added correctly.",
  rung: null,
  missClass: null,
  retest: false,
};
export function call(id: string, name: string, input: unknown): SessionEvent {
  return { type: "tool-call", id, name, input, at: "2026-10-24T12:00:00Z" };
}
export function message(id: string, text: string): SessionEvent {
  return { type: "learner-message", id, text, at: "2026-10-24T12:01:00Z" };
}
export const planEvents = [
  call("done", "probe_done", assessment),
  call("plan", "plan_init", {
    mermaid: "graph TD\na[Addition] --> b[Multiplication]\nb --> c[Division]",
  }),
];
