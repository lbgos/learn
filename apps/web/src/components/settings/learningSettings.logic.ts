import {
  DEFAULT_LEARN_ROUTES,
  DEFAULT_SERVER_SETTINGS,
  LEARN_ROLE_PARENT,
  LearnGraphSettings,
  LearnVoiceSettings,
  type LearnRole,
  type LearnRoutes,
  type ModelSelection,
  type ModelCapabilities,
  type ProviderDriverKind,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

export const LEARNING_ROUTING_ROLES = [
  "tutor",
  "planning",
  "practice",
  "research",
  "transcript",
  "developer",
  "visual",
  "review",
  "extraction",
  "audit",
  "fast",
] as const;
export type LearningRoutingRole = (typeof LEARNING_ROUTING_ROLES)[number];

/** Preserve exact saved routes, including unavailable instances and their options. */
export function resolveLearningRoute(role: LearnRole, routes: LearnRoutes): ModelSelection | null {
  let cursor: LearnRole | null = role;
  while (cursor !== null) {
    const selection = routes[cursor] ?? DEFAULT_LEARN_ROUTES[cursor];
    if (selection !== null) return selection;
    cursor = LEARN_ROLE_PARENT[cursor];
  }
  return null;
}

export function learningRouteParent(role: LearningRoutingRole): string {
  return role === "fast" ? "T3 default" : (LEARN_ROLE_PARENT[role] ?? "default");
}

export function buildLearningRoutePatch(
  role: LearningRoutingRole,
  selection: ModelSelection | null,
): ServerSettingsPatch {
  return role === "fast"
    ? {
        textGenerationModelSelection:
          selection ?? DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      }
    : { learn: { routes: { [role]: selection } } };
}

/** Carry the effective catalog values across models, falling back to the new defaults. */
export function changeLearningRouteModel(
  selection: ModelSelection,
  currentCapabilities: ModelCapabilities,
  instanceId: ModelSelection["instanceId"],
  model: string,
  nextCapabilities: ModelCapabilities,
): ModelSelection {
  const effective = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({ caps: currentCapabilities, selections: selection.options }),
  );
  const supported = effective?.filter((option) =>
    nextCapabilities.optionDescriptors?.some(
      (descriptor) =>
        descriptor.id === option.id &&
        (descriptor.type === "boolean"
          ? typeof option.value === "boolean"
          : descriptor.options.some((choice) => choice.id === option.value)),
    ),
  );
  return createModelSelection(
    instanceId,
    model,
    buildProviderOptionSelectionsFromDescriptors(
      getProviderOptionDescriptors({ caps: nextCapabilities, selections: supported }),
    ),
  );
}

export function cannotRunGraphJobs(
  role: LearningRoutingRole,
  driver: ProviderDriverKind | undefined,
): boolean {
  return (
    (role === "extraction" || role === "audit") &&
    driver !== undefined &&
    !["codex", "claudeAgent", "opencode", "antigravity"].includes(driver)
  );
}

export function planningNeedsHandoff(
  planning: ModelSelection | null,
  tutor: ModelSelection | null,
): boolean {
  return planning !== null && tutor !== null && planning.instanceId !== tutor.instanceId;
}

export function validateVoiceEndpoint(value: string): string | null {
  try {
    decodeVoiceEndpoint(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const decodeVoiceEndpoint = Schema.decodeSync(LearnVoiceSettings.fields.sttEndpoint);
const decodeChunkTokens = Schema.decodeOption(LearnGraphSettings.fields.extractionChunkTokens);

export function validateExtractionChunkTokens(value: string): number | null {
  if (value.trim() === "") return null;
  const decoded = decodeChunkTokens(Number(value));
  return decoded._tag === "Some" ? decoded.value : null;
}
