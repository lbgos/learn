import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { sessionToolEventFromResult } from "@t3tools/learn/session";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as Sessions from "../../../learn/session/LearnSessionService.ts";
import { plan, problem, quiz, threadId, tutor } from "../../../learn/session/testkit.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as Access from "../../McpToolAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Handlers from "./handlers.ts";
import { LearnToolkit } from "./tools.ts";

const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("learn-handler-test"),
  issuedAt: 0,
  requestNamespace: "learn-test",
  client: undefined,
  capabilities: new Set(),
  thread: { threadId, providerInstanceId: tutor.instanceId, providerSessionId: "session" },
};
it.effect("returns gate corrections as tool failures and refuses callers outside a thread", () => {
  let calls = 0;
  const services = Layer.mock(Sessions.LearnSessionService)({
    call: () =>
      Effect.suspend(() => {
        calls += 1;
        return Effect.fail(
          new Sessions.LearnSessionCallRefused({
            tool: "plan_init",
            problems: ["Complete probe_done first."],
          }),
        );
      }),
  });
  return Effect.gen(function* () {
    const toolkit = yield* LearnToolkit;
    const refused = yield* toolkit.handle("plan_init", plan).pipe(Stream.unwrap, Stream.runCollect);
    assert.isTrue(refused[0]?.isFailure);
    assert.include(JSON.stringify(refused[0]?.encodedResult), "Complete probe_done first.");
    assert.include(JSON.stringify(refused[0]?.encodedResult), "invalid_request");
    assert.isUndefined(sessionToolEventFromResult(refused[0]?.encodedResult));
    const outside = yield* toolkit
      .handle("plan_init", plan)
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(Invocation.McpInvocationContext, { ...scope, thread: undefined }),
      );
    assert.isTrue(outside[0]?.isFailure);
    assert.include(JSON.stringify(outside[0]?.encodedResult), "thread_credential_required");
    assert.equal(calls, 1);
  }).pipe(
    Effect.provide(
      Access.HandlersLayer.layer(Handlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            services,
            liveThreadsLayer,
            Layer.succeed(Invocation.McpInvocationContext, scope),
          ),
        ),
      ),
    ),
  );
});

it.effect("ends Claude Code's turn after an accepted question and only then", () => {
  const services = Layer.mock(Sessions.LearnSessionService)({
    call: (_threadId, name, input) =>
      name === "problem"
        ? Effect.fail(new Sessions.LearnSessionCallRefused({ tool: name, problems: ["Refused."] }))
        : Effect.succeed({
            learnSession: { id: `${name}-1`, name, input, at: "2026-10-24T12:00:00.000Z" },
            message: "Recorded.",
          }),
  });
  const client = McpSchema.McpServerClient.of({
    clientId: 1,
    clientCapabilities: {},
    clientInfo: { name: "learn-test", version: "1.0.0" },
    protocolVersion: "2025-06-18",
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "learn-test", version: "1.0.0" },
    },
    getClient: Effect.die("unused"),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(Invocation.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const posed = yield* call("quiz", quiz);
    assert.isFalse(posed.isError);
    assert.deepEqual(posed._meta, { "claude/endTurn": true });
    const refused = yield* call("problem", problem);
    assert.isTrue(refused.isError);
    assert.isUndefined(refused._meta);
    assert.isUndefined((yield* call("plan_init", plan))._meta);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerLearnToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(Layer.mergeAll(services, liveThreadsLayer)),
      ),
    ),
  );
});
