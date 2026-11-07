import type { PendingQuestion, SessionEvent, ToolCallEvent } from "@t3tools/learn/session";

export const at = "2026-10-24T12:00:00Z";
export const choice = {
  id: "choice-1",
  toolCallId: "choice-1",
  at,
  name: "quiz",
  input: {
    question: "Which force?",
    answer: {
      kind: "choice",
      options: [
        { label: "Gravity", value: "gravity" },
        { label: "Friction", value: "friction" },
        { label: "Tension", value: "tension" },
        { label: "Normal", value: "normal" },
      ],
    },
    correctAnswer: "gravity",
    explanation: "Mass attracts mass.",
  },
} satisfies PendingQuestion;
export const numberQuestion = {
  id: "number-1",
  toolCallId: "number-1",
  at,
  name: "quiz",
  input: {
    question: "Period?",
    answer: { kind: "number", unit: "s", tolerance: 0.05 },
    correctAnswer: 2,
    explanation: "The period is two seconds.",
  },
} satisfies PendingQuestion;
export function call(question: PendingQuestion): ToolCallEvent {
  return { type: "tool-call", id: question.id, name: question.name, input: question.input, at };
}
export const problem: SessionEvent = {
  type: "tool-call",
  id: "p1",
  name: "problem",
  at,
  input: { statement: "Find the acceleration.", mode: "composition", modelSolution: "F/m" },
};
export const conclude: SessionEvent = {
  type: "tool-call",
  id: "c1",
  name: "conclude",
  at,
  input: { outcome: "solved", verdict: "Solved.", rung: "R2", missClass: null, retest: false },
};
export const message = (text: string): SessionEvent => ({
  type: "learner-message",
  id: "m1",
  at,
  text,
});
