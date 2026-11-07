import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { LearnGraphError } from "@t3tools/contracts";

/** Bound to WP3b's session metadata store by the application layer. */
export class LearnSessionKinds extends Context.Service<
  LearnSessionKinds,
  {
    readonly kindOf: (
      threadId: ThreadId,
    ) => Effect.Effect<"teach" | "practice" | undefined, LearnGraphError>;
  }
>()("t3/learn/graph/LearnSessionKinds") {}
