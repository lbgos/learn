// Ported from learnharness (AGPL-3.0-only) src/agent/subagents/extraction.ts @ c549494.
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Pipeline from "./LearnGraphPipeline.ts";
import * as Threads from "./LearnGraphThreads.ts";

export class LearnGraphReactor extends Context.Service<
  LearnGraphReactor,
  {
    readonly trigger: (threadId: ThreadId) => Effect.Effect<void>;
    readonly awaitIdle: (threadId: ThreadId) => Effect.Effect<void>;
    readonly extractNow: Pipeline.LearnGraphPipeline["Service"]["runSession"];
  }
>()("t3/learn/graph/LearnGraphReactor") {}
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const make = Effect.gen(function* () {
  const threads = yield* Threads.LearnGraphThreads;
  const pipeline = yield* Pipeline.LearnGraphPipeline;
  const scope = yield* Scope.Scope;
  const running = new Map<ThreadId, { dirty: boolean; done: Deferred.Deferred<void> }>();
  const trigger = (threadId: ThreadId) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = running.get(threadId);
        if (existing) {
          existing.dirty = true;
          return;
        }
        const state = { dirty: true, done: yield* Deferred.make<void>() };
        running.set(threadId, state);
        yield* Effect.forkIn(
          Effect.gen(function* () {
            while (state.dirty) {
              state.dirty = false;
              yield* pipeline.runSession(threadId, true).pipe(Effect.ignoreCause({ log: true }));
            }
          }).pipe(
            Effect.interruptible,
            Effect.ensuring(
              Effect.gen(function* () {
                running.delete(threadId);
                yield* Deferred.succeed(state.done, undefined);
              }),
            ),
          ),
          scope,
        );
      }),
    );
  yield* Stream.runForEach(threads.events, (event) =>
    event.type === "run.updated" && terminal.has(event.payload.status)
      ? trigger(event.threadId)
      : Effect.void,
  ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  return LearnGraphReactor.of({
    trigger,
    awaitIdle: Effect.fn("LearnGraphReactor.awaitIdle")(function* (threadId) {
      const state = running.get(threadId);
      if (state) yield* Deferred.await(state.done);
    }),
    extractNow: Effect.fn("LearnGraphReactor.extractNow")((threadId) =>
      pipeline.runSession(threadId),
    ),
  });
});
export const layer = Layer.effect(LearnGraphReactor, make);
