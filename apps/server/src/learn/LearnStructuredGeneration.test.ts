import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as LearnComposerDefault from "./LearnComposerDefault.ts";
import * as LearnModelRouter from "./LearnModelRouter.ts";
import * as LearnStructuredGeneration from "./LearnStructuredGeneration.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const selection = { instanceId: ProviderInstanceId.make("codex-test"), model: "test-model" };
const schema = Schema.Struct({ value: Schema.Int });
const input = {
  role: "extraction",
  label: "extract",
  prompt: "Extract propositions",
  schema,
} as const;

const layer = (
  generateStructured: TextGeneration.TextGeneration["Service"]["generateStructured"],
) =>
  LearnStructuredGeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(LearnModelRouter.LearnModelRouter, {
          snapshot: () => Effect.die("unused snapshot"),
          resolve: () => Effect.succeed(selection),
        }),
        Layer.mock(TextGeneration.TextGeneration)({ generateStructured }),
        Layer.succeed(LearnComposerDefault.LearnComposerDefault, {
          get: Effect.undefined,
        }),
      ),
    ),
  );

const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({ operation: "test", detail: "Invalid fake output", cause }),
    ),
  );

it.layer(NodeServices.layer)("LearnStructuredGeneration", (it) => {
  it.effect("runs an unset route on the composer default", () =>
    Effect.gen(function* () {
      const fallback = { instanceId: ProviderInstanceId.make("composer"), model: "default" };
      const used: unknown[] = [];
      const service = yield* LearnStructuredGeneration.LearnStructuredGeneration.pipe(
        Effect.provide(
          LearnStructuredGeneration.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(LearnModelRouter.LearnModelRouter, {
                  snapshot: () => Effect.die("unused snapshot"),
                  resolve: (role) =>
                    Effect.fail(
                      new LearnModelRouter.LearnRouteUnavailable({ role, reason: "unset" }),
                    ),
                }),
                Layer.succeed(LearnComposerDefault.LearnComposerDefault, {
                  get: Effect.succeed(fallback),
                }),
                Layer.mock(TextGeneration.TextGeneration)({
                  generateStructured: (request) => {
                    used.push(request.modelSelection);
                    return decode(request.outputSchema, { value: 1 });
                  },
                }),
              ),
            ),
          ),
        ),
      );
      assert.deepEqual(yield* service.run(input), { value: 1 });
      assert.deepEqual(used, [fallback]);
    }),
  );
  it.effect("retries validation against the original prompt and removes its empty cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const prompts: string[] = [];
      const workspaces: string[] = [];
      const service = yield* LearnStructuredGeneration.LearnStructuredGeneration.pipe(
        Effect.provide(
          layer((request) =>
            Effect.gen(function* () {
              prompts.push(request.prompt);
              workspaces.push(request.cwd);
              assert.deepEqual(request.modelSelection, selection);
              assert.deepEqual(yield* fs.readDirectory(request.cwd).pipe(Effect.orDie), []);
              return yield* decode(request.outputSchema, { value: prompts.length });
            }),
          ),
        ),
      );
      const result = yield* service.run({
        ...input,
        maxAttempts: 3,
        validate: (value) => (value.value < 3 ? [`Value ${value.value} rejected`] : []),
      });
      assert.deepEqual(result, { value: 3 });
      assert.equal(prompts[0], input.prompt);
      assert.include(prompts[1]!, "Your previous submission was rejected:\n- Value 1 rejected");
      assert.include(prompts[2]!, "Value 2 rejected");
      assert.notInclude(prompts[2]!, "Value 1 rejected");
      assert.isTrue(workspaces.every((cwd) => cwd === workspaces[0]));
      assert.isFalse(yield* fs.exists(workspaces[0]!));
    }),
  );

  it.effect("reports the final validation problems and cleans up at max attempts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let cwd = "";
      let calls = 0;
      const service = yield* LearnStructuredGeneration.LearnStructuredGeneration.pipe(
        Effect.provide(
          layer((request) => {
            cwd = request.cwd;
            calls++;
            return decode(request.outputSchema, { value: 1 });
          }),
        ),
      );
      const error = yield* service
        .run({ ...input, validate: () => ["Unknown proposition"] })
        .pipe(Effect.flip);
      assert.equal(calls, 2);
      assert.equal(error.attempts, 2);
      assert.equal(error.role, "extraction");
      assert.equal(error.label, "extract");
      assert.deepEqual(error.problems, ["Unknown proposition"]);
      assert.isFalse(yield* fs.exists(cwd));
    }),
  );

  it.effect("does not retry provider errors and keeps the cause and removes cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let cwd = "";
      let calls = 0;
      const failure = new TextGenerationError({ operation: "extract", detail: "Bad JSON" });
      const service = yield* LearnStructuredGeneration.LearnStructuredGeneration.pipe(
        Effect.provide(
          layer((request) => {
            cwd = request.cwd;
            calls++;
            return Effect.fail(failure);
          }),
        ),
      );
      const error = yield* service.run(input).pipe(Effect.flip);
      assert.equal(calls, 1);
      assert.equal(error.attempts, 1);
      assert.equal(error.cause, failure);
      assert.isFalse(yield* fs.exists(cwd));
    }),
  );

  it.effect(
    "limits concurrent calls to two across separate service instances and cleans interrupted work",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const entered = yield* Queue.unbounded<string>();
        const created = yield* Queue.unbounded<string>();
        const release = yield* Deferred.make<void>();
        let active = 0;
        let maximum = 0;
        const generateStructured: TextGeneration.TextGeneration["Service"]["generateStructured"] = (
          request,
        ) =>
          Effect.gen(function* () {
            active++;
            maximum = Math.max(maximum, active);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                active--;
              }),
            );
            yield* Queue.offer(entered, request.cwd);
            yield* Deferred.await(release);
            return yield* decode(request.outputSchema, { value: 1 });
          }).pipe(Effect.scoped);
        const trackedFs = {
          ...fs,
          makeTempDirectoryScoped: (options?: Parameters<typeof fs.makeTempDirectoryScoped>[0]) =>
            fs
              .makeTempDirectoryScoped(options)
              .pipe(Effect.tap((cwd) => Queue.offer(created, cwd))),
        };
        const first = yield* LearnStructuredGeneration.LearnStructuredGeneration.pipe(
          Effect.provide(layer(generateStructured)),
          Effect.provideService(FileSystem.FileSystem, trackedFs),
        );
        const second = yield* LearnStructuredGeneration.LearnStructuredGeneration.pipe(
          Effect.provide(layer(generateStructured)),
          Effect.provideService(FileSystem.FileSystem, trackedFs),
        );
        const fibers = yield* Effect.forEach([first, second, first], (service) =>
          service.run(input).pipe(Effect.forkScoped),
        );
        const directories = yield* Effect.forEach([0, 1, 2], () => Queue.take(created));
        yield* Queue.take(entered);
        yield* Queue.take(entered);
        assert.equal(active, 2);
        assert.equal(yield* Queue.size(entered), 0);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(fibers, Fiber.join);
        assert.equal(maximum, 2);
        assert.equal(new Set(directories).size, 3);
        for (const cwd of directories) assert.isFalse(yield* fs.exists(cwd));

        const blocked = yield* Deferred.make<void>();
        const started = yield* Deferred.make<string>();
        const service = yield* LearnStructuredGeneration.LearnStructuredGeneration.pipe(
          Effect.provide(
            layer((request) =>
              Deferred.succeed(started, request.cwd).pipe(
                Effect.andThen(Deferred.await(blocked)),
                Effect.andThen(decode(request.outputSchema, { value: 1 })),
              ),
            ),
          ),
        );
        const fiber = yield* service.run(input).pipe(Effect.forkScoped);
        const cwd = yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        assert.isFalse(yield* fs.exists(cwd));
      }).pipe(Effect.scoped),
  );

  it.effect("rejects invalid attempt counts before calling a provider", () =>
    Effect.gen(function* () {
      const service = yield* LearnStructuredGeneration.LearnStructuredGeneration.pipe(
        Effect.provide(layer(() => Effect.die("must not call provider"))),
      );
      for (const maxAttempts of [0, -1, 1.5]) {
        const error = yield* service.run({ ...input, maxAttempts }).pipe(Effect.flip);
        assert.equal(error.attempts, 0);
      }
    }),
  );
});
