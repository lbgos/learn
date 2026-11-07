// Ported from learnharness (AGPL-3.0-only) src/core/graph-deletion.ts @ c549494.
import type { GraphLedgers, LedgerPlan, GraphNode, GraphChain } from "./model.ts";
type GraphStore = ReturnType<typeof memoryPlan>["store"];
function memoryPlan(ledgers: GraphLedgers) {
  const rewrite: LedgerPlan["rewrite"] = {};
  const store = {
    readNodes: () => ledgers.nodes,
    readChains: () => ledgers.chains,
    readCoverage: () => ledgers.coverage,
    readCheckpoints: () => ledgers.checkpoints,
    readPositions: () => ledgers.positions,
    rewriteLedgers: (next: LedgerPlan["rewrite"]) => {
      Object.assign(rewrite, next);
    },
    writePositions: (positions: GraphLedgers["positions"]) => {
      rewrite.positions = positions;
    },
  };
  return { store, rewrite };
}
export type ChatDeleteMode = "preserve-graph" | "delete-nodes";

export interface ChatDeletionStats {
  nodesRemoved: number;

  chainsRemoved: number;

  coverageRemoved: number;

  checkpointsRemoved: number;
}

const EMPTY_STATS: ChatDeletionStats = {
  nodesRemoved: 0,
  chainsRemoved: 0,
  coverageRemoved: 0,
  checkpointsRemoved: 0,
};

function deleteChatTracesInMemory(
  graphStore: GraphStore,
  chatId: string,
  mode: ChatDeleteMode,
): ChatDeletionStats {
  if (mode !== "preserve-graph" && mode !== "delete-nodes") {
    throw new Error(`Unknown deletion mode: ${mode}`);
  }

  const coverage = graphStore.readCoverage().filter((row) => row.chatId !== chatId);
  const checkpoints = graphStore.readCheckpoints().filter((row) => row.chatId !== chatId);
  const stats: ChatDeletionStats = {
    ...EMPTY_STATS,
    coverageRemoved: graphStore.readCoverage().length - coverage.length,
    checkpointsRemoved: graphStore.readCheckpoints().length - checkpoints.length,
  };

  if (mode === "preserve-graph") {
    if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
      graphStore.rewriteLedgers({ coverage, checkpoints });
    }
    return stats;
  }

  const nodeLines = graphStore.readNodes();
  const chainLines = graphStore.readChains();

  const touched =
    nodeLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId)) ||
    chainLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId));
  if (!touched) {
    if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
      graphStore.rewriteLedgers({ coverage, checkpoints });
    }
    return stats;
  }

  const survives = (points: ReadonlyArray<{ chatId: string }>): boolean =>
    points.some((pt) => pt.chatId !== chatId);
  const live = new Set<string>();
  for (const line of nodeLines) {
    if (survives(line.provenance)) live.add(line.id);
  }

  const outNodes: GraphNode[] = [];
  const seenIds = new Set<string>();
  for (const line of nodeLines) {
    if (!live.has(line.id)) continue;
    const first = !seenIds.has(line.id);
    seenIds.add(line.id);
    const points = line.provenance.filter((pt) => pt.chatId !== chatId);
    if (points.length === line.provenance.length) {
      outNodes.push(line);
      continue;
    }
    if (points.length > 0) {
      outNodes.push({ ...line, provenance: points });
      continue;
    }
    if (first) {
      outNodes.push({ ...line, provenance: [], aliases: [] });
    }
  }

  const deadNodes = new Set(
    [...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)),
  );
  const outChains: GraphChain[] = [];
  for (const line of chainLines) {
    if (deadNodes.has(line.conclusion) || line.premises.some((premise) => deadNodes.has(premise)))
      continue;
    const points = line.provenance.filter((pt) => pt.chatId !== chatId);
    if (line.provenance.length > 0 && points.length === 0) continue;
    outChains.push(
      points.length === line.provenance.length ? line : { ...line, provenance: points },
    );
  }

  stats.nodesRemoved = [...new Set(nodeLines.map((line) => line.id))].filter(
    (id) => !live.has(id),
  ).length;
  stats.chainsRemoved = chainLines.length - outChains.length;

  graphStore.rewriteLedgers({
    nodes: outNodes,
    chains: outChains,
    coverage,
    checkpoints,
  });

  const liveChainIds = new Set(outChains.map((line) => line.id));
  const deadChainIds = new Set(
    chainLines.filter((line) => !liveChainIds.has(line.id)).map((line) => line.id),
  );
  const positions = graphStore.readPositions();
  const knownNodeIds = new Set(nodeLines.map((line) => line.id));
  const prunedPositions = Object.fromEntries(
    Object.entries(positions).filter(
      ([id]) => (live.has(id) || !knownNodeIds.has(id)) && !deadChainIds.has(id),
    ),
  );
  if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
    graphStore.writePositions(prunedPositions);
  }

  return stats;
}

export interface NodeDeletionStats {
  chainsRemoved: number;
}

function nodeLinesOf(graphStore: GraphStore, nodeId: string): GraphNode[] {
  return graphStore.readNodes().filter((line) => line.id === nodeId);
}

function deleteNodeTracesInMemory(
  graphStore: GraphStore,
  nodeId: string,
): NodeDeletionStats | null {
  const chainLines = graphStore.readChains();

  if (nodeId.startsWith("arg_")) {
    const outChains = chainLines.filter((line) => line.id !== nodeId);
    if (outChains.length === chainLines.length) return null;
    graphStore.rewriteLedgers({ chains: outChains });
    const positions = graphStore.readPositions();
    if (positions[nodeId] !== undefined) {
      const { [nodeId]: _dead, ...rest } = positions;
      graphStore.writePositions(rest);
    }
    return { chainsRemoved: chainLines.length - outChains.length };
  }

  const nodeLines = nodeLinesOf(graphStore, nodeId);
  if (nodeLines.length === 0) return null;

  const outChains = chainLines.filter(
    (line) => line.conclusion !== nodeId && !line.premises.includes(nodeId),
  );

  const outNodes = graphStore.readNodes().filter((line) => line.id !== nodeId);
  graphStore.rewriteLedgers({
    nodes: outNodes,
    ...(outChains.length !== chainLines.length ? { chains: outChains } : {}),
  });

  const deadChainIds = new Set(
    chainLines.filter((line) => !outChains.includes(line)).map((line) => line.id),
  );
  const positions = graphStore.readPositions();
  const prunedPositions = Object.fromEntries(
    Object.entries(positions).filter(([id]) => id !== nodeId && !deadChainIds.has(id)),
  );
  if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
    graphStore.writePositions(prunedPositions);
  }

  return {
    chainsRemoved: chainLines.length - outChains.length,
  };
}

export function deleteChatTraces(ledgers: GraphLedgers, chatId: string, mode: ChatDeleteMode) {
  const { store, rewrite } = memoryPlan(ledgers);
  const stats = deleteChatTracesInMemory(store, chatId, mode);
  return { append: {}, rewrite, stats };
}
export function deleteNodeTraces(ledgers: GraphLedgers, nodeId: string) {
  const { store, rewrite } = memoryPlan(ledgers);
  const stats = deleteNodeTracesInMemory(store, nodeId);
  return stats === null ? null : { append: {}, rewrite, stats };
}
export const planSessionDeletion = deleteChatTraces;
