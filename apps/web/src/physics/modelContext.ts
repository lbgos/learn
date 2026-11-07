import {
  derivePlanStatuses,
  deriveSession,
  formatSessionContext,
  type LearnSessionMeta,
  type SessionEvent,
} from "@t3tools/learn/session";
/**
 * Text the model receives with the learner's next message (`physics.setModelContext`). One note
 * per open surface, keyed `physics:sim:<path>` / `physics:board:<name>`; empty text removes it.
 */
import type { BoardItem } from "@t3tools/physics/board";
import type { SimMeta } from "@t3tools/physics/sim";

export const simContextKey = (path: string) => `physics:sim:${path}` as const;
export const boardContextKey = (name: string) => `physics:board:${name}` as const;

/** Four significant digits, without trailing zeros or exponent noise for ordinary values. */
export function formatQuantity(value: number): string {
  return String(Number(value.toPrecision(4)));
}

export interface SimParamChange {
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

const withUnit = (meta: SimMeta, name: string, value: number) => {
  const unit = meta.params[name]?.unit;
  return `${formatQuantity(value)}${unit ? ` ${unit}` : ""}`;
};

export function simContextText(input: {
  readonly path: string;
  readonly meta: SimMeta;
  readonly params: Readonly<Record<string, number>>;
  readonly t: number;
  readonly playing: boolean;
  readonly lastChange: SimParamChange | null;
}): string {
  const { meta, params } = input;
  const values = Object.entries(params)
    .map(([name, value]) => `${name}=${withUnit(meta, name, value)}`)
    .join(", ");
  const state = input.playing ? "playing" : `t=${formatQuantity(input.t)} s, paused`;
  const change = input.lastChange
    ? ` Last change: ${input.lastChange.name} ${formatQuantity(input.lastChange.from)} → ${withUnit(meta, input.lastChange.name, input.lastChange.to)}.`
    : "";
  return `Learner has ${input.path} open.${values ? ` ${values}.` : ""} ${state}.${change}`;
}

/** What the learner changed on a board since the agent last wrote to it. */
export interface BoardEditTally {
  readonly added: Readonly<Partial<Record<BoardItem["kind"], number>>>;
  readonly updated: number;
  readonly removed: number;
}

export const EMPTY_BOARD_TALLY: BoardEditTally = { added: {}, updated: 0, removed: 0 };

function boardTallyIsEmpty(tally: BoardEditTally): boolean {
  return tally.updated === 0 && tally.removed === 0 && Object.keys(tally.added).length === 0;
}

const NOUNS: Record<BoardItem["kind"], readonly [singular: string, plural: string]> = {
  ink: ["new stroke", "new strokes"],
  text: ["text item", "text items"],
  math: ["math item", "math items"],
  shape: ["shape", "shapes"],
  plot: ["plot", "plots"],
  image: ["image", "images"],
  table: ["table", "tables"],
};

/** Empty when nothing changed, which removes the note. */
export function boardContextText(input: {
  readonly name: string;
  readonly revision: number;
  readonly tally: BoardEditTally;
}): string {
  const { tally } = input;
  if (boardTallyIsEmpty(tally)) return "";
  const parts = (Object.keys(NOUNS) as BoardItem["kind"][]).flatMap((kind) => {
    const count = tally.added[kind];
    return count ? [`${count} ${NOUNS[kind][count === 1 ? 0 : 1]}`] : [];
  });
  if (tally.updated > 0) parts.push(`${tally.updated} moved or edited`);
  if (tally.removed > 0) parts.push(`${tally.removed} erased`);
  return `Learner edited board ${input.name} (rev ${input.revision}): ${parts.join(", ")} since the agent's last write.`;
}

export const sessionContextKey = "physics:session";

/** The existing context-note publisher sends this together with sim and board notes. */
export function sessionContextText(input: {
  readonly events: readonly SessionEvent[];
  readonly kind: LearnSessionMeta["kind"];
  readonly mechanic: LearnSessionMeta["mechanic"];
}): string {
  const session = deriveSession(input.events);
  const planStatuses = session.plan ? derivePlanStatuses(session.plan, input.events) : undefined;
  const lines = [
    formatSessionContext({
      includeInstructions: true,
      kind: input.kind,
      mechanic: input.mechanic,
      phase: session.phase,
      plan: session.plan,
      ...(planStatuses ? { planStatuses } : {}),
    }),
  ];
  const pending = [...session.questions.values()].at(-1);
  if (pending)
    lines.push(`pending question: ${pending.id} (${pending.name}): ${pending.input.question}`);
  if (session.problem)
    lines.push(`active problem: ${session.problem.id}: ${session.problem.input.statement}`);
  return lines.join("\n");
}

export const visualContextKey = (path: string) => `physics:visual:${path}` as const;

export function visualContextText(input: {
  readonly path: string;
  readonly step: number;
  readonly labels: readonly string[];
  readonly t: number;
  readonly playing: boolean;
}): string {
  return `Learner has ${input.path} open at step ${input.step} of ${input.labels.length} (zero-based): ${input.labels[input.step] ?? "unknown"}. t=${formatQuantity(input.t)}, ${input.playing ? "playing" : "paused"}.`;
}
