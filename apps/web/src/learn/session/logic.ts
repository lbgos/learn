// Ported from learnharness (AGPL-3.0-only) components/question-dock.tsx, components/practice-dock.tsx, components/phase-divider.tsx @ c549494.
import {
  applySessionEvent,
  buildAnswer,
  derivePlanStatuses,
  deriveSession,
  formatAnswerMessage,
  formatLearnerSignal,
  parseLearnerMessage,
  shuffleOptions,
  validateToolInput,
  type ConcludeInput,
  type AnswerMessage,
  type AnswerRequest,
  type LearnSessionMeta,
  type ParkedQuestion,
  type PendingQuestion,
  type SessionEvent,
  type ReplayOptions,
} from "@t3tools/learn/session";

export type SessionKind = LearnSessionMeta["kind"];

export function questionOptions(question: PendingQuestion) {
  if (question.name === "quiz" && question.input.answer.kind === "choice")
    return shuffleOptions(
      question.input.answer.options.map((option) => ({
        ...option,
        value: option.value.trim(),
        description: undefined,
      })),
      question.id,
    );
  if (question.name === "ask")
    return shuffleOptions(
      (question.input.options ?? []).map((option) => ({
        ...option,
        value: option.label,
      })),
      question.id,
    );
  return [];
}
export function questionIsMultiSelect(question: PendingQuestion): boolean {
  return question.name === "ask"
    ? question.input.multiSelect === true
    : question.name === "quiz" &&
        question.input.answer.kind === "choice" &&
        question.input.answer.multiSelect === true;
}
export function buildQuestionMessage(question: PendingQuestion, request: AnswerRequest): string {
  const answerable =
    question.name === "ask"
      ? { kind: question.name, input: question.input }
      : question.name === "quiz"
        ? { kind: question.name, input: question.input }
        : { kind: question.name, input: question.input };
  return formatAnswerMessage(buildAnswer(question.id, answerable, request));
}

export type PracticeAction = "hint" | "check" | "stuck" | "work" | "dismiss";
export function practiceMessage(id: string, action: PracticeAction, work: string): string {
  if (action === "dismiss") return formatLearnerSignal({ type: "dismissed", problemCallId: id });
  const instruction =
    action === "hint"
      ? "Give me a hint."
      : action === "check"
        ? "Check my answer."
        : action === "stuck"
          ? "I'm stuck."
          : "";
  return formatLearnerSignal({
    type: "thinking",
    problemCallId: id,
    text: [instruction, work.trim()].filter(Boolean).join("\n\n"),
  });
}

/** Display copy only; outgoing messages retain their learner control tokens. */
export function learnerMessageText(text: string): string | null {
  const message = parseLearnerMessage(text);
  switch (message.type) {
    case "answer":
      return null;
    case "thinking":
      return message.text;
    case "next-problem":
      return "Next problem";
    case "dismissed":
      return "Dismissed problem";
    case "plain":
      return message.text;
  }
}

export function learnDockState(
  events: readonly SessionEvent[],
  kind: SessionKind,
  options: ReplayOptions = {},
) {
  const session = deriveSession(events, options);
  const question = [...session.questions.values()].at(-1) ?? null;
  if (question) return { type: "question", question } as const;
  if (kind !== "practice") return null;
  const problem = session.problem;
  if (problem) {
    return { type: "problem", problem, dismissed: session.problemDismissed } as const;
  }
  return session.conclusionId ? ({ type: "paused", id: session.conclusionId } as const) : null;
}

export function learnPhase(
  events: readonly SessionEvent[],
  kind: SessionKind,
  options: ReplayOptions = {},
): string {
  const session = deriveSession(events, options);
  if (kind === "teach") return session.phase;
  if (session.problem) return "problem active";
  return learnDockState(events, kind, options)?.type === "paused" ? "paused" : "practice";
}

export type LearnTimelineItem =
  | {
      readonly kind: "problem";
      readonly id: string;
      readonly anchorId: string;
      readonly eventIndex: number;
      readonly statement: string;
      readonly active: boolean;
    }
  | {
      readonly kind: "conclusion";
      readonly id: string;
      readonly anchorId: string;
      readonly eventIndex: number;
      readonly input: ConcludeInput;
      readonly solution: string;
    }
  | {
      readonly kind: "question";
      readonly id: string;
      readonly anchorId: string;
      readonly eventIndex: number;
      readonly question: PendingQuestion;
      readonly answer: (AnswerMessage & { readonly verdictReason?: string }) | undefined;
    }
  | {
      readonly kind: "plan";
      readonly id: string;
      readonly anchorId: string;
      readonly eventIndex: number;
      readonly block: ReturnType<typeof deriveSession>["planBlocks"][number];
      /** Open parked questions; only the latest plan carries them. */
      readonly parked: readonly ParkedQuestion[];
    }
  | {
      readonly kind: "parked";
      readonly id: string;
      readonly anchorId: string;
      readonly eventIndex: number;
      readonly parked: ParkedQuestion;
      /** The plan step it returns at, or null for after the plan. */
      readonly step: string | null;
    }
  | {
      readonly kind: "recalled";
      readonly id: string;
      readonly anchorId: string;
      readonly eventIndex: number;
      /** The parked question this run answers, as the learner asked it. */
      readonly question: string;
    }
  | {
      readonly kind: "phase";
      readonly id: string;
      readonly anchorId: string;
      readonly eventIndex: number;
      readonly phase: string;
    }
  | {
      readonly kind: "graph-context";
      readonly id: string;
      readonly anchorId: string;
      readonly eventIndex: number;
      readonly text: string;
    };

