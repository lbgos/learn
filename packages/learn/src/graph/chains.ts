// Ported from learnharness (AGPL-3.0-only) src/core/chains.ts @ c549494.
import type { GraphNode } from "./model.ts";
import { stripModelValueDebris } from "./value-debris.ts";

export interface ReasoningChain {
  id: string;

  premises: readonly string[];

  conclusion: string;
}

export function chainsForSelection(
  nodes: ReadonlyArray<Pick<{ id: string }, "id">>,
  chains: ReadonlyArray<
    Pick<
      { id: string; premises: readonly string[]; conclusion: string },
      "id" | "premises" | "conclusion"
    >
  >,
): ReasoningChain[] {
  const selected = new Set(nodes.map((n) => n.id));
  const chained = new Set<string>();
  const included: ReasoningChain[] = [];
  for (const chain of chains) {
    if (!selected.has(chain.conclusion)) continue;
    if (!chain.premises.every((premise) => selected.has(premise))) continue;
    included.push({
      id: chain.id,
      premises: [...chain.premises].sort(),
      conclusion: chain.conclusion,
    });
    chained.add(chain.conclusion);
    for (const premise of chain.premises) chained.add(premise);
  }
  for (const node of nodes) {
    if (!chained.has(node.id)) {
      included.push({ id: node.id, premises: [], conclusion: node.id });
    }
  }
  return included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function resolveTargetId(
  target: string,
  nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
): string | null {
  const t = stripModelValueDebris(target);
  if (t.length === 0) return null;
  if (nodes.some((n) => n.id === t)) return t;
  const lower = t.toLowerCase();
  for (const n of nodes) {
    if (stripModelValueDebris(n.name).toLowerCase() === lower) return n.id;
  }
  return null;
}

export function formatChainLine(
  chain: Pick<ReasoningChain, "premises" | "conclusion">,
  propositions: Readonly<Record<string, { name: string }>>,
): string {
  const nameOf = (id: string) => propositions[id]?.name ?? id;
  const premises = [...chain.premises].sort().map(nameOf).join(", ");
  return premises !== ""
    ? `${premises} → ${nameOf(chain.conclusion)}`
    : `${nameOf(chain.conclusion)} (no premises)`;
}
