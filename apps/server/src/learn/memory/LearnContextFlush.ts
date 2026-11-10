import {
  CommandId,
  MEMORY_FLUSH_MESSAGE_PREFIX,
  MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import * as LearnSessionStore from "../session/LearnSessionStore.ts";
import { FLUSH_PROMPT, nextContextStep } from "./contextFlush.ts";

const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
/** Flush turns that run at once; each spawns a provider process. */
const FLUSH_SLOTS = 2;
/** A slot frees when the thread's next run ends, or after this long. */
const FLUSH_SLOT_HOLD = Duration.minutes(10);

/**
 * A tutor thread idle past its provider's boundary gets a hidden turn that saves learner notes
 * while the prompt cache is warm, then a fresh provider context; the next turn's `learn_memory`
 * block carries the session's last messages. Timers live in memory; startup reschedules every
 * session.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* Projections.ProjectionStoreV2;
    const store = yield* LearnSessionStore.LearnSessionStore;
    const timers = yield* FiberMap.make<ThreadId>();
    const flushSlots = yield* Semaphore.make(FLUSH_SLOTS);

    const follow = Effect.fn("LearnContextFlush.follow")(
      function* (threadId: ThreadId) {
        let holdsSlot = false;
        while (true) {
          const session = yield* store.get(threadId);
          if (session === null) return;
          const records = yield* projections
            .getThreadRecords(threadId, ["runs", "runtimeRequests", "providerThreads"], {
              messageRoles: [],
              turnItemTypes: [],
            })
            // A session can outlive its deleted thread.
            .pipe(
              Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
            );
          if (records === null) return;
          const now = yield* Clock.currentTimeMillis;
          const step = nextContextStep(records, session.pausedAt, now);
          if (step === null) return;
          if (step.type === "wait") {
            yield* Effect.sleep(Duration.millis(step.untilMs - now));
            continue;
          }
          if (step.type === "flush") {
            // Waiting for a slot takes time, so the step is read again once one is held.
            if (!holdsSlot) {
              yield* Effect.acquireRelease(flushSlots.take(1), () => flushSlots.release(1));
              holdsSlot = true;
              continue;
            }
            const id = `${MEMORY_FLUSH_MESSAGE_PREFIX}${step.runId}`;
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              messageId: MessageId.make(id),
              threadId,
              text: FLUSH_PROMPT,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "agent",
              creationSource: "server",
            });
            // The flush run's terminal event replaces this fiber, which frees the slot.
            yield* Effect.sleep(FLUSH_SLOT_HOLD);
          } else
            yield* orchestrator.dispatch({
              type: "thread.context.reset",
              commandId: CommandId.make(`learn:reset:${step.runId}`),
              threadId,
            });
          return;
        }
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            Effect.logWarning("Learn context step skipped", { threadId, cause }),
          ),
        ),
    );

    yield* forkParked(
      Effect.gen(function* () {
        yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "run.updated" && terminal.has(event.payload.status)
            ? FiberMap.run(timers, event.threadId, follow(event.threadId)).pipe(Effect.asVoid)
            : Effect.void,
        ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
        for (const session of yield* store.list.pipe(Effect.orElseSucceed(() => [])))
          yield* FiberMap.run(timers, session.threadId, follow(session.threadId));
      }),
    );
  }),
);
