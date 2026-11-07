// Ported from learnharness (AGPL-3.0-only) src/core/graph.ts @ c549494.
import type {
  AuditVerdicts,
  CoverageEntry,
  EmissionStats,
  GraphChain,
  GraphLedgers,
  GraphNode,
  LedgerPlan,
  SessionFindings,
} from "./model.ts";
import { chainKey, simplifyChains } from "./derive.ts";
export interface MergeSource {
  foldedAt: string;
  coverage?: readonly CoverageEntry[];
}
export interface MergeContext {
  now: string;
  newNodeId: () => string;
  newChainId: () => string;
}
export interface MergePlan extends LedgerPlan {
  stats: EmissionStats;
  mapping: ReadonlyMap<string, string>;
}
/** No writes occur here. Persist the complete plan atomically before checkpointing success. */
export function mergeFindings(
  chatId: string,
  findings: SessionFindings,
  verdicts: AuditVerdicts,
  ledgers: GraphLedgers,
  source: MergeSource,
  context: MergeContext,
): MergePlan {
  const nodes: GraphNode[] = [];
  const chains: GraphChain[] = [];
  const stats: { -readonly [K in keyof EmissionStats]: EmissionStats[K] } = { nodes: 0, chains: 0 };
  const existingIds = new Set(ledgers.nodes.map((n) => n.id));
  const chainIds = new Set(ledgers.chains.map((c) => c.id));
  const mapping = new Map<string, string>();
  const links = new Map(verdicts.links.map((link) => [link.id, link.linkTo]));
  const point = (messageId = "") => [{ chatId, messageId, at: context.now }];
  for (const proposition of findings.propositions) {
    if (mapping.has(proposition.id)) continue;
    const link = links.get(proposition.id);
    // Existing ids in the digest pass through even if a model restates one.
    const target =
      proposition.id.startsWith("n_") && existingIds.has(proposition.id)
        ? proposition.id
        : link !== undefined && existingIds.has(link)
          ? link
          : undefined;
    const id = target ?? context.newNodeId();
    if (target === undefined) {
      if (!/^n_[A-Za-z0-9_-]+$/.test(id) || existingIds.has(id))
        throw new Error(`Invalid or duplicate generated node id: ${id}`);
      stats.nodes++;
    }
    nodes.push({
      id,
      name: proposition.name,
      statement: proposition.statement,
      aliases: [...proposition.aliases],
      createdAt: context.now,
      provenance: point(proposition.messageId),
    });
    existingIds.add(id);
    mapping.set(proposition.id, id);
  }
  const asserted = new Set<string>();
  const idOfKey = new Map<string, string>();
  for (const line of ledgers.chains) {
    const key = chainKey(line.premises, line.conclusion);
    if (!idOfKey.has(key)) idOfKey.set(key, line.id);
    if (line.provenance.some((pt) => pt.chatId === chatId)) asserted.add(key);
  }
  const resolve = (id: string) => mapping.get(id) ?? (existingIds.has(id) ? id : undefined);
  for (const chain of findings.chains) {
    const conclusion = resolve(chain.conclusion);
    const resolved = chain.premises.map(resolve);
    // Reject a whole broken argument rather than silently weakening its premises.
    if (conclusion === undefined || resolved.some((id) => id === undefined)) continue;
    const premises = [...new Set(resolved)].filter(
      (id): id is string => id !== undefined && id !== conclusion,
    );
    if (!premises.length) continue;
    const key = chainKey(premises, conclusion);
    if (asserted.has(key)) continue;
    const known = idOfKey.get(key);
    const id = known ?? context.newChainId();
    if (known === undefined && (!/^arg_[A-Za-z0-9_-]+$/.test(id) || chainIds.has(id)))
      throw new Error(`Invalid or duplicate generated chain id: ${id}`);
    chains.push({ id, premises, conclusion, createdAt: context.now, provenance: point() });
    chainIds.add(id);
    idOfKey.set(key, id);
    asserted.add(key);
    stats.chains++;
  }
  const allChains = [...ledgers.chains, ...chains];
  const kept = simplifyChains(allChains);
  const rewrite: LedgerPlan["rewrite"] = {};
  if (kept.length !== allChains.length) {
    rewrite.chains = kept;
    stats.droppedChains = allChains.length - kept.length;
    const live = new Set(kept.map((c) => c.id));
    const dead = new Set(allChains.filter((c) => !live.has(c.id)).map((c) => c.id));
    if (Object.keys(ledgers.positions).some((id) => dead.has(id)))
      rewrite.positions = Object.fromEntries(
        Object.entries(ledgers.positions).filter(([id]) => !dead.has(id)),
      );
  }
  return {
    append: {
      nodes,
      chains,
      ...(source.coverage !== undefined
        ? { coverage: [...source.coverage] }
        : { checkpoints: [{ chatId, foldedAt: source.foldedAt }] }),
    },
    rewrite,
    stats,
    mapping,
  };
}
