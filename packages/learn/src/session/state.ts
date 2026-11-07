// Ported from learnharness (AGPL-3.0-only) src/core/phases.ts, src/core/plan-blocks.ts, src/core/pending.ts, src/core/native-messages.ts, src/agent/tools/practice.ts @ c549494.
import type { LearnSessionState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  SessionEvent,
  type LearnSessionMeta,
  type SessionPhase,
  type PlanTree,
  type PlanStatuses,
  type ToolCallEvent,
} from "./contracts.ts";
import { parseMermaidPlan } from "./plan.ts";
import { parseLearnerMessage, type AnswerMessage } from "./messages.ts";
import {
  PARKED_AFTER_PLAN,
  validateToolInput,
  type ParkQuestionInput,
  type SessionToolCall,
  type AskInput,
  type QuizInput,
  type ExplainInput,
  type ProblemInput,
} from "./tools.ts";

export type PendingQuestion = {
  readonly id: string;
  readonly toolCallId: string;
  readonly at: string;
} & (
  | { readonly name: "ask"; readonly input: AskInput }
  | { readonly name: "quiz"; readonly input: QuizInput }
  | { readonly name: "explain"; readonly input: ExplainInput }
);
/** A learner question the tutor saved for a later step; its id is the park_question call id. */
export interface ParkedQuestion {
  readonly id: string;
  readonly at: string;
  readonly input: ParkQuestionInput;
}
export interface ActiveProblem {
  readonly id: string;
  readonly toolCallId: string;
  readonly input: ProblemInput;
  readonly at: string;
}
export const PlanBlock = Schema.Struct({
  planCallId: Schema.String,
  at: Schema.String,
  current: Schema.NullOr(Schema.String),
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      status: Schema.Literals(["current", "visited", "upcoming"]),
    }),
  ),
  edges: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
});
export type PlanBlock = typeof PlanBlock.Type;
export interface SessionGate {
  readonly meta?: Pick<LearnSessionMeta, "kind" | "mechanic">;
  readonly graphNodeIds?: ReadonlySet<string> | undefined;
  readonly phase: SessionPhase;
  readonly plan: PlanTree | null;
  readonly questions: ReadonlyMap<string, PendingQuestion>;
  readonly answers: ReadonlyMap<string, AnswerMessage & { readonly verdictReason?: string }>;
  readonly problem: ActiveProblem | null;
  readonly conclusionId: string | null;
  readonly problemDismissed: boolean;
  readonly taggedNodes: readonly string[];
  /** Open parked questions in park order. */
  readonly parked: ReadonlyMap<string, ParkedQuestion>;
  readonly planBlocks: readonly PlanBlock[];
  readonly acceptedCallIds: ReadonlySet<string>;
}
export interface ReplayOptions {
  readonly state?: LearnSessionState | undefined;
  readonly meta?: Pick<LearnSessionMeta, "kind" | "mechanic">;
  readonly graphNodeIds?: ReadonlySet<string> | undefined;
}
function emptyGate(options: ReplayOptions): SessionGate {
  const state = options.state;
  const questions = new Map<string, PendingQuestion>();
  for (const event of state?.questions ?? []) {
    const parsed = validateToolInput(event.name, event.input);
    if (
      parsed.ok &&
      (parsed.call.name === "ask" || parsed.call.name === "quiz" || parsed.call.name === "explain")
    ) {
      const { name, input } = parsed.call;
      questions.set(event.id, {
        id: event.id,
        toolCallId: event.id,
        name,
        input,
        at: event.at,
      } as PendingQuestion);
    }
  }
  const parked = new Map<string, ParkedQuestion>();
  for (const event of state?.parked ?? []) {
    const parsed = validateToolInput(event.name, event.input);
    if (parsed.ok && parsed.call.name === "park_question")
      parked.set(event.id, { id: event.id, at: event.at, input: parsed.call.input });
  }
  const parsedProblem = state?.problem && validateToolInput("problem", state.problem.input);
  return {
    ...options,
    phase: state?.phase ?? "probe",
    plan: state?.plan ?? null,
    questions,
    answers: new Map(),
    problem:
      parsedProblem && parsedProblem.ok && parsedProblem.call.name === "problem" && state?.problem
        ? {
            id: state.problem.id,
            toolCallId: state.problem.id,
            input: parsedProblem.call.input,
            at: state.problem.at,
          }
        : null,
    conclusionId: options.state?.conclusionId ?? null,
    problemDismissed: state?.problemDismissed ?? false,
    taggedNodes: [
      ...(state?.position.visited ?? []),
      ...(state?.position.current ? [state.position.current] : []),
    ],
    parked,
    planBlocks: state?.planBlock ? [state.planBlock] : [],
    acceptedCallIds: new Set([
      ...(state?.questions.map((question) => question.id) ?? []),
      ...parked.keys(),
    ]),
  };
}
export function createSessionGate(
  meta: Pick<LearnSessionMeta, "kind" | "mechanic">,
  events: readonly SessionEvent[] = [],
  graphNodeIds?: ReadonlySet<string>,
): SessionGate {
  return deriveSession(events, { meta, graphNodeIds });
}
function gateProblems(gate: SessionGate, call: SessionToolCall): string[] {
  const problems: string[] = [];
  if (call.name === "grade_answer" || call.name === "correct_verdict") {
    const answer = gate.answers.get(call.input.questionId);
    if (!answer || answer.kind === "ask")
      problems.push("No graded answer exists for this questionId.");
    else if (
      call.name === "grade_answer" &&
      (answer.kind !== "explain" || answer.verdict !== "pending-grade")
    )
      problems.push("grade_answer requires an explain answer awaiting its first grade.");
    else if (call.name === "correct_verdict" && answer.verdict === "pending-grade")
      problems.push("Use grade_answer for the first explain verdict.");
  }
  if (call.name === "quiz" || call.name === "explain") {
    if (gate.meta?.kind === "practice")
      problems.push(
        "Question tools are unavailable in practice; use problem, or ask for an ungraded question.",
      );
    // The saved mechanic is a preference, not a tool permission. A teacher may
    // switch to free recall when the learner asks for it within a teach session.
    if (gate.phase === "probe") {
      if (call.input.type !== undefined || call.input.nodeId !== undefined)
        problems.push("In probe, omit type and nodeId; there is no plan yet.");
    } else if (gate.phase === "plan") {
      problems.push(
        "Graded questions are refused in plan phase; present the dependency map with plan_init first, then wait for the learner's confirmation before teaching.",
      );
    } else {
      if (!call.input.type) problems.push("type is required in teach: predict or check.");
      if (!call.input.nodeId)
        problems.push("nodeId is required in teach; use an exact id from the current plan.");
      else if (!gate.plan?.nodes.some((node) => node.id === call.input.nodeId))
        problems.push(
          `Unknown nodeId "${call.input.nodeId}"; valid ids: ${gate.plan?.nodes.map((node) => node.id).join(", ") ?? "none"}.`,
        );
    }
  }
  if (call.name === "probe_done") {
    if (gate.meta?.kind === "practice")
      problems.push("probe_done is only available in teach sessions.");
    if (gate.phase !== "probe")
      problems.push(
        "The probe is already concluded; probe_done succeeds exactly once, in probe phase.",
      );
    if (gate.questions.size)
      problems.push("A question is still pending; resolve it before probe_done.");
  }
  if (call.name === "plan_init") {
    if (gate.meta?.kind === "practice")
      problems.push("plan_init is only available in teach sessions.");
    if (gate.phase === "probe")
      problems.push("plan_init is refused in probe; complete probe_done first.");
  }
  if (call.name === "problem") {
    if (gate.meta?.kind === "teach")
      problems.push("problem is only available in practice sessions.");
    if (gate.problem)
      problems.push("A problem is already active; conclude it before posing the next one.");
  }
  if (call.name === "quiz" || call.name === "explain" || call.name === "problem") {
    const unknown =
      call.input.target?.filter((id) => gate.graphNodeIds && !gate.graphNodeIds.has(id)) ?? [];
    if (unknown.length)
      problems.push(
        `Unknown target ids: ${unknown.join(", ")}; use graph node ids or omit target when the material is not in the graph.`,
      );
  }
  if (call.name === "park_question") {
    if (gate.meta?.kind === "practice")
      problems.push("park_question is only available in teach sessions.");
    else if (!gate.plan)
      problems.push("park_question needs a plan; answer the question briefly instead.");
    else if (
      call.input.nodeId !== PARKED_AFTER_PLAN &&
      !gate.plan.nodes.some((node) => node.id === call.input.nodeId)
    )
      problems.push(
        `Unknown nodeId "${call.input.nodeId}"; use a plan node id or "${PARKED_AFTER_PLAN}". Valid ids: ${gate.plan.nodes.map((node) => node.id).join(", ")}.`,
      );
  }
  if (call.name === "answer_parked" && !gate.parked.has(call.input.id))
    problems.push(
      `No open parked question has id "${call.input.id}"; open ids: ${[...gate.parked.keys()].join(", ") || "none"}.`,
    );
  if (call.name === "conclude") {
    if (gate.meta?.kind === "teach")
      problems.push("conclude is only available in practice sessions.");
    if (!gate.problem) problems.push("No active problem to conclude; pose one first.");
  }
  return problems;
}
export function validateSessionCall(gate: SessionGate, name: string, input: unknown): string[] {
  const result = validateToolInput(name, input);
  return result.ok ? gateProblems(gate, result.call) : result.problems;
}
function statusesFor(plan: PlanTree, taggedNodes: readonly string[]): PlanStatuses {
  const ids = new Set(plan.nodes.map((node) => node.id));
  const tags: string[] = [];
  for (const id of taggedNodes) {
    if (ids.has(id) && tags.at(-1) !== id) tags.push(id);
  }
  const current = tags.at(-1) ?? null;
  return { current, visited: new Set(tags.slice(0, -1)) };
}
function acceptCall(gate: SessionGate, event: ToolCallEvent, call: SessionToolCall): SessionGate {
  const next = { ...gate, acceptedCallIds: new Set([...gate.acceptedCallIds, event.id]) };
  switch (call.name) {
    case "grade_answer":
    case "correct_verdict": {
      const answers = new Map(gate.answers);
      const answer = answers.get(call.input.questionId);
      if (answer)
        answers.set(call.input.questionId, {
          ...answer,
          verdict: call.input.verdict,
          verdictReason: call.input.reason,
        });
      return { ...next, answers };
    }
    case "ask":
    case "quiz":
    case "explain": {
      const questions = new Map(gate.questions);
      const question = { id: event.id, toolCallId: event.id, at: event.at, ...call };
      questions.set(event.id, question);
      const taggedNodes =
        call.name !== "ask" && call.input.nodeId
          ? [...gate.taggedNodes, call.input.nodeId]
          : gate.taggedNodes;
      return { ...next, questions, taggedNodes };
    }
    case "probe_done":
      return { ...next, phase: "plan" };
    case "plan_init": {
      const parsed = parseMermaidPlan(call.input.mermaid);
      if (!parsed.ok) return gate;
      const plan = { ...parsed.plan, version: (gate.plan?.version ?? 0) + 1 };
      const statuses = statusesFor(plan, gate.taggedNodes);
      const block: PlanBlock = {
        planCallId: event.id,
        at: event.at,
        current: statuses.current,
        nodes: plan.nodes.map((node) => ({
          id: node.id,
          title: node.title,
          status:
            statuses.current === node.id
              ? "current"
              : statuses.visited.has(node.id)
                ? "visited"
                : "upcoming",
        })),
        edges: plan.edges,
      };
      return { ...next, phase: "teach", plan, planBlocks: [...gate.planBlocks, block] };
    }
    case "problem":
      return {
        ...next,
        conclusionId: null,
        problemDismissed: false,
        problem: { id: event.id, toolCallId: event.id, input: call.input, at: event.at },
      };
    case "conclude":
      return { ...next, problem: null, conclusionId: event.id };
    case "park_question": {
      const parked = new Map(gate.parked);
      parked.set(event.id, { id: event.id, at: event.at, input: call.input });
      return { ...next, parked };
    }
    case "answer_parked": {
      const parked = new Map(gate.parked);
      parked.delete(call.input.id);
      return { ...next, parked };
    }
  }
}
const decodeEvent = Schema.decodeUnknownSync(SessionEvent);
/** Apply after execution succeeds. Refused calls return the original gate, so same-turn retries see only successful state. */
export function applySessionEvent(
  gate: SessionGate,
  raw: SessionEvent,
): { readonly gate: SessionGate; readonly problems: string[] } {
  let event: SessionEvent;
  try {
    event = decodeEvent(raw);
  } catch (error) {
    return { gate, problems: [error instanceof Error ? error.message : String(error)] };
  }
  if (event.type === "learner-message") {
    const message = parseLearnerMessage(event.text);
    if (message.type === "next-problem")
      return { gate: { ...gate, conclusionId: null }, problems: [] };
    if (message.type === "dismissed" && message.problemCallId === gate.problem?.id)
      return { gate: { ...gate, problemDismissed: true }, problems: [] };
    if (message.type !== "answer") return { gate, problems: [] };
    const question = gate.questions.get(message.toolCallId);
    if (!question || question.name !== message.kind) return { gate, problems: [] };
    const questions = new Map(gate.questions);
    questions.delete(message.toolCallId);
    const answers = new Map(gate.answers);
    answers.set(message.toolCallId, message);
    return { gate: { ...gate, questions, answers }, problems: [] };
  }
  if (gate.acceptedCallIds.has(event.id)) return { gate, problems: [] };
  const parsed = validateToolInput(event.name, event.input);
  if (!parsed.ok) return { gate, problems: parsed.problems };
  const problems = gateProblems(gate, parsed.call);
  return { gate: problems.length ? gate : acceptCall(gate, event, parsed.call), problems };
}
/** Events must contain accepted calls, or rejected calls that fail these same validators. No tool-result dependency. */
export function deriveSession(
  events: readonly SessionEvent[],
  options: ReplayOptions = {},
): SessionGate {
  let gate = emptyGate(options);
  for (const event of events) gate = applySessionEvent(gate, event).gate;
  return gate;
}
export function derivePhase(
  events: readonly SessionEvent[],
  options?: ReplayOptions,
): SessionPhase {
  return deriveSession(events, options).phase;
}
export function derivePlan(
  events: readonly SessionEvent[],
  options?: ReplayOptions,
): PlanTree | null {
  return deriveSession(events, options).plan;
}
export function derivePlanStatuses(
  plan: PlanTree,
  events: readonly SessionEvent[],
  options?: ReplayOptions,
): PlanStatuses {
  return statusesFor(plan, deriveSession(events, options).taggedNodes);
}
export function pendingQuestion(
  events: readonly SessionEvent[],
  options?: ReplayOptions,
): PendingQuestion | null {
  return [...deriveSession(events, options).questions.values()].at(-1) ?? null;
}
export function activeProblem(
  events: readonly SessionEvent[],
  options?: ReplayOptions,
): ActiveProblem | null {
  return deriveSession(events, options).problem;
}
export function answersById(
  events: readonly SessionEvent[],
  options?: ReplayOptions,
): ReadonlyMap<string, AnswerMessage> {
  return deriveSession(events, options).answers;
}
export function derivePlanBlocks(
  events: readonly SessionEvent[],
  options?: ReplayOptions,
): readonly PlanBlock[] {
  return deriveSession(events, options).planBlocks;
}

