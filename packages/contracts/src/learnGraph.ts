// Ported from learnharness (AGPL-3.0-only) src/core/contracts/graph.ts @ c549494.
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

const text = Schema.String;
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const finite = Schema.Number.check(Schema.isFinite());
const point = Schema.Struct({ chatId: text, messageId: text, at: Schema.optional(text) });
const node = Schema.Struct({
  id: text,
  name: text,
  statement: text,
  aliases: Schema.Array(text),
  createdAt: text,
  provenance: Schema.Array(point),
});
const chain = Schema.Struct({
  id: text,
  premises: Schema.Array(text),
  conclusion: text,
  createdAt: text,
  provenance: Schema.Array(point),
});
const edge = Schema.Struct({ from: text, to: text });
export const LearnGraphPositions = Schema.Record(text, Schema.Struct({ x: finite, y: finite }));
export const LearnGraphSnapshot = Schema.Struct({
  nodes: Schema.Array(node),
  propositions: Schema.Array(node),
  chains: Schema.Array(chain),
  edges: Schema.Array(edge),
  logicalEdges: Schema.Array(edge),
  impLinks: Schema.Array(
    Schema.Struct({ id: text, premises: Schema.Array(text), conclusion: text }),
  ),
  sessions: Schema.Record(text, text),
  fileSources: Schema.Record(text, text),
  nodeSessions: Schema.Record(text, Schema.Array(text)),
  clusters: Schema.Array(
    Schema.Struct({ id: text, label: Schema.NullOr(text), members: Schema.Array(text) }),
  ),
  positions: Schema.optional(LearnGraphPositions),
});
export const LearnGraphEvent = Schema.Struct({ revision: count, snapshot: LearnGraphSnapshot });
export const LearnGraphEvidence = Schema.Struct({
  threadId: ThreadId,
  title: text,
  sims: Schema.Array(text),
  boards: Schema.Array(text),
});
export const LearnGraphDeletionCounts = Schema.Struct({
  nodesRemoved: count,
  chainsRemoved: count,
  coverageRemoved: count,
  checkpointsRemoved: count,
});
export const LearnGraphCoverage = Schema.Struct({
  coveredTokens: count,
  uncoveredTokens: count,
  coveredCount: count,
  uncoveredCount: count,
});
export const LearnGraphExtractionResult = Schema.Struct({
  sourceId: text,
  batches: count,
  nodes: count,
  chains: count,
  unchanged: Schema.Boolean,
});
/** Due propositions (most overdue first) and confidence bands against accuracy. */
export const LearnReviewSummary = Schema.Struct({
  due: Schema.Array(text),
  calibration: Schema.Array(
    Schema.Struct({ from: count, to: count, answers: count, correct: count }),
  ),
});
export type LearnReviewSummary = typeof LearnReviewSummary.Type;
export const LearnActivityEntry = Schema.Struct({
  id: text,
  kind: Schema.Literals(["extraction", "notes-import"]),
  label: text,
  sourceId: text,
  startedAt: text,
});
export type LearnActivityEntry = typeof LearnActivityEntry.Type;
export class LearnGraphError extends Schema.TaggedError<LearnGraphError>()("LearnGraphError", {
  operation: text,
  reason: Schema.Literals(["io", "validation", "generation", "unavailable"]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    return `Graph ${this.operation} failed (${this.reason}).`;
  }
}
export const LearnActivityList = Schema.Array(LearnActivityEntry);
