import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PhysicsService from "../../../physics/PhysicsService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { PhysicsToolkit, PhysicsImageToolkit, PhysicsReferenceToolkit } from "./tools.ts";
const failure = (error: PhysicsService.PhysicsError) =>
  new OrchestratorMcpFailure({
    code: error._tag === "PhysicsFileError" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });
const caller = Effect.gen(function* () {
  const scope = yield* Invocation.McpInvocationContext;
  return (yield* Invocation.requireThreadScope(scope, "physics")).thread.threadId;
});
const handlers = {
  visual_run: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* PhysicsService.PhysicsService;
      return yield* service.visualRun(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  visual_show: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* PhysicsService.PhysicsService;
      return yield* service.visualShow(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  sim_run: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* PhysicsService.PhysicsService;
      return yield* service.simRun(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  sim_measure: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* PhysicsService.PhysicsService;
      return yield* service.simMeasure(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  sim_show: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* PhysicsService.PhysicsService;
      return yield* service.simShow(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  board_read: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* PhysicsService.PhysicsService;
      return yield* service.boardReadForThread(yield* caller, input).pipe(Effect.mapError(failure));
    }),
  ),
  board_write: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* PhysicsService.PhysicsService;
      return yield* service
        .boardWriteForThread(yield* caller, input)
        .pipe(Effect.mapError(failure));
    }),
  ),
} satisfies Access.Handlers<typeof PhysicsToolkit.tools>;
export const layerImages = Access.toLayer(PhysicsImageToolkit, {
  sim_run: handlers.sim_run,
  visual_run: handlers.visual_run,
  board_read: handlers.board_read,
});
export const layerReferences = Access.toLayer(PhysicsReferenceToolkit, {
  sim_measure: handlers.sim_measure,
  sim_show: handlers.sim_show,
  visual_show: handlers.visual_show,
  board_write: handlers.board_write,
});
