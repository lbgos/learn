import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Graph from "../../../learn/graph/LearnGraphService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { GraphToolkit } from "./tools.ts";
import type { LearnGraphError } from "@t3tools/contracts";
const failure = (error: LearnGraphError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
const caller = Effect.gen(function* () {
  const scope = yield* Invocation.McpInvocationContext;
  return yield* Invocation.requireThreadScope(scope, "physics");
});
export const layer = Access.toLayer(GraphToolkit, {
  graph_sessions: Access.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* caller;
      const graph = yield* Graph.LearnGraphService;
      return yield* graph.graphSessions.pipe(Effect.mapError(failure));
    }),
  ),
  graph_propositions: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* caller;
      const graph = yield* Graph.LearnGraphService;
      return yield* graph.graphPropositions(input).pipe(Effect.mapError(failure));
    }),
  ),
});
