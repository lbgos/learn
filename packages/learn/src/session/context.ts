import { practiceInstructions, teachInstructions } from "../tutor/instructions.ts";
import type { LearnSessionMeta, SessionPhase, PlanTree, PlanStatuses } from "./contracts.ts";
import type { ParkedQuestion } from "./state.ts";
import { PARKED_AFTER_PLAN } from "./tools.ts";

/** Plain lines like simContextText/boardContextText; the caller puts them in the shared model-context block. */
export function formatSessionContext(input: {
  readonly kind: LearnSessionMeta["kind"];
  readonly phase: SessionPhase;
  readonly mechanic: LearnSessionMeta["mechanic"];
  readonly plan?: PlanTree | null;
  readonly planStatuses?: PlanStatuses;
  /** Graph propositions due for review, most overdue first; teach sessions warm up on them. */
  readonly due?: readonly {
    readonly id: string;
    readonly name: string;
    readonly statement: string;
  }[];
  /** Include kind doctrine when publishing the session model-context note. */
  readonly includeInstructions?: boolean;
}): string {
  const lines = [`session: ${input.kind}`];
  const instructions = input.includeInstructions
    ? `\n\n${input.kind === "teach" ? teachInstructions : practiceInstructions}`
    : "";
  if (input.kind === "practice") return lines.join("\n") + instructions;
  lines.push(
    `phase: ${input.phase}`,
    `mechanic: ${input.mechanic} (preferred; quiz and explain are both available)`,
  );
  if (input.plan) {
    const ids = new Set(input.plan.nodes.map((node) => node.id));
    const current = input.planStatuses?.current;
    const visited = [...(input.planStatuses?.visited ?? [])].filter(
      (id) => ids.has(id) && id !== current,
    );
    lines.push(
      `plan: current ${current && ids.has(current) ? current : "none"}; visited ${visited.join(", ") || "none"}`,
    );
  }
  if (input.due?.length)
    lines.push(
      "due for review:",
      ...input.due.map(
        (node) => `- ${node.id} | ${node.name}: ${node.statement.replace(/\s+/g, " ").trim()}`,
      ),
    );
  return lines.join("\n") + instructions;
}

/**
 * When a parked question comes back. Its step is due once reached, or next once every
 * prerequisite is reached; after-plan questions, and those whose node left the plan, once
 * every node is reached. Reached means tagged by a question: current or visited.
 */
export function parkedQuestionDue(
  plan: PlanTree,
  statuses: PlanStatuses,
  nodeId: string,
): "now" | "next" | "later" {
  const reached = (id: string) => id === statuses.current || statuses.visited.has(id);
  if (nodeId === PARKED_AFTER_PLAN || !plan.nodes.some((node) => node.id === nodeId))
    return plan.nodes.every((node) => reached(node.id)) ? "now" : "later";
  if (reached(nodeId)) return "now";
  return plan.edges.every((edge) => edge.to !== nodeId || reached(edge.from)) ? "next" : "later";
}

const dueLabels = { now: "due now", next: "due at the next step", later: "later" } as const;

/** Open parked questions for the per-turn learn_session block; empty when none are open. */
export function formatParkedContext(input: {
  readonly plan: PlanTree | null;
  readonly planStatuses: PlanStatuses;
  readonly parked: Iterable<ParkedQuestion>;
}): string {
  const lines = [...input.parked].map(({ id, input: parked }) => {
    const place =
      input.plan?.nodes.some((node) => node.id === parked.nodeId) === true
        ? `step ${parked.nodeId}`
        : "after the plan";
    const due = input.plan
      ? dueLabels[parkedQuestionDue(input.plan, input.planStatuses, parked.nodeId)]
      : "later";
    return `- ${id} | ${place}, ${due} | ${parked.question.replace(/\s+/g, " ").trim()}`;
  });
  return lines.length ? ["parked questions:", ...lines].join("\n") : "";
}

/** Server-owned context key for the first turn after a pause. */
export const LEARN_BREAK_CONTEXT_KEY = "learn_break";
/** A break at least this long gets a recap and a recall question; a shorter one a single line. */
export const LONG_BREAK_MINUTES = 10;

export function formatBreakContext(breakMs: number): string {
  const minutes = Math.max(1, Math.floor(breakMs / 60_000));
  const length =
    minutes < 90
      ? `${minutes} min`
      : minutes < 48 * 60
        ? `${Math.round(minutes / 60)} h`
        : `${Math.round(minutes / 1440)} days`;
  const kind = breakMs < LONG_BREAK_MINUTES * 60_000 ? "short" : "long";
  return `The learner paused the session and is back after ${length}: a ${kind} break.`;
}
