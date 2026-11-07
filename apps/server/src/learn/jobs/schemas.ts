// Ported from learnharness (AGPL-3.0-only) src/agent/tools/jobs.ts @ c549494.
import { NodeId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const brief = Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(16_384));
export const ResearchInput = Schema.Struct({ question: brief, why: brief });
export type ResearchInput = typeof ResearchInput.Type;
export const BuildSimInput = Schema.Struct({
  title: Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(200)),
  brief,
});
export type BuildSimInput = typeof BuildSimInput.Type;
export const MakeVisualInput = Schema.Struct({
  brief,
  kind: Schema.optional(Schema.Literals(["inline", "figure", "animation"])),
});
export type MakeVisualInput = typeof MakeVisualInput.Type;
export const LearnJobRole = Schema.Literals(["research", "developer", "visual"]);
export type LearnJobRole = typeof LearnJobRole.Type;
export const LearnJobResult = Schema.Struct({
  taskId: NodeId,
  childThreadId: Schema.NullOr(ThreadId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  message: Schema.String,
});
export type LearnJobResult = typeof LearnJobResult.Type;
export class LearnJobError extends Schema.TaggedError<LearnJobError>()("LearnJobError", {
  role: LearnJobRole,
  reason: Schema.Literals(["route-unavailable", "caller-unavailable", "child-caller"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
