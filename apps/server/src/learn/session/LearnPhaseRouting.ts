import { CommandId, ThreadId } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Sessions from "./LearnSessionService.ts";

const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

/**
 * Phase routing (plan §4.3 item 2). Phases only change inside a tutor turn
 * (`probe_done`, `plan_init`), so when a session's run ends this sets the
 * thread's model to the route for the new phase; the next turn starts on it
 * through the normal model-switch path. Threads the learner re-picked by hand
 * are left alone (`modelForTurn` returns nothing for them).
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sessions = yield* Sessions.LearnSessionService;
    const route = Effect.fn("LearnPhaseRouting.route")(
      function* (threadId: ThreadId, runId: string) {
        const next = yield* sessions.modelForTurn(threadId);
        if (next === undefined) return;
        const current = (yield* orchestrator.getThreadProjection(threadId)).thread.modelSelection;
        if (modelSelectionsEqual(current, next)) return;
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`learn:route:${runId}`),
          threadId,
          modelSelection: next,
        });
        yield* sessions.recordRoutedModel(threadId, next);
      },
      Effect.ignoreCause({ log: true }),
    );
    yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "run.updated" && terminal.has(event.payload.status)
        ? route(event.threadId, event.payload.id)
        : Effect.void,
    ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  }),
);
