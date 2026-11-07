// Ported from learnharness (AGPL-3.0-only) src/core/layout-settle.ts @ c549494.
import type { GraphLedgers } from "./model.ts";
import { getGraph, deriveView } from "./derive.ts";
import { incrementalLayout, type IncrementalLayoutOptions } from "./layout.ts";
import { attachImpToCommunities, birthSessionPartition } from "./session-clusters.ts";
/** Return the complete replacement positions ledger, including the empty-graph case. */
export function settleGraphLayout(
  ledgers: Pick<GraphLedgers, "nodes" | "chains" | "positions">,
  options: IncrementalLayoutOptions = {},
) {
  const graph = getGraph(ledgers);
  const view = deriveView(graph);
  const clusters = birthSessionPartition(graph.nodes);
  attachImpToCommunities(clusters, graph.nodes, graph.chains);
  return Object.fromEntries(
    incrementalLayout(view.nodes, view.edges, new Map(Object.entries(ledgers.positions)), {
      ...options,
      clusters,
      logicalEdges: view.logicalEdges,
      impLinks: view.impLinks,
    }),
  );
}
