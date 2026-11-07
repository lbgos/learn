import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import {
  EventId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadLaunchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Configuration from "./Configuration.ts";
import * as Remote from "./RemoteEnvironments.ts";
import { emptyProjection, threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";

const now = DateTime.makeUnsafe("2026-10-27T00:00:00Z");
const threadId = ThreadId.make("remote-thread");
const projectId = ProjectId.make("remote-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const projection = emptyProjection({
  id: EventId.make("created"),
  type: "thread.created",
  threadId,
  occurredAt: now,
  payload: {
    id: threadId,
    projectId,
    title: "Remote test",
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  },
});
const encodeShell = Schema.encodeSync(OrchestrationV2ShellStreamItem);
const encodeProjection = Schema.encodeSync(OrchestrationV2ThreadProjection);
const encodeLaunch = Schema.encodeSync(OrchestrationV2ThreadLaunchResult);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.String,
      id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      tag: Schema.optional(Schema.String),
      payload: Schema.optional(Schema.Unknown),
    }),
  ),
);
const requests: Array<{ tag: string; payload: unknown }> = [];
const withServer = (mode: "success" | "failure" | "disconnect" | "malformed" = "success") =>
  Effect.gen(function* () {
    requests.length = 0;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ port: 0, host: "127.0.0.1" })),
      (s) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const c of s.clients) c.terminate();
              s.close(() => resolve());
            }),
        ),
    );
    if (!server.address())
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.once("listening", resolve)),
      );
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("No test port");
    server.on("connection", (socket, req) => {
      expect(req.headers.authorization).toBe("Bearer fake-session");
      expect(req.headers["x-t3-orchestration-protocol"]).toBe("2");
      expect(req.url).toBe("/ws?orchestrationProtocol=2");
      socket.on("message", (raw) => {
        const request = decodeFrame(String(raw));
        if (request._tag !== "Request" || !request.tag) return;
        requests.push({ tag: request.tag, payload: request.payload });
        if (mode === "disconnect") {
          socket.close();
          return;
        }
        if (mode === "malformed") {
          socket.send("invalid json");
          return;
        }
        if (mode === "failure") {
          socket.send(
            encode({
              _tag: "Exit",
              requestId: request.id,
              exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "fake-session" }] },
            }),
          );
          return;
        }
        let value: unknown = { sequence: 7 };
        if (request.tag === "orchestration.subscribeShell") {
          socket.send(
            encode({
              _tag: "Chunk",
              requestId: request.id,
              values: [
                encodeShell({
                  kind: "snapshot",
                  snapshot: {
                    schemaVersion: 1,
                    snapshotSequence: 0,
                    projects: [],
                    archivedThreads: [],
                    threads: [threadShellFromProjection(projection)],
                  },
                }),
              ],
            }),
          );
          return;
        }
        if (request.tag === "orchestration.getThreadProjection")
          value = encodeProjection(projection);
        if (request.tag === "orchestration.launchThread")
          value = encodeLaunch({
            threadId,
            projection,
            resumed: false,
          });
        socket.send(
          encode([
            { _tag: "Ping" },
            { _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value } },
          ]),
        );
      });
    });
    const context = yield* Layer.build(
      Remote.layer.pipe(
        Layer.provide(
          Layer.succeed(Configuration.Configuration, {
            list: Effect.succeed([{ name: "test", baseUrl: `http://127.0.0.1:${address.port}` }]),
            resolve: () =>
              Effect.succeed({
                baseUrl: `http://127.0.0.1:${address.port}`,
                token: Redacted.make("fake-session"),
              }),
            set: () => Effect.void,
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    );
    return Context.get(context, Remote.RemoteEnvironments);
  });
describe("remote WebSocket RPC", () => {
  it.live("lists, reads, sends, answers and launches using the fork contracts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const remote = yield* withServer();
        expect(yield* remote.list({ environment: "test" })).toContain("Remote test");
        expect(yield* remote.read({ environment: "test", threadId })).toContain("Remote test");
        expect(yield* remote.send({ environment: "test", threadId, text: "Hello B" })).toBe(
          '{"sequence":7}',
        );
        yield* remote.answer({
          environment: "test",
          threadId,
          requestId: RuntimeRequestId.make("request"),
          answers: { choice: "yes" },
        });
        yield* remote.answer({
          environment: "test",
          threadId,
          requestId: RuntimeRequestId.make("approval"),
          decision: "decline",
        });
        expect(
          yield* remote.launch({
            environment: "test",
            projectId,
            title: "Launch",
            modelSelection,
            text: "Start",
          }),
        ).toContain("remote-thread");
        expect(requests.map((r) => r.tag)).toEqual([
          "orchestration.subscribeShell",
          "orchestration.getThreadProjection",
          "orchestration.dispatchCommand",
          "orchestration.dispatchCommand",
          "orchestration.dispatchCommand",
          "orchestration.launchThread",
        ]);
        expect(requests[2]?.payload).toMatchObject({
          type: "message.dispatch",
          text: "Hello B",
          createdBy: "agent",
          creationSource: "mcp",
          deliveryIntent: "auto",
        });
        expect(requests[3]?.payload).toMatchObject({
          type: "runtime-request.respond",
          answers: { choice: "yes" },
        });
        expect(requests[4]?.payload).toMatchObject({ decision: "decline" });
        expect(requests[5]?.payload).toMatchObject({
          projectId,
          runtimeMode: "full-access",
          workspaceStrategy: { type: "root" },
        });
      }),
    ),
  );
  it.live.each(["failure", "disconnect", "malformed"] as const)(
    "sanitizes %s and never retries a write",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const remote = yield* withServer(mode);
          const error = yield* remote
            .send({ environment: "test", threadId, text: "hello" })
            .pipe(Effect.flip);
          expect(error._tag).toBe("RemoteEnvironmentError");
          expect(error.message).not.toContain("fake-session");
          expect(requests).toHaveLength(1);
        }),
      ),
  );
  it.live("rejects ambiguous and empty answers before connecting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const remote = yield* withServer();
        for (const extra of [{}, { answers: {}, decision: "accept" as const }]) {
          const error = yield* remote
            .answer({
              environment: "test",
              threadId,
              requestId: RuntimeRequestId.make("request"),
              ...extra,
            })
            .pipe(Effect.flip);
          expect(error.message).toContain("but not both");
        }
        expect(requests).toHaveLength(0);
      }),
    ),
  );
});