/** Anchor before the successful tool call, or replace the first graph-context user message. */
export function learnTimelineItems(
  events: readonly SessionEvent[],
  kind: SessionKind = "teach",
  options: ReplayOptions = {},
): LearnTimelineItem[] {
  const final = deriveSession(events, options);
  const dock = learnDockState(events, kind, options);
  const statuses = final.plan ? derivePlanStatuses(final.plan, events, options) : null;
  let gate = deriveSession([], options);
  let previousPhase = learnPhase([], kind, options);
  let firstUser = true;
  const items: LearnTimelineItem[] = [...gate.questions.values()].map((question) => ({
    kind: "question",
    id: `learn:question:${question.id}`,
    anchorId: question.id,
    eventIndex: -1,
    question,
    answer: final.answers.get(question.id),
  }));
  events.forEach((event, eventIndex) => {
    const next = applySessionEvent(gate, event).gate;
    const anchor = { anchorId: event.id, eventIndex };
    if (event.type === "learner-message" && firstUser) {
      firstUser = false;
      if (/^\[graph context\](?:\r?\n|$)/.test(event.text))
        items.push({
          kind: "graph-context",
          id: `learn:graph:${event.id}`,
          ...anchor,
          text: event.text.replace(/^\[graph context\]\r?\n?/, ""),
        });
    }
    const phase =
      kind === "teach"
        ? next.phase
        : next.problem
          ? "problem active"
          : event.type === "tool-call" && event.name === "conclude" && next !== gate
            ? "paused"
            : previousPhase === "paused" &&
                event.type === "learner-message" &&
                parseLearnerMessage(event.text).type === "next-problem"
              ? "practice"
              : previousPhase;
    if (phase !== previousPhase)
      items.push({ kind: "phase", id: `learn:phase:${event.id}`, ...anchor, phase });
    previousPhase = phase;
    if (event.type === "tool-call" && next !== gate && !gate.acceptedCallIds.has(event.id)) {
      if (event.name === "problem" && next.problem)
        items.push({
          kind: "problem",
          id: `learn:problem:${event.id}`,
          ...anchor,
          statement: next.problem.input.statement,
          active: dock?.type === "problem" && !dock.dismissed && dock.problem.id === event.id,
        });
      if (event.name === "conclude" && gate.problem) {
        const parsed = validateToolInput(event.name, event.input);
        if (parsed.ok && parsed.call.name === "conclude")
          items.push({
            kind: "conclusion",
            id: `learn:conclusion:${event.id}`,
            ...anchor,
            input: parsed.call.input,
            solution: gate.problem.input.modelSolution,
          });
      }
      const parked = next.parked.get(event.id);
      if (parked)
        items.push({
          kind: "parked",
          id: `learn:parked:${event.id}`,
          ...anchor,
          parked,
          step: next.plan?.nodes.find((node) => node.id === parked.input.nodeId)?.title ?? null,
        });
      const answered = [...gate.parked.values()].find((open) => !next.parked.has(open.id));
      if (answered)
        items.push({
          kind: "recalled",
          id: `learn:recalled:${event.id}`,
          ...anchor,
          question: answered.input.question,
        });
      const question = next.questions.get(event.id);
      if (question)
        items.push({
          kind: "question",
          id: `learn:question:${event.id}`,
          ...anchor,
          question,
          answer: final.answers.get(event.id),
        });
      const block = final.planBlocks.find((block) => block.planCallId === event.id);
      if (block)
        items.push({
          kind: "plan",
          id: `learn:plan:${event.id}`,
          ...anchor,
          parked: block === final.planBlocks.at(-1) ? [...final.parked.values()] : [],
          block:
            statuses && block === final.planBlocks.at(-1)
              ? {
                  ...block,
                  current: statuses.current,
                  nodes: block.nodes.map((node) => ({
                    ...node,
                    status:
                      statuses.current === node.id
                        ? "current"
                        : statuses.visited.has(node.id)
                          ? "visited"
                          : "upcoming",
                  })),
                }
              : block,
        });
    }
    gate = next;
  });
  return items;
}
