import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { newGraphNodeId } from "@t3tools/learn/graph/node";
import { LearnActivityEntry } from "@t3tools/contracts";

export class LearnActivity extends Context.Service<
  LearnActivity,
  {
    readonly changes: Stream.Stream<ReadonlyArray<LearnActivityEntry>>;
    readonly current: Effect.Effect<ReadonlyArray<LearnActivityEntry>>;
    readonly stop: (id: string) => Effect.Effect<boolean>;
    readonly run: <A, E, R>(
      entry: Omit<LearnActivityEntry, "id" | "startedAt">,
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/learn/graph/LearnActivity") {}

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const entries = yield* SubscriptionRef.make<ReadonlyArray<LearnActivityEntry>>([]);
  const stops = new Map<string, Effect.Effect<void>>();
  return LearnActivity.of({
    changes: SubscriptionRef.changes(entries),
    current: SubscriptionRef.get(entries),
    stop: Effect.fn("LearnActivity.stop")(function* (id) {
      const stop = stops.get(id);
      return stop ? yield* stop.pipe(Effect.as(true)) : false;
    }),
    run: Effect.fn("LearnActivity.run")((entry, work) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = newGraphNodeId();
          const ready = yield* Deferred.make<void>();
          const cleanup = Effect.gen(function* () {
            stops.delete(id);
            yield* SubscriptionRef.update(entries, (items) =>
              items.filter((item) => item.id !== id),
            );
          });
          const fiber = yield* Effect.forkIn(
            Deferred.await(ready).pipe(
              Effect.andThen(work),
              Effect.ensuring(cleanup),
              Effect.interruptible,
            ),
            scope,
          );
          stops.set(id, Fiber.interrupt(fiber));
          const startedAt = DateTime.formatIso(yield* DateTime.now);
          yield* SubscriptionRef.update(entries, (items) => [
            ...items,
            { ...entry, id, startedAt },
          ]);
          yield* Deferred.succeed(ready, undefined);
          return yield* restore(Fiber.join(fiber)).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(fiber)),
          );
        }),
      ),
    ),
  });
});
export const layer = Layer.effect(LearnActivity, make);