/** The last successful new plan call in one supplied turn, excluding calls already in the record. */
export function planBlocksFor(
  record: readonly SessionEvent[],
  turn: readonly SessionEvent[],
  options?: ReplayOptions,
): readonly PlanBlock[] {
  const previous = deriveSession(record, options).acceptedCallIds;
  const incoming = new Set(
    turn.filter((event) => event.type === "tool-call").map((event) => event.id),
  );
  const blocks = derivePlanBlocks([...record, ...turn], options).filter(
    (block) => incoming.has(block.planCallId) && !previous.has(block.planCallId),
  );
  const last = blocks.at(-1);
  return last ? [last] : [];
}

export function sessionReplayState(
  events: readonly SessionEvent[],
  options: ReplayOptions = {},
): LearnSessionState {
  const gate = deriveSession(events, options);
  const position = gate.plan
    ? statusesFor(gate.plan, gate.taggedNodes)
    : { current: null, visited: new Set<string>() };
  return {
    phase: gate.phase,
    plan: gate.plan,
    position: { current: position.current, visited: [...position.visited] },
    questions: [...gate.questions.values()].map((question) => ({
      id: question.id,
      name: question.name,
      input: question.input,
      at: question.at,
    })),
    problem: gate.problem
      ? { id: gate.problem.id, name: "problem", input: gate.problem.input, at: gate.problem.at }
      : null,
    conclusionId: gate.conclusionId,
    problemDismissed: gate.problemDismissed,
    planBlock: gate.planBlocks.at(-1) ?? null,
    parked: [...gate.parked.values()].map((parked) => ({
      id: parked.id,
      name: "park_question",
      input: parked.input,
      at: parked.at,
    })),
  };
}
