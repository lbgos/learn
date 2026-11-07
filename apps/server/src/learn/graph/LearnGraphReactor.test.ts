import { assert, it } from "@effect/vitest";
import { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Pipeline from "./LearnGraphPipeline.ts";
import * as Reactor from "./LearnGraphReactor.ts";
import * as Threads from "./LearnGraphThreads.ts";
const threadId = ThreadId.make("teach");
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const event = (status: string) =>
  decodeEvent({
    id: `event-${status}`,
    threadId,
    occurredAt: DateTime.makeUnsafe(0),
    type: "run.updated",
    payload: {
      id: "run",
      threadId,
      ordinal: 1,
      providerInstanceId: "fake",
      modelSelection: { instanceId: "fake", model: "fake" },
      providerThreadId: null,
      userMessageId: "m",
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: DateTime.makeUnsafe(0),
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
it.effect("coalesces triggers while a source runs and never overlaps its work", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const context = yield* Layer.build(
      Reactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Threads.LearnGraphThreads, {
              load: () => Effect.undefined,
              events: Stream.never,
            }),
            Layer.mock(Pipeline.LearnGraphPipeline)({
              runSession: (id, automatic) =>
                Effect.gen(function* () {
                  assert.equal(id, threadId);
                  assert.isTrue(automatic);
                  calls++;
                  active++;
                  maximum = Math.max(maximum, active);
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                  active--;
                  return { sourceId: id, batches: 0, nodes: 0, chains: 0, unchanged: true };
                }),
            }),
          ),
        ),
      ),
    );
    const service = Context.get(context, Reactor.LearnGraphReactor);
    yield* service.trigger(threadId);
    yield* Deferred.await(started);
    yield* service.trigger(threadId);
    yield* service.trigger(threadId);
    yield* service.trigger(threadId);
    yield* Deferred.succeed(release, undefined);
    yield* service.awaitIdle(threadId);
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
  }).pipe(Effect.scoped),
);
it.effect("terminal events schedule extraction and active runs do not", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const context = yield* Layer.build(
      Reactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Threads.LearnGraphThreads, {
              load: () => Effect.undefined,
              events: Stream.make(event("running"), event("waiting"), event("completed")),
            }),
            Layer.mock(Pipeline.LearnGraphPipeline)({
              runSession: (id) =>
                Effect.gen(function* () {
                  calls++;
                  yield* Deferred.succeed(started, undefined);
                  return { sourceId: id, batches: 0, nodes: 0, chains: 0, unchanged: true };
                }),
            }),
          ),
        ),
      ),
    );
    const service = Context.get(context, Reactor.LearnGraphReactor);
    yield* Deferred.await(started);
    yield* service.awaitIdle(threadId);
    assert.equal(calls, 1);
  }).pipe(Effect.scoped),
);
