// Ported from learnharness (AGPL-3.0-only) src/core/contracts/plan.ts, src/core/contracts/probe.ts @ c549494.
import * as Schema from "effect/Schema";

export const nonEmptyText = Schema.String.check(
  Schema.makeFilter((s) => s.trim().length > 0 || "must not be blank"),
);
export const finiteNumber = Schema.Number.check(Schema.isFinite());
export const callId = Schema.String.check(Schema.isPattern(/^[^\s[\]]+$/));
export const SessionKind = Schema.Literals(["teach", "practice"]);
export const SessionMechanic = Schema.Literals(["choice", "recall"]);
export const SessionPhase = Schema.Literals(["probe", "plan", "teach"]);
export type SessionPhase = typeof SessionPhase.Type;
export const LearnSessionMeta = Schema.Struct({
  kind: SessionKind,
  mechanic: SessionMechanic,
  createdAt: nonEmptyText,
  graphContext: Schema.optional(Schema.Struct({ nodeIds: Schema.Array(nonEmptyText) })),
});
export type LearnSessionMeta = typeof LearnSessionMeta.Type;
export const SessionEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    id: callId,
    name: nonEmptyText,
    input: Schema.Unknown,
    at: nonEmptyText,
  }),
  Schema.Struct({
    type: Schema.Literal("learner-message"),
    id: callId,
    text: Schema.String,
    at: nonEmptyText,
  }),
]);
export type SessionEvent = typeof SessionEvent.Type;
export type ToolCallEvent = Extract<SessionEvent, { type: "tool-call" }>;
export const PlanNode = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9]+([_-][a-z0-9]+)*$/)),
  title: nonEmptyText,
  summary: Schema.optional(nonEmptyText),
});
export type PlanNode = typeof PlanNode.Type;
export const PlanEdge = Schema.Struct({ from: nonEmptyText, to: nonEmptyText });
export type PlanEdge = typeof PlanEdge.Type;
export const PlanTree = Schema.Struct({
  nodes: Schema.Array(PlanNode),
  edges: Schema.Array(PlanEdge),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PlanTree = typeof PlanTree.Type;
export const PlanNodeStatus = Schema.Literals(["current", "visited", "upcoming"]);
export type PlanNodeStatus = typeof PlanNodeStatus.Type;
export interface PlanStatuses {
  readonly current: string | null;
  readonly visited: ReadonlySet<string>;
}
export const ProbeStrand = Schema.Struct({ strand: nonEmptyText, assessment: nonEmptyText });
export const ProbeAssessment = Schema.Struct({
  strands: Schema.Array(ProbeStrand).check(Schema.isMinLength(1)),
  summary: Schema.optional(Schema.String),
});
export type ProbeAssessment = typeof ProbeAssessment.Type;
