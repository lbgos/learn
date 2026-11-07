// Ported from learnharness (AGPL-3.0-only) src/agent/tools/jobs.ts @ c549494.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { LearnJobs } from "../../../learn/jobs/LearnJobs.ts";
import type { LearnJobError } from "../../../learn/jobs/schemas.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { JobsToolkit } from "./tools.ts";

const failure = (error: LearnJobError | OrchestratorMcpFailure) =>
  error._tag === "OrchestratorMcpFailure"
    ? error
    : new OrchestratorMcpFailure({
        code: error.reason === "route-unavailable" ? "provider_unavailable" : "invalid_request",
        message: error.message,
      });
const caller = Effect.gen(function* () {
  return yield* Invocation.requireThreadScope(yield* Invocation.McpInvocationContext, "physics");
});

export const layer = Access.toLayer(JobsToolkit, {
  research: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const jobs = yield* LearnJobs;
      return yield* jobs.research(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  build_sim: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const jobs = yield* LearnJobs;
      return yield* jobs.buildSim(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  make_visual: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const jobs = yield* LearnJobs;
      return yield* jobs.makeVisual(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
});
