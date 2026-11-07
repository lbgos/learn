import type { LearnerRecord } from "@t3tools/learn/review";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { LearnGraphError } from "@t3tools/contracts";

/** Every Lab session's retrievals and graded answers. Bound to the session threads at the root. */
export class LearnRetrievals extends Context.Service<
  LearnRetrievals,
  { readonly record: Effect.Effect<LearnerRecord, LearnGraphError> }
>()("t3/learn/graph/LearnRetrievals") {}
