// Ported from learnharness (AGPL-3.0-only) src/core/session-clusters.ts @ c549494.
import type { GraphChain, GraphNode } from "./model.ts";

export interface BirthSessionCluster {
  id: string;

  members: string[];
}

export function birthSessionOf(node: Pick<GraphNode, "provenance">): string | null {
  return node.provenance[0]?.chatId ?? null;
}

export function birthSessionPartition(nodes: readonly GraphNode[]): BirthSessionCluster[] {
  const members = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const birth = birthSessionOf(node);
    if (birth === null) continue;
    const bucket = members.get(birth);
    if (bucket) bucket.push(node.id);
    else members.set(birth, [node.id]);
  }
  return [...members.entries()]
    .map(([id, list]) => ({ id, members: [...list].sort() }))
    .sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1));
}

export function impClusterKey(
  chain: Pick<GraphChain, "premises" | "provenance">,
  birthOf: (nodeId: string) => string | null,
): string | null {
  const counts = new Map<string, number>();
  for (const premise of chain.premises) {
    const birth = birthOf(premise);
    if (birth !== null) counts.set(birth, (counts.get(birth) ?? 0) + 1);
  }
  const own = chain.provenance[0]?.chatId ?? null;
  if (counts.size === 0) return own;
  let max = 0;
  for (const n of counts.values()) if (n > max) max = n;
  const winners: string[] = [];
  for (const [key, n] of counts) if (n === max) winners.push(key);
  if (winners.length === 1) return winners[0]!;
  return own ?? winners.sort()[0]!;
}

export function attachImpToCommunities(
  communities: Array<{ id: string; members: string[] }>,
  propositions: ReadonlyArray<Pick<GraphNode, "id" | "provenance">>,
  chains: ReadonlyArray<Pick<GraphChain, "id" | "premises" | "conclusion" | "provenance">>,
): void {
  const birthById = new Map(propositions.map((node) => [node.id, birthSessionOf(node)]));
  const live = new Set(propositions.map((node) => node.id));
  for (const chain of chains) {
    if (chain.premises.length < 2) continue;
    if (!live.has(chain.conclusion) || !chain.premises.every((p) => live.has(p))) continue;
    const key = impClusterKey(chain, (id) => birthById.get(id) ?? null);
    const community = key === null ? undefined : communities.find((c) => c.id === key);
    if (!community) continue;
    community.members.push(chain.id);
  }
  for (const community of communities) community.members.sort();
}
