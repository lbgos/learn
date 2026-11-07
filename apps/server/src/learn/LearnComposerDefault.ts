import {
  DEFAULT_MODEL_BY_PROVIDER,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Workspace from "../physics/PhysicsWorkspaceService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";

/** Same provider/default-model order as the new-thread composer. */
export function composerDefault(
  providers: readonly ServerProvider[],
  stored: ModelSelection | null,
): ModelSelection | undefined {
  const available = providers.filter(
    (provider) => provider.enabled && provider.availability !== "unavailable",
  );
  const exact = available.find((provider) => provider.instanceId === stored?.instanceId);
  if (exact && stored) return stored;
  const provider =
    available.find((provider) => provider.status === "ready") ??
    available.find((provider) => provider.status !== "error");
  if (!provider) return undefined;
  const model =
    provider.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom)?.slug ??
    provider.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider.driver];
  return model ? { instanceId: provider.instanceId, model } : undefined;
}

/**
 * The Lab project's new-thread composer model: where a learning role lands when its whole
 * Settings → Learning chain is unset. Undefined when no provider is usable or the Lab is unreadable.
 */
export class LearnComposerDefault extends Context.Service<
  LearnComposerDefault,
  { readonly get: Effect.Effect<ModelSelection | undefined> }
>()("t3/learn/LearnComposerDefault") {}

const make = Effect.gen(function* () {
  const workspace = yield* Workspace.PhysicsWorkspaceService;
  const projects = yield* Projects.ProjectService;
  const providers = yield* Providers.ProviderRegistry;
  const settings = yield* Settings.ServerSettingsService;
  return LearnComposerDefault.of({
    get: Effect.gen(function* () {
      const lab = yield* workspace.ensureLab;
      const project = yield* projects.getById(lab.projectId);
      if (Option.isNone(project)) return undefined;
      const current = yield* settings.getSettings;
      const defaults = resolveProjectSettings(current, lab.projectId, project.value).settings;
      return composerDefault(
        (yield* providers.getProviders).filter((provider) =>
          resolveProjectProviderInstanceEnabled(current, lab.projectId, provider.instanceId),
        ),
        defaults.defaultModelSelection,
      );
    }).pipe(Effect.orElseSucceed(() => undefined)),
  });
});

export const layer = Layer.effect(LearnComposerDefault, make);
