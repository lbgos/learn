import type { LearnRouteSnapshot } from "./routingContext.ts";
import {
  resolveLearnRoute,
  resolveProjectProviderInstanceEnabled,
  type ProjectId,
  LearnRole,
  ModelSelection,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

export class LearnRouteUnavailable extends Schema.TaggedError<LearnRouteUnavailable>()(
  "LearnRouteUnavailable",
  {
    role: LearnRole,
    reason: Schema.Literals(["unset", "instance-missing", "instance-disabled"]),
    instanceId: Schema.optionalKey(ProviderInstanceId),
  },
) {
  override get message(): string {
    const detail =
      this.reason === "unset"
        ? "No model route is set"
        : `Provider instance '${this.instanceId}' is ${this.reason === "instance-missing" ? "missing" : "disabled"}`;
    return `${detail} for learning role '${this.role}'. Set an enabled provider and model in Settings → Learning → ${this.role}.`;
  }
}

export class LearnModelRouter extends Context.Service<
  LearnModelRouter,
  {
    readonly snapshot: (
      projectId: ProjectId,
    ) => Effect.Effect<readonly LearnRouteSnapshot[], ServerSettingsError>;
    readonly resolve: (
      role: LearnRole,
    ) => Effect.Effect<ModelSelection, LearnRouteUnavailable | ServerSettingsError>;
  }
>()("t3/learn/LearnModelRouter") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const validate = Effect.fn("LearnModelRouter.validate")(function* (
    role: LearnRole,
    selection: ModelSelection | undefined,
    current: Parameters<typeof resolveProjectProviderInstanceEnabled>[0],
  ) {
    if (selection === undefined) return yield* new LearnRouteUnavailable({ role, reason: "unset" });
    const instance = yield* registry.getInstance(selection.instanceId);
    const configured = current.providerInstances[selection.instanceId];
    if (
      (configured !== undefined && !resolveProviderInstanceEnabled(configured)) ||
      instance?.enabled === false
    )
      return yield* new LearnRouteUnavailable({
        role,
        reason: "instance-disabled",
        instanceId: selection.instanceId,
      });
    if (instance === undefined)
      return yield* new LearnRouteUnavailable({
        role,
        reason: "instance-missing",
        instanceId: selection.instanceId,
      });
    return selection;
  });
  return LearnModelRouter.of({
    resolve: Effect.fn("LearnModelRouter.resolve")(function* (role) {
      const current = yield* settings.getSettings;
      return yield* validate(role, resolveLearnRoute(current.learn.routes, role), current);
    }),
    snapshot: Effect.fn("LearnModelRouter.snapshot")(function* (projectId) {
      const current = yield* settings.getSettings;
      return yield* Effect.forEach(LearnRole.literals, (role) =>
        Effect.gen(function* () {
          const selection = resolveLearnRoute(current.learn.routes, role);
          const availability = yield* validate(role, selection, current).pipe(
            Effect.map(() =>
              selection !== undefined &&
              !resolveProjectProviderInstanceEnabled(current, projectId, selection.instanceId)
                ? "unavailable: disabled for project"
                : "configured",
            ),
            Effect.catchTags({
              LearnRouteUnavailable: (error) => Effect.succeed(`unavailable: ${error.reason}`),
            }),
          );
          return { role, selection, availability };
        }),
      );
    }),
  });
});

export const layer = Layer.effect(LearnModelRouter, make);
