import {
  LEARN_ENDPOINTS,
  AuthOrchestrationOperateScope,
  LearnCreateSessionInput,
  ModelSelection,
  ThreadId,
  TurnItemId,
  LEARN_LONG_POLL_SECONDS,
  type AuthEnvironmentScope,
  type LearnActivityEntry,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";
import { authenticateHttpScope } from "../auth/http.ts";
import { graphFailure } from "./graph/graphFailure.ts";
import * as Activity from "./graph/LearnActivity.ts";
import * as Reactor from "./graph/LearnGraphReactor.ts";
import * as Graph from "./graph/LearnGraphService.ts";
import * as SessionState from "./session/LearnSessionService.ts";
import * as Sessions from "./session/LearnSessionLifecycle.ts";
import * as ModelContext from "../mcpApps/McpAppModelContext.ts";

const failure = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { message } }, { status });

const statusOf = (error: { readonly _tag: string; readonly reason?: string }) =>
  error._tag === "LearnGraphError" && error.reason === "validation"
    ? 422
    : error._tag === "LearnGraphError" && error.reason === "unavailable"
      ? 503
      : 500;

/** One POST route: authenticate, decode the JSON payload, run, encode the success. */
const route = <
  P extends Schema.Top,
  S extends Schema.Top,
  E extends { readonly _tag: string; readonly message: string; readonly reason?: string },
>(
  endpoint: {
    readonly path: HttpRouter.PathInput;
    readonly payload: P;
    readonly success: S;
    readonly scope: AuthEnvironmentScope;
  },
  handle: (payload: P["Type"]) => Effect.Effect<S["Type"], E>,
) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(endpoint.payload));
  const encode = Schema.encodeEffect(endpoint.success);
  return HttpRouter.add(
    "POST",
    endpoint.path,
    Effect.gen(function* () {
      yield* authenticateHttpScope(endpoint.scope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.text.pipe(Effect.option);
      if (Option.isNone(body)) return failure(400, "Could not read the request body.");
      const payload = yield* decode(body.value).pipe(Effect.option);
      if (Option.isNone(payload)) return failure(400, "Invalid request payload.");
      const result = yield* handle(payload.value).pipe(Effect.result);
      if (result._tag === "Failure") {
        const graphError = graphFailure(result.failure);
        return failure(
          graphError?.status ?? statusOf(result.failure),
          graphError?.message ?? result.failure.message,
        );
      }
      const encoded = yield* encode(result.success).pipe(Effect.option);
      if (Option.isNone(encoded)) return failure(500, "Could not encode the response.");
      return HttpServerResponse.jsonUnsafe(encoded.value);
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    ),
  );
};

/** First value from `changes` that `differs`, or `fallback` once the long-poll window ends. */
const longPoll = <A, E>(
  changes: Stream.Stream<A, E>,
  differs: (value: A) => boolean,
  fallback: Effect.Effect<A, E>,
) =>
  changes.pipe(
    Stream.filter(differs),
    Stream.runHead,
    Effect.timeoutOption(Duration.seconds(LEARN_LONG_POLL_SECONDS)),
    Effect.flatMap((found) =>
      Option.match(Option.flatten(found), { onNone: () => fallback, onSome: Effect.succeed }),
    ),
  );

const idsKey = (ids: ReadonlyArray<string>) => [...ids].sort().join("\n");
const entryIds = (entries: ReadonlyArray<LearnActivityEntry>) => entries.map((entry) => entry.id);

/**
 * Learn session, graph and activity routes (`LEARN_ENDPOINTS`). Services are read when the
 * layer is built, so provide the learn layer to this layer.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* Sessions.LearnSessionLifecycle;
    const sessionState = yield* SessionState.LearnSessionService;
    const modelContext = yield* ModelContext.McpAppModelContext;
    const graph = yield* Graph.LearnGraphService;
    const reactor = yield* Reactor.LearnGraphReactor;
    const activity = yield* Activity.LearnActivity;
    const E = LEARN_ENDPOINTS;
    return Layer.mergeAll(
      route(E.createSession, sessions.createSession),
      route(
        {
          path: "/api/learn/sessions/prepare-draft",
          payload: Schema.Struct({
            threadId: ThreadId,
            session: LearnCreateSessionInput,
            modelSelection: ModelSelection,
            modelSelectionExplicit: Schema.optional(Schema.Boolean),
          }),
          success: Schema.Struct({ modelSelection: ModelSelection, contextText: Schema.String }),
          scope: AuthOrchestrationOperateScope,
        },
        (input) =>
          Effect.gen(function* () {
            const prepared = yield* sessions.prepareDraft(input);
            const graph = input.session.graphContext;
            yield* modelContext.set({
              threadId: input.threadId,
              itemId: TurnItemId.make("physics:graph-session"),
              server: "physics",
              tool: "workspace",
              text: graph
                ? `[graph context]\nNode ids: ${graph.nodeIds.join(", ")}\n${graph.text}\n[/graph context]`
                : "",
            });
            return prepared;
          }),
      ),
      route(
        {
          path: "/api/learn/sessions/default-model",
          payload: Schema.Struct({ kind: Schema.Literals(["teach", "practice"]) }),
          success: ModelSelection,
          scope: E.listSessions.scope,
        },
        ({ kind }) => sessions.draftModel(kind),
      ),
      route(E.sessionState, ({ threadId, beforeOrdinal }) =>
        sessionState.stateForThread(threadId, beforeOrdinal),
      ),
      route(E.listSessions, () => sessions.listSessions),
      route(E.pauseSession, ({ threadId }) => sessions.pause(threadId)),
      route(E.graph, ({ afterRevision }) =>
        afterRevision === undefined
          ? graph.snapshot
          : longPoll(graph.subscribe, (event) => event.revision !== afterRevision, graph.snapshot),
      ),
      route(E.evidence, ({ sourceIds }) => graph.evidence(sourceIds)),
      route(E.deletionPreview, ({ sourceId }) => graph.deletionPreview(sourceId)),
      route(E.deleteSource, ({ sourceId }) => graph.deleteSource(sourceId)),
      route(E.importNotes, graph.importNotes),
      route(E.extractNow, ({ threadId }) => reactor.extractNow(threadId)),
      route(E.coverage, ({ threadId }) => graph.coverageSummary(threadId)),
      route(E.review, () => graph.reviewSummary),
      route(E.putPositions, ({ positions }) => graph.putPositions(positions).pipe(Effect.as({}))),
      route(E.activity, ({ knownIds }) =>
        knownIds === undefined
          ? activity.current
          : longPoll(
              activity.changes,
              (entries) => idsKey(entryIds(entries)) !== idsKey(knownIds),
              activity.current,
            ),
      ),
      route(E.activityStop, ({ id }) =>
        activity.stop(id).pipe(Effect.map((stopped) => ({ stopped }))),
      ),
    );
  }),
).pipe(Layer.provide(ModelContext.layer));
