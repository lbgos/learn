import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  MessageId,
  ThreadId,
  ProjectId,
  ModelSelection,
  ProviderUserInputAnswers,
  ProviderApprovalDecision,
  RuntimeRequestId,
  WsRpcGroup,
  ORCHESTRATION_V2_WS_METHODS as Methods,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_PROTOCOL_HEADER,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Configuration from "./Configuration.ts";

export const ListInput = Schema.Struct({
  environment: Configuration.EnvironmentName,
  projectId: Schema.optional(ProjectId),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const ReadInput = Schema.Struct({
  environment: Configuration.EnvironmentName,
  threadId: ThreadId,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const SendInput = Schema.Struct({
  environment: Configuration.EnvironmentName,
  threadId: ThreadId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100000)),
});
export const AnswerInput = Schema.Struct({
  environment: Configuration.EnvironmentName,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  answers: Schema.optional(ProviderUserInputAnswers),
  decision: Schema.optional(ProviderApprovalDecision),
});
export const LaunchInput = Schema.Struct({
  environment: Configuration.EnvironmentName,
  projectId: ProjectId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  modelSelection: ModelSelection,
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(100000))),
});

export class RemoteEnvironmentError extends Schema.TaggedError<RemoteEnvironmentError>()(
  "RemoteEnvironmentError",
  { reason: Schema.Literals(["unavailable", "invalid-answer"]) },
) {
  override get message() {
    return this.reason === "invalid-answer"
      ? "Provide answers or a decision, but not both."
      : "Remote request failed. Check the environment URL, session scopes, expiry and server version. Delivery may be uncertain; read the thread before retrying a write.";
  }
}
type Failure = RemoteEnvironmentError | Configuration.RemoteConfigurationError;
export class RemoteEnvironments extends Context.Service<
  RemoteEnvironments,
  {
    readonly list: (input: typeof ListInput.Type) => Effect.Effect<string, Failure>;
    readonly read: (input: typeof ReadInput.Type) => Effect.Effect<string, Failure>;
    readonly send: (input: typeof SendInput.Type) => Effect.Effect<string, Failure>;
    readonly answer: (input: typeof AnswerInput.Type) => Effect.Effect<string, Failure>;
    readonly launch: (input: typeof LaunchInput.Type) => Effect.Effect<string, Failure>;
  }
>()("t3/remote/RemoteEnvironments") {}

const makeClient = RpcClient.make(WsRpcGroup, { disableTracing: true });
const make = Effect.gen(function* () {
  const configuration = yield* Configuration.Configuration;
  const crypto = yield* Crypto.Crypto;
  const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const call = Effect.fn("RemoteEnvironments.call")(function* <E, R>(
    environment: string,
    run: (client: Effect.Success<typeof makeClient>) => Effect.Effect<string, E, R>,
  ) {
    const settings = yield* configuration.resolve(environment);
    const url = new URL("/ws", settings.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
    const protocol = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
        pingTimeout: "15 seconds",
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeSocket.layerWebSocket(url.href, {
            openTimeout: "10 seconds",
            headers: {
              authorization: `Bearer ${Redacted.value(settings.token)}`,
              [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
            },
          }),
          RpcSerialization.layerJson,
        ),
      ),
    );
    // One scoped connection per operation. Writes are never retried after an uncertain disconnect.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* run(client);
      }).pipe(Effect.provide(protocol)),
    ).pipe(
      Effect.timeout("30 seconds"),
      Effect.map((text) => text.replaceAll(Redacted.value(settings.token), "[redacted]")),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.fail(new RemoteEnvironmentError({ reason: "unavailable" })),
      ),
    );
  });
  return RemoteEnvironments.of({
    list: Effect.fn("RemoteEnvironments.list")((input) =>
      call(input.environment, (client) =>
        Effect.gen(function* () {
          const first = yield* client[Methods.subscribeShell]({}).pipe(
            Stream.filter((item) => item.kind === "snapshot"),
            Stream.runHead,
          );
          if (Option.isNone(first))
            return yield* new RemoteEnvironmentError({ reason: "unavailable" });
          const { projects, threads } = first.value.snapshot;
          const matches = threads.filter(
            (t) => !input.projectId || t.projectId === input.projectId,
          );
          const offset = input.offset ?? 0;
          return yield* json({
            projects: projects.map(({ id, title, workspaceRoot, defaultModelSelection }) => ({
              id,
              title,
              workspaceRoot,
              defaultModelSelection,
            })),
            total: matches.length,
            threads: matches
              .slice(offset, offset + (input.limit ?? 50))
              .map(({ id, projectId, title, status, modelSelection }) => ({
                id,
                projectId,
                title,
                status,
                modelSelection,
              })),
          });
        }),
      ),
    ),
    read: Effect.fn("RemoteEnvironments.read")((input) =>
      call(input.environment, (client) =>
        client[Methods.getThreadProjection]({ threadId: input.threadId }).pipe(
          Effect.flatMap((p) => {
            const pendingRequests = p.runtimeRequests.filter((r) => r.status === "pending");
            const pendingIds = new Set(pendingRequests.map((r) => r.id));
            return json({
              thread: p.thread,
              messages: p.messages.slice(-(input.limit ?? 20)),
              pendingRequests,
              requestItems: p.turnItems.filter(
                (item) => "requestId" in item && pendingIds.has(item.requestId),
              ),
              recentItems: p.turnItems.slice(-(input.limit ?? 20)),
            });
          }),
        ),
      ),
    ),
    send: Effect.fn("RemoteEnvironments.send")((input) =>
      call(input.environment, (client) =>
        Effect.gen(function* () {
          return yield* client[Methods.dispatchCommand]({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(yield* crypto.randomUUIDv4()),
            threadId: input.threadId,
            messageId: MessageId.make(yield* crypto.randomUUIDv4()),
            text: input.text,
            attachments: [],
            deliveryIntent: "auto",
            dispatchMode: { type: "queue_after_active" },
          }).pipe(Effect.flatMap(json));
        }),
      ),
    ),
    answer: Effect.fn("RemoteEnvironments.answer")((input) => {
      if ((input.answers === undefined) === (input.decision === undefined))
        return Effect.fail(new RemoteEnvironmentError({ reason: "invalid-answer" }));
      return call(input.environment, (client) =>
        Effect.gen(function* () {
          return yield* client[Methods.dispatchCommand]({
            type: "runtime-request.respond",
            commandId: CommandId.make(yield* crypto.randomUUIDv4()),
            threadId: input.threadId,
            requestId: input.requestId,
            ...(input.answers === undefined ? {} : { answers: input.answers }),
            ...(input.decision === undefined ? {} : { decision: input.decision }),
          }).pipe(Effect.flatMap(json));
        }),
      );
    }),
    launch: Effect.fn("RemoteEnvironments.launch")((input) =>
      call(input.environment, (client) =>
        Effect.gen(function* () {
          return yield* client[Methods.launchThread]({
            commandId: CommandId.make(yield* crypto.randomUUIDv4()),
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            ...(input.text === undefined
              ? {}
              : { initialMessage: { text: input.text, attachments: [] } }),
          }).pipe(Effect.flatMap(({ threadId, resumed }) => json({ threadId, resumed })));
        }),
      ),
    ),
  });
});
export const layer = Layer.effect(RemoteEnvironments, make);
