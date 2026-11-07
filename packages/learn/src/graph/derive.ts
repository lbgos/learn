// Ported from learnharness (AGPL-3.0-only) src/core/graph.ts @ c549494.
import type { GraphLedgers, GraphNode, GraphChain, GraphEdge, ProvenancePoint } from "./model.ts";
import { formatChainLine } from "./chains.ts";
export function chainKey(premises: ReadonlyArray<string>, conclusion: string): string {
  return JSON.stringify([[...new Set(premises)].sort(), conclusion]);
}
const samePoint = (a: ProvenancePoint, b: ProvenancePoint) =>
  a.chatId === b.chatId && a.messageId === b.messageId;
/** Drop an argument only when its premises derive its conclusion through the retained arguments. */
export function simplifyChains(lines: readonly GraphChain[]): GraphChain[] {
  if (lines.length < 2) return [...lines];

  const groups = new Map<string, GraphChain[]>();
  for (const line of lines) {
    const key = chainKey(line.premises, line.conclusion);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [line]);
    else bucket.push(line);
  }

  const candidates = [...groups.entries()].map(([key, bucket]) => ({ key, chain: bucket[0]! }));
  candidates.sort(
    (a, b) =>
      b.chain.premises.length - a.chain.premises.length ||
      b.chain.createdAt.localeCompare(a.chain.createdAt) ||
      a.key.localeCompare(b.key),
  );
  const droppedKeys = new Set<string>();
  for (const candidate of candidates) {
    const known = new Set(candidate.chain.premises);
    let remaining = candidates.filter(
      (other) => other.key !== candidate.key && !droppedKeys.has(other.key),
    );
    let changed = true;
    while (changed && !known.has(candidate.chain.conclusion)) {
      changed = false;
      remaining = remaining.filter(({ chain }) => {
        if (!chain.premises.every((premise) => known.has(premise))) return true;
        if (!known.has(chain.conclusion)) {
          known.add(chain.conclusion);
          changed = true;
        }
        return false;
      });
    }
    if (known.has(candidate.chain.conclusion)) droppedKeys.add(candidate.key);
  }
  if (droppedKeys.size === 0) return [...lines];
  return lines.filter((line) => !droppedKeys.has(chainKey(line.premises, line.conclusion)));
}

export interface DerivedGraph {
  nodes: readonly GraphNode[];
  chains: readonly GraphChain[];
}

/** First node line defines identity; later lines union phrasings and provenance. */
export function getGraph(ledgers: Pick<GraphLedgers, "nodes" | "chains">): DerivedGraph {
  const byId = new Map<
    string,
    Omit<GraphNode, "aliases" | "provenance"> & { aliases: string[]; provenance: ProvenancePoint[] }
  >();
  for (const line of ledgers.nodes) {
    const existing = byId.get(line.id);
    if (!existing) {
      byId.set(line.id, {
        ...line,
        aliases: [...line.aliases],
        provenance: line.provenance.map((point) => ({ ...point, at: point.at ?? line.createdAt })),
      });
      continue;
    }
    for (const phrasing of [line.statement, ...line.aliases]) {
      if (phrasing.length > 0 && !existing.aliases.includes(phrasing))
        existing.aliases.push(phrasing);
    }
    for (const point of line.provenance) {
      const pt = { ...point, at: point.at ?? line.createdAt };
      const prior = existing.provenance.find((q) => samePoint(q, pt));
      if (!prior) existing.provenance.push(pt);
      else if (Date.parse(pt.at) < Date.parse(prior.at ?? line.createdAt))
        existing.provenance[existing.provenance.indexOf(prior)] = pt;
    }
  }

  const chains: GraphChain[] = [];
  const byKey = new Map<
    string,
    Omit<GraphChain, "provenance"> & { provenance: ProvenancePoint[] }
  >();
  for (const line of ledgers.chains) {
    const key = chainKey(line.premises, line.conclusion);
    const existing = byKey.get(key);
    if (existing) {
      for (const pt of line.provenance) {
        if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
      }
    } else {
      const chain = { ...line, premises: [...line.premises], provenance: [...line.provenance] };
      byKey.set(key, chain);
      chains.push(chain);
    }
  }
  return { nodes: [...byId.values()], chains };
}

/** Single-premise arguments are direct arrows; multi-premise arguments get arg_ junctions. */
export function deriveView(graph: DerivedGraph): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  logicalEdges: GraphEdge[];
  impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
} {
  const names: Record<string, { name: string }> = {};
  for (const node of graph.nodes) names[node.id] = { name: node.name };
  const live = new Set(graph.nodes.map((node) => node.id));
  const impNodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const impLinks: Array<{ id: string; premises: string[]; conclusion: string }> = [];
  const logicalEdges: GraphEdge[] = [];
  const logicalSeen = new Set<string>();
  const emitLogical = (from: string, to: string): void => {
    const key = from + "\u0000" + to;
    if (logicalSeen.has(key)) return;
    logicalSeen.add(key);
    logicalEdges.push({ from, to });
  };
  for (const chain of graph.chains) {
    if (
      chain.premises.length === 0 ||
      !live.has(chain.conclusion) ||
      !chain.premises.every((premise) => live.has(premise))
    )
      continue;
    for (const premise of chain.premises) emitLogical(premise, chain.conclusion);
    if (chain.premises.length === 1) {
      edges.push({ from: chain.premises[0]!, to: chain.conclusion });
      continue;
    }
    impNodes.push({
      id: chain.id,
      name: "⟹",
      statement: formatChainLine(chain, names),
      aliases: [],
      createdAt: chain.createdAt,
      provenance: [...chain.provenance],
    });
    impLinks.push({ id: chain.id, premises: [...chain.premises], conclusion: chain.conclusion });
    for (const premise of chain.premises) edges.push({ from: premise, to: chain.id });
    edges.push({ from: chain.id, to: chain.conclusion });
  }
  return { nodes: [...graph.nodes, ...impNodes], edges, logicalEdges, impLinks };
}

export type DerivedView = ReturnType<typeof deriveView>;
