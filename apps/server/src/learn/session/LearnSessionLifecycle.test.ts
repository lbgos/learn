import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ThreadId,
  type LearnRole,
  type LearnSessionSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as Workspace from "../../physics/PhysicsWorkspaceService.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Providers from "../../provider/testUtils/providerRegistryMock.ts";
import * as Settings from "../../serverSettings.ts";
import * as Launch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Graph from "../graph/LearnGraphService.ts";
import * as Router from "../LearnModelRouter.ts";
import * as Store from "./LearnSessionStore.ts";
import * as Lifecycle from "./LearnSessionLifecycle.ts";
import { now, practice, projection, threadId, tutor } from "./testkit.ts";

const shell = liveThreadShell(threadId);
const project = {
  id: shell.projectId,
  title: "Lab",
  workspaceRoot: "/isolated-lab",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: tutor,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-10-24T12:00:00.000Z",
  updatedAt: "2026-10-24T12:00:00.000Z",
  deletedAt: null,
};
const provider: ServerProvider = {
  instanceId: tutor.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-24T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
function fixture(failure?: "unset" | "instance-disabled") {
  const records = new Map<ThreadId, Store.StoredLearnSession>();
  const launches: Launch.ThreadLaunchInput[] = [];
  const sends: Threads.ThreadManagementSendInput[] = [];
  const interrupts: Threads.ThreadManagementInterruptInput[] = [];
  const roles: LearnRole[] = [];
  const latest: { requestedAt?: DateTime.Utc } = {};
  const dependencyLayer = Layer.mergeAll(
    Layer.succeed(Workspace.PhysicsWorkspaceService, {
      ensureLab: Effect.succeed({
        projectId: project.id,
        workspaceRoot: project.workspaceRoot,
        created: false,
        unmanagedInstructionFiles: [],
      }),
    }),
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    Providers.layer([provider]),
    Settings.layerTest(),
    NodeServices.layer,
    Layer.mock(Graph.LearnGraphService)({
      dueForReview: (limit) =>
        Effect.succeed(
          [
            {
              id: "n_swing",
              name: "Small-angle period",
              statement: "For small swings $T = 2\\pi\\sqrt{L/g}$.",
              aliases: [],
              createdAt: "2026-10-20T12:00:00.000Z",
              provenance: [{ chatId: "earlier", messageId: "m" }],
            },
          ].slice(0, limit),
        ),
    }),
    Layer.succeed(Router.LearnModelRouter, {
      snapshot: () => Effect.die("unused snapshot"),
      resolve: (role) =>
        Effect.suspend(() => {
          roles.push(role);
          return failure
            ? Effect.fail(new Router.LearnRouteUnavailable({ role, reason: failure }))
            : Effect.succeed(role === "practice" ? practice : tutor);
        }),
    }),
    Layer.succeed(Store.LearnSessionStore, {
      update: (id, change) =>
        Effect.sync(() => {
          const next = change(records.get(id) ?? null);
          if (next) records.set(id, next);
          return next;
        }),
      get: (id) => Effect.sync(() => records.get(id) ?? null),
      put: (record) =>
        Effect.sync(() => {
          records.set(record.threadId, record);
        }),
      list: Effect.sync(() => [...records.values()]),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          return { threadId, projection: projection(), resumed: false };
        }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      listProjectThreads: () =>
        Effect.sync(() => [
          { ...shell, latestRunRequestedAt: latest.requestedAt ?? null },
          { ...shell, id: ThreadId.make("legacy") },
          { ...shell, id: ThreadId.make("deleted"), deletedAt: now },
        ]),
      interruptThread: (input) =>
        Effect.sync(() => {
          assert.isDefined(records.get(input.threadId)?.pausedAt, "pause must precede the stop");
          interrupts.push(input);
          return { type: "no_active_run" as const };
        }),
      sendToThread: (input) =>
        Effect.sync(() => {
          assert.isDefined(records.get(input.threadId), "metadata must precede the first turn");
          sends.push(input);
          const snapshot = projection();
          const run = snapshot.runs[0]!;
          return {
            dispatch: { sequence: 1, storedEvents: [] },
            projection: snapshot,
            message: {
              id: input.messageId,
              threadId,
              runId: run.id,
              nodeId: null,
              role: "user" as const,
              text: input.text,
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            },
            run,
            turnItem: null,
            delivery: "started" as const,
          };
        }),
    }),
  );
  return {
    records,
    launches,
    sends,
    interrupts,
    latest,
    roles,
    layer: Lifecycle.layer.pipe(Layer.provide(dependencyLayer)),
  };
}
it.effect("creates a routed practice Lab thread and sends graph context after metadata", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const sessions = yield* Lifecycle.LearnSessionLifecycle;
    const created = yield* sessions.createSession({
      kind: "practice",
      title: "Period",
      graphContext: { nodeIds: ["n_period"], text: "A cycle repeats." },
    });
    assert.deepEqual(created, { threadId });
    assert.deepEqual(f.roles, ["practice"]);
    assert.deepEqual(f.launches[0]?.modelSelection, practice);
    assert.deepEqual(f.launches[0]?.workspaceStrategy, { type: "root" });
    assert.equal(f.launches[0]?.projectId, project.id);
    assert.equal(f.launches[0]?.title, "Period");
    assert.equal(f.records.get(threadId)?.kind, "practice");
    assert.deepEqual(f.records.get(threadId)?.lastRoutedModel, practice);
    assert.isTrue(f.sends[0]?.text.startsWith("[graph context]\n"));
    assert.include(f.sends[0]?.text ?? "", "n_period");
    const listed = yield* sessions.listSessions;
    assert.deepEqual(
      listed.map((entry) => entry.kind),
      ["practice", "teach"],
    );
    assert.deepEqual(listed[0]?.graphContext, { nodeIds: ["n_period"] });
    assert.isFalse("lastRoutedModel" in listed[0]!);
  }).pipe(Effect.provide(f.layer));
});
it.effect(
  "starts teach on the planning route and uses the composer default only when routing is unset",
  () => {
    const routed = fixture();
    const unset = fixture("unset");
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* (yield* Lifecycle.LearnSessionLifecycle).createSession({ kind: "teach" });
        assert.deepEqual(routed.roles, ["planning"]);
        assert.deepEqual(routed.launches[0]?.modelSelection, tutor);
        assert.isEmpty(routed.sends);
      }).pipe(Effect.provide(routed.layer));
      yield* Effect.gen(function* () {
        yield* (yield* Lifecycle.LearnSessionLifecycle).createSession({ kind: "practice" });
        assert.deepEqual(unset.launches[0]?.modelSelection, tutor);
        assert.deepEqual(unset.records.get(threadId)?.lastRoutedModel, tutor);
      }).pipe(Effect.provide(unset.layer));
    });
  },
);
it.effect(
  "returns the router's corrective message and never creates a thread for a disabled route",
  () => {
    const f = fixture("instance-disabled");
    return Effect.gen(function* () {
      const sessions = yield* Lifecycle.LearnSessionLifecycle;
      const error = yield* sessions.createSession({ kind: "teach" }).pipe(Effect.flip);
      assert.include(error.message, "disabled");
      assert.include(error.message, "planning");
      assert.isEmpty(f.launches);
      assert.equal(f.records.size, 0);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["teach", "practice"] as const)(
  "prepares a %s draft without creating a thread or starting a turn",
  (kind) => {
    const f = fixture();
    return Effect.gen(function* () {
      const sessions = yield* Lifecycle.LearnSessionLifecycle;
      const prepared = yield* sessions.prepareDraft({
        threadId,
        session: { kind, graphContext: { nodeIds: ["n_period"], text: "A cycle repeats." } },
        modelSelection: tutor,
      });
      assert.deepEqual(prepared.modelSelection, kind === "teach" ? tutor : practice);
      assert.include(prepared.contextText, `session: ${kind}`);
      assert.include(prepared.contextText, "A cycle repeats.");
      assert.include(prepared.contextText, "n_period");
      // Only teach sessions warm up on propositions due for review.
      assert.equal(
        prepared.contextText.includes("due for review:\n- n_swing | Small-angle period"),
        kind === "teach",
      );
      assert.equal(f.records.get(threadId)?.kind, kind);
      assert.equal(f.launches.length, 0);
      assert.equal(f.sends.length, 0);
      const again = yield* sessions.prepareDraft({
        threadId,
        session: { kind },
        modelSelection: tutor,
      });
      assert.deepEqual(again.modelSelection, prepared.modelSelection);
      assert.equal(f.records.size, 1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("resolves each draft kind through Learning routes without creating anything", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const sessions = yield* Lifecycle.LearnSessionLifecycle;
    assert.deepEqual(yield* sessions.draftModel("teach"), tutor);
    assert.deepEqual(yield* sessions.draftModel("practice"), practice);
    assert.deepEqual(f.roles, ["tutor", "practice"]);
    assert.isEmpty(f.launches);
    assert.isEmpty(f.records);
  }).pipe(Effect.provide(f.layer));
});

it.effect("keeps an explicit picker selection and disables automatic phase rerouting", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const sessions = yield* Lifecycle.LearnSessionLifecycle;
    const prepared = yield* sessions.prepareDraft({
      threadId,
      session: { kind: "practice" },
      modelSelection: tutor,
      modelSelectionExplicit: true,
    });
    assert.deepEqual(prepared.modelSelection, tutor);
    assert.equal(f.records.get(threadId)?.manuallyOverridden, true);
    assert.isEmpty(f.roles);
  }).pipe(Effect.provide(f.layer));
});

it.effect("pause marks the session, stops its turn, and holds until the next run", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const sessions = yield* Lifecycle.LearnSessionLifecycle;
    yield* sessions.prepareDraft({ threadId, session: { kind: "teach" }, modelSelection: tutor });
    f.latest.requestedAt = DateTime.makeUnsafe(0);
    yield* TestClock.adjust("1 hour");
    const { pausedAt } = yield* sessions.pause(threadId);
    assert.equal(f.records.get(threadId)?.pausedAt, pausedAt);
    assert.deepEqual(
      f.interrupts.map((input) => [input.threadId, input.projectId, input.holdQueue]),
      [[threadId, project.id, true]],
    );
    const pausedOf = (list: ReadonlyArray<LearnSessionSummary>) =>
      list.find((entry) => entry.threadId === threadId)?.pausedAt;
    assert.equal(pausedOf(yield* sessions.listSessions), pausedAt);
    // Resume, or any typed message, requests the next run.
    f.latest.requestedAt = DateTime.makeUnsafe("1970-01-01T01:00:01.000Z");
    assert.isUndefined(pausedOf(yield* sessions.listSessions));
    const missing = yield* sessions.pause(ThreadId.make("not-a-session")).pipe(Effect.flip);
    assert.equal(missing._tag, "LearnSessionLifecycleError");
  }).pipe(Effect.provide(f.layer));
});
