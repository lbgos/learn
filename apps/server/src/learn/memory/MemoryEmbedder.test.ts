import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as MemoryEmbedder from "./MemoryEmbedder.ts";

it.effect(
  "answers vectors; while down it answers nothing, waits a minute and logs no note text",
  () => {
    const lines: string[] = [];
    return Effect.gen(function* () {
      const state = { up: false, requests: 0 };
      const embedder = yield* MemoryEmbedder.make("http://127.0.0.1:1").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            state.requests++;
            return state.up
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json({ model: "e5", dimensions: 2, vectors: [[0.6, 0.8]] }),
                  ),
                )
              : Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: "connection refused",
                    }),
                  }),
                );
          }),
        ),
      );
      assert.isUndefined(yield* embedder.embed(["secret note text"], "passage"));
      assert.isUndefined(yield* embedder.embed(["a"], "query"));
      assert.equal(state.requests, 1);
      assert.lengthOf(lines, 1);
      assert.include(lines[0], "TransportError");
      assert.notInclude(lines[0], "secret note text");
      state.up = true;
      yield* TestClock.adjust("61 seconds");
      const embedded = yield* embedder.embed(["a"], "query");
      assert.equal(embedded?.model, "e5");
      assert.deepEqual(
        [...(embedded?.vectors[0] ?? [])].map((x) => Math.round(x * 10)),
        [6, 8],
      );
      // A reply that does not fit the request counts as down.
      assert.isUndefined(yield* embedder.embed(["a", "b"], "passage"));
    }).pipe(
      Effect.provide(
        Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))], {
          mergeWithExisting: false,
        }),
      ),
    );
  },
);
