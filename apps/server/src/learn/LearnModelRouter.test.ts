import { assert, it } from "@effect/vitest";
import {
  DEFAULT_LEARN_ROUTES,
  LearnRole,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import * as LearnModelRouter from "./LearnModelRouter.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const instanceId = ProviderInstanceId.make("codex-work");
const selection = {
  instanceId,
  model: "test-model",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const driverKind = ProviderDriverKind.make("codex");
const makeRegistry = (enabled: boolean, missing?: ProviderInstanceId) =>
  Effect.gen(function* () {
    const orchestrationAdapter = yield* ProviderAdapter.ProviderAdapterV2;
    const instance = {
      instanceId,
      driverKind,
      enabled,
      displayName: undefined,
      continuationIdentity: { driverKind, continuationKey: "test" },
      orchestrationAdapter,
      snapshot: {
        resolveMaintenance: () => Effect.die("unused"),
        getSnapshot: Effect.die("unused"),
        refresh: Effect.die("unused"),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      },
      textGeneration: TextGenerationOperations.fromRunner("test", () => Effect.die("unused")),
    };
    const instances = [
      instanceId,
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("claudeAgent"),
    ]
      .filter((id) => id !== missing)
      .map((id) => ({
        ...instance,
        instanceId: id,
        driverKind: ProviderDriverKind.make(id === "claudeAgent" ? "claudeAgent" : "codex"),
      }));
    return ProviderInstanceRegistry.ProviderInstanceRegistry.of({
      getInstance: (id) => Effect.succeed(instances.find((entry) => entry.instanceId === id)),
      listInstances: Effect.succeed(instances),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.die("unused"),
    });
  }).pipe(
    Effect.provide(
      Layer.mock(ProviderAdapter.ProviderAdapterV2)({ instanceId, driver: driverKind }),
    ),
  );

const layer = (enabled = true, missing?: ProviderInstanceId) =>
  LearnModelRouter.layer.pipe(
    Layer.provideMerge(
      Layer.effect(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
        makeRegistry(enabled, missing),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
  );

it.effect("uses built-in defaults for null routes without persisting them", () =>
  Effect.gen(function* () {
    const router = yield* LearnModelRouter.LearnModelRouter;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ learn: { routes: { tutor: null, research: null } } });
    assert.deepEqual(yield* router.resolve("tutor"), {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    });
    for (const role of ["research", "developer", "visual", "review"] as const) {
      assert.deepEqual(yield* router.resolve(role), {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      });
    }
    assert.isTrue(
      Object.values((yield* settings.getSettings).learn.routes).every((route) => route === null),
    );
  }).pipe(Effect.provide(layer())),
);

it.effect("explicit overrides win and resetting restores the built-in defaults", () =>
  Effect.gen(function* () {
    const router = yield* LearnModelRouter.LearnModelRouter;
    const settings = yield* ServerSettings.ServerSettingsService;
    for (const role of LearnRole.literals) {
      yield* settings.updateSettings({ learn: { routes: { [role]: selection } } });
      assert.deepEqual(yield* router.resolve(role), selection);
      yield* settings.updateSettings({ learn: { routes: { [role]: null } } });
    }
    assert.deepEqual(yield* router.resolve("visual"), DEFAULT_LEARN_ROUTES.visual);
  }).pipe(Effect.provide(layer())),
);

it.effect("planning and practice inherit tutor, extraction and audit inherit review", () =>
  Effect.gen(function* () {
    const router = yield* LearnModelRouter.LearnModelRouter;
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.deepEqual(yield* router.resolve("planning"), DEFAULT_LEARN_ROUTES.tutor);
    assert.deepEqual(yield* router.resolve("extraction"), DEFAULT_LEARN_ROUTES.review);
    const review = { ...selection, model: "review" };
    yield* settings.updateSettings({ learn: { routes: { tutor: selection, review } } });
    for (const role of ["planning", "practice"] as const) {
      assert.deepEqual(yield* router.resolve(role), selection);
    }
    for (const role of ["extraction", "audit"] as const) {
      assert.deepEqual(yield* router.resolve(role), review);
    }
    assert.deepEqual(yield* router.resolve("research"), DEFAULT_LEARN_ROUTES.research);
  }).pipe(Effect.provide(layer())),
);

it.effect("names the requested role when a built-in default instance is missing", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const router = yield* LearnModelRouter.LearnModelRouter;
    yield* settings.updateSettings({ learn: { routes: { tutor: selection } } });
    const error = yield* router.resolve("extraction").pipe(Effect.flip);
    assert.instanceOf(error, LearnModelRouter.LearnRouteUnavailable);
    assert.equal(error.role, "extraction");
    assert.equal(error.reason, "instance-missing");
    assert.equal(error.instanceId, "codex");
    assert.include(error.message, "Settings → Learning → extraction");
  }).pipe(Effect.provide(layer(true, ProviderInstanceId.make("codex")))),
);

it.effect("rejects a missing instance without falling back to tutor", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const router = yield* LearnModelRouter.LearnModelRouter;
    const missing = ProviderInstanceId.make("missing");
    yield* settings.updateSettings({
      learn: { routes: { tutor: selection, review: { instanceId: missing, model: "test" } } },
    });
    const error = yield* router.resolve("extraction").pipe(Effect.flip);
    if (error._tag !== "LearnRouteUnavailable") return assert.fail(error.message);
    assert.equal(error.role, "extraction");
    assert.equal(error.reason, "instance-missing");
    assert.equal(error.instanceId, missing);
  }).pipe(Effect.provide(layer())),
);

it.effect("rejects a disabled registry instance", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const router = yield* LearnModelRouter.LearnModelRouter;
    yield* settings.updateSettings({ learn: { routes: { tutor: selection } } });
    const error = yield* router.resolve("research").pipe(Effect.flip);
    if (error._tag !== "LearnRouteUnavailable") return assert.fail(error.message);
    assert.equal(error.reason, "instance-disabled");
    assert.equal(error.instanceId, "codex");
    assert.equal(error.role, "research");
  }).pipe(Effect.provide(layer(false))),
);

it.effect("rejects a disabled configured instance even before registry reconciliation", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const router = yield* LearnModelRouter.LearnModelRouter;
    yield* settings.updateSettings({
      providerInstances: { [instanceId]: { driver: driverKind, enabled: false, config: {} } },
      learn: { routes: { tutor: selection } },
    });
    const error = yield* router.resolve("planning").pipe(Effect.flip);
    if (error._tag !== "LearnRouteUnavailable") return assert.fail(error.message);
    assert.equal(error.reason, "instance-disabled");
  }).pipe(Effect.provide(layer())),
);

it.effect("snapshots current routes with project availability and preserves options", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const router = yield* LearnModelRouter.LearnModelRouter;
    const projectId = ProjectId.make("routing-project");
    yield* settings.updateSettings({
      providerInstances: { [instanceId]: { driver: driverKind, enabled: true, config: {} } },
      learn: { routes: { transcript: selection } },
    });
    const before = yield* router.snapshot(projectId);
    assert.equal(before.length, LearnRole.literals.length);
    assert.deepEqual(
      before.find((route) => route.role === "transcript"),
      { role: "transcript", selection, availability: "configured" },
    );
    yield* settings.updateSettings({
      learn: { routes: { transcript: { ...selection, model: "changed" } } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    });
    const after = yield* router.snapshot(projectId);
    assert.deepEqual(
      after.find((route) => route.role === "transcript"),
      {
        role: "transcript",
        selection: { ...selection, model: "changed" },
        availability: "unavailable: disabled for project",
      },
    );
  }).pipe(Effect.provide(layer())),
);
