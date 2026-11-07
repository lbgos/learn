import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Activity from "./LearnActivity.ts";
it.effect("stop interrupts work, releases resources and removes its activity", () =>
  Effect.gen(function* () {
    const service = yield* Activity.LearnActivity;
    const entered = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    const changes = yield* service.changes.pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.take(3),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    const work = yield* service
      .run(
        { kind: "extraction", sourceId: "teach", label: "Extract" },
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(finalized, undefined)),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const entry = (yield* service.current)[0]!;
    assert.equal(entry.sourceId, "teach");
    assert.isTrue(yield* service.stop(entry.id));
    yield* Deferred.await(finalized);
    assert.deepEqual(yield* service.current, []);
    assert.isFalse(yield* service.stop(entry.id));
    assert.equal((yield* Fiber.await(work))._tag, "Failure");
    assert.deepEqual(
      (yield* Fiber.join(changes)).map((entries) => entries.length),
      [0, 1, 0],
    );
  }).pipe(Effect.provide(Activity.layer), Effect.scoped),
);
