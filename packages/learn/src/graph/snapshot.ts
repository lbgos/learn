// Ported from learnharness (AGPL-3.0-only) src/core/graph.ts @ c549494.
import * as Schema from "effect/Schema";
import type { GraphLedgers, GraphSnapshot } from "./model.ts";
import { getGraph, deriveView } from "./derive.ts";
import {
  attachImpToCommunities,
  birthSessionOf,
  birthSessionPartition,
} from "./session-clusters.ts";
import { MIN_CLUSTER_SIZE } from "./clusters.ts";
export const GraphSession = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type GraphSession = typeof GraphSession.Type;
export function graphSnapshot(
  ledgers: GraphLedgers,
  sessionRecords: ReadonlyArray<GraphSession> = [],
): GraphSnapshot {
  const graph = getGraph(ledgers);
  const view = deriveView(graph);
  const sourceIds = new Set(view.nodes.flatMap((node) => node.provenance.map((pt) => pt.chatId)));
  const sessions = Object.fromEntries(
    sessionRecords.filter((s) => sourceIds.has(s.id)).map((s) => [s.id, s.title]),
  );
  const fileSources = Object.fromEntries(
    ledgers.sources
      .filter((s) => sourceIds.has(s.id) && !Object.hasOwn(sessions, s.id))
      .map((s) => [s.id, s.filePath]),
  );
  const nodeSessions: Record<string, string[]> = {};
  for (const node of view.nodes) {
    const ids = [...new Set(node.provenance.map((pt) => pt.chatId))].filter(
      (id) => Object.hasOwn(sessions, id) || Object.hasOwn(fileSources, id),
    );
    if (ids.length) nodeSessions[node.id] = ids;
  }
  const clusters = birthSessionPartition(graph.nodes)
    .filter((c) => c.members.length >= MIN_CLUSTER_SIZE)
    .map((c) => ({
      ...c,
      label: sessions[c.id] ?? fileSources[c.id] ?? null,
    }));
  attachImpToCommunities(clusters, graph.nodes, graph.chains);
  const live = new Set(view.nodes.map((n) => n.id));
  const positions = Object.fromEntries(
    Object.entries(ledgers.positions).filter(([id]) => live.has(id)),
  );
  return {
    ...view,
    propositions: graph.nodes,
    chains: graph.chains,
    sessions,
    fileSources,
    nodeSessions,
    clusters,
    ...(Object.keys(positions).length ? { positions } : {}),
  };
}
export function graphSessionIndex(
  ledgers: GraphLedgers,
  sessions: ReadonlyArray<GraphSession> = [],
) {
  return birthSessionPartition(getGraph(ledgers).nodes)
    .map((cluster) => {
      const chat = sessions.find((s) => s.id === cluster.id);
      const source = ledgers.sources.find((s) => s.id === cluster.id);
      return {
        id: cluster.id,
        name: chat?.title ?? source?.filePath ?? cluster.id,
        kind: chat ? "chat" : "file",
        createdAt: chat?.createdAt ?? source?.importedAt ?? null,
        updatedAt: chat?.updatedAt ?? source?.importedAt ?? null,
        propositions: cluster.members.length,
      };
    })
    .sort(
      (a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
        a.id.localeCompare(b.id),
    );
}
export function graphSessionPropositions(ledgers: GraphLedgers, sourceId: string) {
  return getGraph(ledgers)
    .nodes.filter((n) => birthSessionOf(n) === sourceId)
    .map((n) => ({ nodeId: n.id, name: n.name, statement: n.statement }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}
