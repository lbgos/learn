import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type { SessionToolName } from "@t3tools/learn/session";
import * as Effect from "effect/Effect";
import * as Sessions from "../../../learn/session/LearnSessionService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { LearnToolkit } from "./tools.ts";

const call = Effect.fn("LearnToolkit.call")(function* (name: SessionToolName, input: unknown) {
  const scope = yield* Invocation.McpInvocationContext;
  const caller = yield* Invocation.requireThreadScope(scope, "physics");
  const service = yield* Sessions.LearnSessionService;
  const context = yield* loadCaller();
  const runId = context.caller?.activeRunId;
  if (runId == null)
    return yield* new OrchestratorMcpFailure({
      code: "parent_not_active",
      message: "Learn tools require an active tutor run.",
    });
  return yield* service.call(caller.thread.threadId, name, input, runId).pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code:
            error._tag === "LearnSessionCallRefused" ? "invalid_request" : "orchestration_error",
          message: error.message,
        }),
    ),
  );
});
export const layer = Access.toLayer(LearnToolkit, {
  grade_answer: Access.actsAsCaller((input) => call("grade_answer", input)),
  correct_verdict: Access.actsAsCaller((input) => call("correct_verdict", input)),
  ask: Access.actsAsCaller((input) => call("ask", input)),
  quiz: Access.actsAsCaller((input) => call("quiz", input)),
  explain: Access.actsAsCaller((input) => call("explain", input)),
  probe_done: Access.actsAsCaller((input) => call("probe_done", input)),
  plan_init: Access.actsAsCaller((input) => call("plan_init", input)),
  problem: Access.actsAsCaller((input) => call("problem", input)),
  conclude: Access.actsAsCaller((input) => call("conclude", input)),
  park_question: Access.actsAsCaller((input) => call("park_question", input)),
  answer_parked: Access.actsAsCaller((input) => call("answer_parked", input)),
});
