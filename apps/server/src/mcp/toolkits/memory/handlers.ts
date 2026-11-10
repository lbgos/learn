import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as LearnMemory from "../../../learn/memory/LearnMemoryService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { ContextToolkit, MemoryToolkit } from "./tools.ts";

const failure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: error._tag === "LearnMemoryRefused" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

/** The calling thread's id; the service refuses threads that are not a tutoring session. */
const callerThread = Effect.gen(function* () {
  const scope = yield* Invocation.McpInvocationContext;
  const caller = yield* Invocation.requireThreadScope(scope, "learner memory");
  return caller.thread.threadId;
});

export const layer = Access.toLayer(MemoryToolkit, {
  update_memory: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const memory = yield* LearnMemory.LearnMemoryService;
      return yield* memory.update(yield* callerThread, input).pipe(Effect.mapError(failure));
    }),
  ),
  memory_search: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const memory = yield* LearnMemory.LearnMemoryService;
      return yield* memory.search(yield* callerThread, input).pipe(Effect.mapError(failure));
    }),
  ),
});

export const layerContext = Access.toLayer(ContextToolkit, {
  context_search: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const memory = yield* LearnMemory.LearnMemoryService;
      return yield* memory.contextSearch(yield* callerThread, input).pipe(Effect.mapError(failure));
    }),
  ),
});
