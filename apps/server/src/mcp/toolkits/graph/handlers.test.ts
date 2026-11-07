import { assert, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Graph from "../../../learn/graph/LearnGraphService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { GraphToolkit } from "./tools.ts";

it.effect.each([true, false])("graph tools require a thread caller: %s", (hasThread) =>
  Effect.gen(function* () {
    let calls = 0;
    const dependencies = Layer.mergeAll(
      liveThreadsLayer,
      Layer.succeed(Invocation.McpInvocationContext, {
        environmentId: EnvironmentId.make("graph-test"),
        requestNamespace: "graph-test",
        issuedAt: 0,
        capabilities: new Set<Invocation.McpCapability>(),
        client: undefined,
        thread: hasThread
          ? {
              threadId: ThreadId.make("teach"),
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
            }
          : undefined,
      }),
      Layer.mock(Graph.LearnGraphService)({
        graphSessions: Effect.sync(() => {
          calls++;
          return "The graph tools are turned off in Settings.";
        }),
        graphPropositions: (input) =>
          Effect.sync(() => {
            calls++;
            assert.deepEqual(input, { session: "teach", query: "force" });
            return "Force causes acceleration";
          }),
      }),
    );
    const toolkit = yield* GraphToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const sessions = yield* toolkit
      .handle("graph_sessions", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies), Effect.result);
    const propositions = yield* toolkit
      .handle("graph_propositions", { session: "teach", query: "force" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies), Effect.result);
    if (hasThread) {
      assert.equal(sessions._tag, "Success");
      assert.equal(propositions._tag, "Success");
      if (sessions._tag === "Success")
        assert.equal(
          sessions.success.at(-1)?.result,
          "The graph tools are turned off in Settings.",
        );
      if (propositions._tag === "Success")
        assert.equal(propositions.success.at(-1)?.result, "Force causes acceleration");
      assert.equal(calls, 2);
    } else {
      expect(sessions).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "OrchestratorMcpFailure", code: "thread_credential_required" },
      });
      expect(propositions).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "OrchestratorMcpFailure", code: "thread_credential_required" },
      });
      assert.equal(calls, 0);
    }
  }).pipe(Effect.scoped),
);
