import { assert, it } from "@effect/vitest";
import {
  DEFAULT_LEARN_ROUTES,
  NodeId,
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LearnRoutingContext from "./LearnRoutingContext.ts";
import * as LearnModelRouter from "./LearnModelRouter.ts";
import * as LearnMemoryTurns from "./memory/LearnMemoryTurns.ts";
import * as Sessions from "./session/LearnSessionService.ts";
import * as LearnSessionStore from "./session/LearnSessionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

it.effect(
  "limits route and job context to registered tutors and refreshes availability each turn",
  () => {
    const threadId = ThreadId.make("learning-context");
    const thread = { ...liveThreadShell(threadId), projectId: ProjectId.make("learning-project") };
    const selection = DEFAULT_LEARN_ROUTES.transcript!;
    let disabled = false;
    let sessionContext = "phase: teach\nplan: current period";
    let settingsUnavailable = false;
    const now = DateTime.makeUnsafe(0);
    const job: OrchestrationV2Subagent = {
      id: NodeId.make("node:research"),
      threadId,
      runId: null,
      parentNodeId: NodeId.make("node:root"),
      origin: "app_owned",
      createdBy: "agent",
      driver: ProviderDriverKind.make("antigravity"),
      providerInstanceId: selection.instanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Research",
      title: "Research: pendulum period",
      model: null,
      completionDelivery: { state: "disposed", observedByRunId: null },
      status: "completed",
      result: "T = 2π√(L/g)",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(Sessions.LearnSessionService)({
        contextForThread: () => Effect.sync(() => sessionContext),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: () => Effect.succeed({ subagents: [job], runs: [] } as never),
      }),
      Layer.mock(LearnSessionStore.LearnSessionStore)({
        get: (id) =>
          Effect.succeed(
            id === threadId
              ? { threadId, kind: "teach", mechanic: "choice", createdAt: "2026-10-26T00:00:00Z" }
              : null,
          ),
      }),
      Layer.mock(LearnModelRouter.LearnModelRouter)({
        snapshot: () =>
          settingsUnavailable
            ? Effect.fail(new ServerSettingsError({ operation: "read-file", settingsPath: "test" }))
            : Effect.succeed([{ role: "transcript", selection, availability: "configured" }]),
      }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([selection.instanceId]),
      }),
      Layer.mock(LearnMemoryTurns.LearnMemoryTurns)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.sync(() => [
          {
            instanceId: selection.instanceId,
            driver: ProviderDriverKind.make("antigravity"),
            enabled: !disabled,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-10-26T00:00:00Z",
            models: [
              { slug: selection.model, name: selection.model, isCustom: false, capabilities: null },
            ],
            slashCommands: [],
            skills: [],
          },
        ]),
      }),
    );
    return Effect.gen(function* () {
      const context = yield* LearnRoutingContext.LearnRoutingContext;
      assert.isUndefined(yield* context.forTurn({ ...thread, id: ThreadId.make("ordinary") }));
      assert.isUndefined(
        yield* context.forTurn({
          ...thread,
          lineage: { ...thread.lineage, relationshipToParent: "subagent" },
        }),
      );
      assert.include((yield* context.forTurn(thread))!, "configured");
      assert.equal(yield* context.sessionForTurn(thread), sessionContext);
      sessionContext = "phase: teach\nplan: current force";
      assert.equal(yield* context.sessionForTurn(thread), sessionContext);
      assert.isUndefined(
        yield* context.sessionForTurn({ ...thread, id: ThreadId.make("ordinary") }),
      );
      assert.isUndefined(
        yield* context.jobsForTurn({ ...thread, id: ThreadId.make("ordinary") }, { ordinal: 2 }),
      );
      assert.include(yield* context.jobsForTurn(thread, { ordinal: 2 }), "T = 2π√(L/g)");
      disabled = true;
      assert.include(
        (yield* context.forTurn(thread))!,
        "unavailable: Provider instance is disabled.",
      );
      settingsUnavailable = true;
      const failed = yield* context.forTurn(thread);
      assert.include(failed!, "Learning routing unavailable");
      assert.notInclude(failed!, selection.model);
    }).pipe(Effect.provide(LearnRoutingContext.layer.pipe(Layer.provide(dependencies))));
  },
);

it.effect("notes the break on the first run requested after a pause and only there", () => {
  const threadId = ThreadId.make("paused-session");
  const thread = { ...liveThreadShell(threadId), projectId: ProjectId.make("learning-project") };
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  let pausedAt: string | undefined = "2026-11-03T12:00:00.000Z";
  const runs = [
    {
      ordinal: 1,
      requestedAt: at("2026-11-03T11:30:00.000Z"),
      startedAt: at("2026-11-03T11:30:00.000Z"),
    },
    {
      ordinal: 2,
      requestedAt: at("2026-11-03T11:50:00.000Z"),
      startedAt: at("2026-11-03T12:47:00.000Z"),
    },
    {
      ordinal: 3,
      requestedAt: at("2026-11-03T11:55:00.000Z"),
      startedAt: at("2026-11-03T12:50:00.000Z"),
    },
  ];
  const dependencies = Layer.mergeAll(
    Layer.mock(Sessions.LearnSessionService)({
      contextForThread: () => Effect.succeed("phase: teach\nplan: current period"),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: () => Effect.succeed({ runs } as never),
    }),
    Layer.mock(LearnSessionStore.LearnSessionStore)({
      get: () =>
        Effect.sync(() => ({
          threadId,
          kind: "teach",
          mechanic: "choice",
          createdAt: "2026-11-03T11:00:00.000Z",
          ...(pausedAt === undefined ? {} : { pausedAt }),
        })),
    }),
    Layer.mock(LearnModelRouter.LearnModelRouter)({}),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
    Layer.mock(LearnMemoryTurns.LearnMemoryTurns)({}),
  );
  return Effect.gen(function* () {
    const context = yield* LearnRoutingContext.LearnRoutingContext;
    const [interrupted, resumed, next] = runs;
    // The run the pause interrupted, or a restart of it, is not a return.
    assert.isUndefined(yield* context.breakForTurn(thread, interrupted!));
    assert.equal(
      yield* context.breakForTurn(thread, resumed!),
      "The learner paused the session and is back after 47 min: a long break.",
    );
    assert.isUndefined(yield* context.breakForTurn(thread, next!));
    pausedAt = "2026-11-03T12:46:00.000Z";
    assert.include(yield* context.breakForTurn(thread, resumed!), "after 1 min: a short break");
    pausedAt = undefined;
    assert.isUndefined(yield* context.breakForTurn(thread, resumed!));
  }).pipe(Effect.provide(LearnRoutingContext.layer.pipe(Layer.provide(dependencies))));
});
