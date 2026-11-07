// Ported from learnharness (AGPL-3.0-only) src/core/contracts/graph.ts @ c549494.
import * as Schema from "effect/Schema";

const text = Schema.String;
const nonempty = text.check(Schema.isNonEmpty());
const finite = Schema.Number.check(Schema.isFinite());
const count = finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const NodeId = text.check(Schema.isPattern(/^n_[A-Za-z0-9_-]+$/));
export const ChainId = text.check(Schema.isPattern(/^arg_[A-Za-z0-9_-]+$/));
export const ProvenancePoint = Schema.Struct({
  chatId: nonempty,
  messageId: text,
  at: Schema.optional(text),
});
export type ProvenancePoint = typeof ProvenancePoint.Type;
export const GraphNode = Schema.Struct({
  id: NodeId,
  name: text,
  statement: text,
  aliases: Schema.Array(text),
  createdAt: text,
  provenance: Schema.Array(ProvenancePoint),
});
export type GraphNode = typeof GraphNode.Type;
export const GraphChain = Schema.Struct({
  id: ChainId,
  premises: Schema.Array(NodeId).check(Schema.isMinLength(1)),
  conclusion: NodeId,
  provenance: Schema.Array(ProvenancePoint),
  createdAt: text,
});
export type GraphChain = typeof GraphChain.Type;
export const GraphEdge = Schema.Struct({ from: text, to: text });
export type GraphEdge = typeof GraphEdge.Type;
export const Position = Schema.Struct({ x: finite, y: finite });
export type Position = typeof Position.Type;
export const Positions = Schema.Record(text, Position);
export const CoverageEntry = Schema.Struct({
  chatId: nonempty,
  fp: nonempty,
  tokens: count,
  foldedAt: text,
});
export type CoverageEntry = typeof CoverageEntry.Type;
export const SessionCheckpoint = Schema.Struct({ chatId: nonempty, foldedAt: text });
export type SessionCheckpoint = typeof SessionCheckpoint.Type;
export const EmissionStats = Schema.Struct({
  nodes: count,
  chains: count,
  droppedChains: Schema.optional(count),
});
export type EmissionStats = typeof EmissionStats.Type;
const CallUsage = Schema.Struct({
  inputTokens: Schema.optional(count),
  outputTokens: Schema.optional(count),
  cacheReadTokens: Schema.optional(count),
  cacheWriteTokens: Schema.optional(count),
  cacheWrite1hTokens: Schema.optional(count),
  reasoningTokens: Schema.optional(count),
});
const ExtractionStageUsage = Schema.Struct({ model: text, steps: Schema.Array(CallUsage) });
export const ExtractionRunUsage = Schema.Struct({
  startedAt: finite,
  at: text,
  durationMs: finite,
  stats: Schema.optional(EmissionStats),
  stages: Schema.Struct({ extractor: ExtractionStageUsage, auditor: ExtractionStageUsage }),
});
export const NotesSource = Schema.Struct({
  id: nonempty,
  filePath: nonempty,
  importedAt: text,
  contentFp: Schema.optional(text),
  extractions: Schema.optional(Schema.Array(ExtractionRunUsage)),
});
export type NotesSource = typeof NotesSource.Type;
export const ExtractedProposition = Schema.Struct({
  id: nonempty,
  name: nonempty,
  statement: nonempty,
  aliases: Schema.Array(text),
  messageId: Schema.optional(text),
});
export type ExtractedProposition = typeof ExtractedProposition.Type;
export const ExtractedChain = Schema.Struct({
  premises: Schema.Array(nonempty),
  conclusion: nonempty,
});
export type ExtractedChain = typeof ExtractedChain.Type;
export const SessionFindings = Schema.Struct({
  propositions: Schema.Array(ExtractedProposition),
  chains: Schema.Array(ExtractedChain),
});
export type SessionFindings = typeof SessionFindings.Type;
export const IdentityLink = Schema.Struct({ id: nonempty, linkTo: NodeId });
export type IdentityLink = typeof IdentityLink.Type;
export const AuditVerdicts = Schema.Struct({ links: Schema.Array(IdentityLink) });
export type AuditVerdicts = typeof AuditVerdicts.Type;
export const TeacherProseMessage = Schema.Struct({ id: nonempty, text });
export type TeacherProseMessage = typeof TeacherProseMessage.Type;
export const Cluster = Schema.Struct({
  id: text,
  label: Schema.NullOr(text),
  members: Schema.Array(text),
});
export type Cluster = typeof Cluster.Type;
export const ImpLinkSchema = Schema.Struct({
  id: text,
  premises: Schema.Array(text),
  conclusion: text,
});
export const ViewNode = Schema.Struct({ ...GraphNode.fields, id: Schema.Union([NodeId, ChainId]) });
export type ViewNode = typeof ViewNode.Type;
export const GraphSnapshot = Schema.Struct({
  nodes: Schema.Array(ViewNode),
  propositions: Schema.Array(GraphNode),
  chains: Schema.Array(GraphChain),
  edges: Schema.Array(GraphEdge),
  logicalEdges: Schema.Array(GraphEdge),
  impLinks: Schema.Array(ImpLinkSchema),
  sessions: Schema.Record(text, text),
  fileSources: Schema.Record(text, text),
  nodeSessions: Schema.Record(text, Schema.Array(text)),
  clusters: Schema.Array(Cluster),
  positions: Schema.optional(Positions),
});
export type GraphSnapshot = typeof GraphSnapshot.Type;
export const GraphLedgers = Schema.Struct({
  nodes: Schema.Array(GraphNode),
  chains: Schema.Array(GraphChain),
  coverage: Schema.Array(CoverageEntry),
  checkpoints: Schema.Array(SessionCheckpoint),
  sources: Schema.Array(NotesSource),
  positions: Positions,
});
export type GraphLedgers = typeof GraphLedgers.Type;
export const emptyGraphLedgers = (): GraphLedgers => ({
  nodes: [],
  chains: [],
  coverage: [],
  checkpoints: [],
  sources: [],
  positions: {},
});
export const LedgerAppend = Schema.Struct({
  nodes: Schema.optional(GraphLedgers.fields.nodes),
  chains: Schema.optional(GraphLedgers.fields.chains),
  coverage: Schema.optional(GraphLedgers.fields.coverage),
  checkpoints: Schema.optional(GraphLedgers.fields.checkpoints),
  sources: Schema.optional(GraphLedgers.fields.sources),
});
export const LedgerRewrite = Schema.Struct({
  ...LedgerAppend.fields,
  positions: Schema.optional(Positions),
});
export const LedgerPlan = Schema.Struct({ append: LedgerAppend, rewrite: LedgerRewrite });
export interface LedgerPlan {
  append: typeof LedgerAppend.Type;
  rewrite: { -readonly [K in keyof typeof LedgerRewrite.Type]: (typeof LedgerRewrite.Type)[K] };
}
/** Apply appends first, then replacements. A rewrite already includes this plan's appends. */
export function applyLedgerPlan(ledgers: GraphLedgers, plan: LedgerPlan): GraphLedgers {
  return {
    nodes: plan.rewrite.nodes ?? [...ledgers.nodes, ...(plan.append.nodes ?? [])],
    chains: plan.rewrite.chains ?? [...ledgers.chains, ...(plan.append.chains ?? [])],
    coverage: plan.rewrite.coverage ?? [...ledgers.coverage, ...(plan.append.coverage ?? [])],
    checkpoints: plan.rewrite.checkpoints ?? [
      ...ledgers.checkpoints,
      ...(plan.append.checkpoints ?? []),
    ],
    sources: plan.rewrite.sources ?? [...ledgers.sources, ...(plan.append.sources ?? [])],
    positions: plan.rewrite.positions ?? ledgers.positions,
  };
}
export const CURRENT_GRAPH_FORMAT_VERSION = 1;
