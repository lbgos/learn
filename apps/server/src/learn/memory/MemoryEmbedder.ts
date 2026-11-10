import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export interface Embedded {
  /** The model that made the vectors; vectors of different models do not compare. */
  readonly model: string;
  /** Unit-length vectors, one per text, in order. */
  readonly vectors: ReadonlyArray<Float32Array>;
}

/**
 * Dense vectors for memory notes and recall queries, from an embedding service that speaks
 * `apps/cortex/src/embedServer.ts`'s protocol (Cortex's multilingual-e5-small). Run it on the same
 * host so notes stay there. Search treats an undefined answer as "lexical only".
 */
export class MemoryEmbedder extends Context.Service<
  MemoryEmbedder,
  {
    /** Undefined while the embedder is off, unreachable or answers wrongly; never fails. */
    readonly embed: (
      texts: ReadonlyArray<string>,
      kind: "query" | "passage",
    ) => Effect.Effect<Embedded | undefined>;
  }
>()("t3/learn/memory/MemoryEmbedder") {}

const Reply = Schema.Struct({
  model: Schema.String,
  dimensions: Schema.Number,
  vectors: Schema.Array(Schema.Array(Schema.Number)),
});
const decodeReply = Schema.decodeUnknownEffect(Reply);

/** After a failure the embedder is left alone this long, so turns do not each wait on its timeout. */
const RETRY_MS = 60_000;
/** A turn waits this long for its query's vector; a backfill batch of passages much longer. */
const TIMEOUT = { query: "2 seconds", passage: "60 seconds" } as const;

/**
 * What failed, by tag or the reply check's own words. HTTP errors carry the request, whose body
 * holds note and query text, so the error itself is never logged.
 */
const failureReason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (typeof error === "string") return error;
  if (!Predicate.hasProperty(error, "_tag")) return "unknown";
  const reason = Predicate.hasProperty(error, "reason") ? error.reason : undefined;
  return Predicate.hasProperty(reason, "_tag")
    ? `${String(error._tag)}: ${String(reason._tag)}`
    : String(error._tag);
};

export const make = Effect.fn("MemoryEmbedder.make")(function* (url: string) {
  const http = yield* HttpClient.HttpClient;
  let down = false;
  let retryAt = 0;
  const request = Effect.fn("MemoryEmbedder.request")(function* (
    texts: ReadonlyArray<string>,
    kind: "query" | "passage",
  ) {
    const response = yield* http.execute(
      yield* HttpClientRequest.post(`${url}/embed`).pipe(
        HttpClientRequest.bodyJson({ texts, query: kind === "query" }),
      ),
    );
    if (response.status !== 200) return yield* Effect.fail(`status ${response.status}`);
    const reply = yield* decodeReply(yield* response.json);
    if (
      reply.dimensions <= 0 ||
      reply.vectors.length !== texts.length ||
      reply.vectors.some((vector) => vector.length !== reply.dimensions)
    )
      return yield* Effect.fail("malformed reply");
    return {
      model: reply.model,
      vectors: reply.vectors.map((vector) => Float32Array.from(vector)),
    };
  });
  return MemoryEmbedder.of({
    embed: Effect.fn("MemoryEmbedder.embed")(function* (
      texts: ReadonlyArray<string>,
      kind: "query" | "passage",
    ) {
      if (texts.length === 0) return { model: "", vectors: [] };
      if (down && (yield* Clock.currentTimeMillis) < retryAt) return undefined;
      return yield* request(texts, kind).pipe(
        Effect.timeout(TIMEOUT[kind]),
        Effect.tap(() =>
          down
            ? Effect.logInfo("Memory embedder answers again; recall is hybrid.").pipe(
                Effect.andThen(Effect.sync(() => (down = false))),
              )
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            retryAt = (yield* Clock.currentTimeMillis) + RETRY_MS;
            if (!down)
              yield* Effect.logWarning(
                "Memory embedder unavailable; recall is lexical only until it answers.",
                { url, reason: failureReason(cause) },
              );
            down = true;
            return undefined;
          }),
        ),
      );
    }),
  });
});

/** No embedder: search stays lexical. */
const layerOff = Layer.succeed(MemoryEmbedder, {
  embed: Effect.fn("MemoryEmbedder.embedOff")(() => Effect.undefined),
});

/** The embedder at `LEARN_MEMORY_EMBED_URL`; unset, memory search is lexical only. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const url = (yield* Config.String("LEARN_MEMORY_EMBED_URL").pipe(
      Config.withDefault(""),
    )).trim();
    return url === "" || url === "off"
      ? layerOff
      : Layer.effect(MemoryEmbedder, make(url.replace(/\/+$/, ""))).pipe(
          Layer.provide(FetchHttpClient.layer),
        );
  }),
);
