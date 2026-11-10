import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/**
 * Read-only search over the learner's context kept outside Learn, set by `LEARN_CONTEXT_SOURCE_URL`
 * and `LEARN_CONTEXT_SOURCE_TOKEN`. `POST <url>` with a bearer token and `{ query, limit }` answers
 * `{ results: [{ text, at?, label?, status? }] }`. Learn never writes there.
 */
export class ContextSource extends Context.Service<
  ContextSource,
  {
    readonly search: (input: {
      readonly query: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<ContextResult>, ContextSourceError>;
  }
>()("t3/learn/memory/ContextSource") {}

export class ContextSourceError extends Schema.TaggedError<ContextSourceError>()(
  "ContextSourceError",
  { reason: Schema.String },
) {
  override get message() {
    return "The personal context source is unavailable.";
  }
}

/** Longest text kept from one result, so a misbehaving source cannot flood a turn. */
const RESULT_CHARS = 600;
const MAX_RESULTS = 10;

const Result = Schema.Struct({
  text: Schema.String,
  at: Schema.optional(Schema.String),
  /** Where the result comes from, such as which assistant holds the note. */
  label: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
export type ContextResult = typeof Result.Type;
const decodeReply = Schema.decodeUnknownEffect(Schema.Struct({ results: Schema.Array(Result) }));

const make = Effect.fn("ContextSource.make")(function* (url: string, token: Redacted.Redacted) {
  const http = yield* HttpClient.HttpClient;
  return ContextSource.of({
    search: Effect.fn("ContextSource.search")(
      function* ({ query, limit }) {
        const request = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.bodyJson({ query, limit }),
        );
        const response = yield* http.execute(request);
        if (response.status !== 200) return yield* Effect.fail(`status ${response.status}`);
        const reply = yield* decodeReply(yield* response.json);
        return reply.results.slice(0, Math.min(limit, MAX_RESULTS)).map((result) => ({
          ...result,
          text: result.text.slice(0, RESULT_CHARS),
          ...(result.label === undefined ? {} : { label: result.label.slice(0, 80) }),
          ...(result.at === undefined ? {} : { at: result.at.slice(0, 10) }),
        }));
      },
      Effect.timeout("5 seconds"),
      // Request errors carry the body, which holds the query: log the tag only.
      Effect.mapError(
        (cause) =>
          new ContextSourceError({
            reason:
              typeof cause === "string"
                ? cause
                : typeof cause === "object" && cause !== null && "_tag" in cause
                  ? String(cause._tag)
                  : "unknown",
          }),
      ),
    ),
  });
});

/** The source's URL and token from the environment, or none when either is unset. */
export const configured = Effect.gen(function* () {
  const url = (yield* Config.String("LEARN_CONTEXT_SOURCE_URL").pipe(
    Config.withDefault(""),
  )).trim();
  const token = yield* Config.Redacted("LEARN_CONTEXT_SOURCE_TOKEN").pipe(Config.option);
  return url === "" || Option.isNone(token)
    ? Option.none()
    : Option.some({ url, token: token.value });
});

/** The configured source, or no service: `LearnMemoryService` then has no context search. */
export const layer = Layer.unwrap(
  configured.pipe(
    Effect.map(
      Option.match({
        onNone: () => Layer.empty,
        onSome: ({ url, token }) =>
          Layer.effect(ContextSource, make(url, token)).pipe(Layer.provide(FetchHttpClient.layer)),
      }),
    ),
  ),
);
