import {
  DEFAULT_LEARN_ROUTES,
  DEFAULT_SERVER_SETTINGS,
  LearnSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsPatch,
  type ModelSelection,
  type ModelCapabilities,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  LEARNING_ROUTING_ROLES,
  buildLearningRoutePatch,
  cannotRunGraphJobs,
  changeLearningRouteModel,
  learningRouteParent,
  planningNeedsHandoff,
  resolveLearningRoute,
  validateExtractionChunkTokens,
  validateVoiceEndpoint,
} from "./learningSettings.logic";

const routes = Schema.decodeSync(LearnSettings)({}).routes;
const isSettingsPatch = Schema.is(ServerSettingsPatch);
const tutor: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex_personal"),
  model: "custom-tutor",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const developer: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude_work"),
  model: "custom-builder",
};

describe("learning route inheritance", () => {
  it("resolves inherited routes and retains all inherited options", () => {
    expect(resolveLearningRoute("planning", { ...routes, tutor })).toBe(tutor);
    expect(resolveLearningRoute("practice", { ...routes, tutor })).toBe(tutor);
    expect(resolveLearningRoute("extraction", { ...routes, review: developer })).toBe(developer);
    expect(resolveLearningRoute("audit", { ...routes, review: developer })).toBe(developer);
  });

  it("uses built-in defaults before following a parent", () => {
    expect(resolveLearningRoute("visual", { ...routes, tutor, developer })).toBe(
      DEFAULT_LEARN_ROUTES.visual,
    );
    expect(resolveLearningRoute("tutor", routes)).toBe(DEFAULT_LEARN_ROUTES.tutor);
    expect(resolveLearningRoute("planning", routes)).toBe(DEFAULT_LEARN_ROUTES.tutor);
    expect(resolveLearningRoute("extraction", routes)).toBe(DEFAULT_LEARN_ROUTES.review);
  });

  it("preserves an unavailable explicit route instead of hiding it behind a default", () => {
    expect(resolveLearningRoute("visual", { ...routes, visual: developer })).toBe(developer);
  });

  it("names the immediate parent, even when its resolved selection comes from further up", () => {
    expect(learningRouteParent("visual")).toBe("developer");
    expect(learningRouteParent("extraction")).toBe("review");
    expect(learningRouteParent("tutor")).toBe("default");
    expect(learningRouteParent("fast")).toBe("T3 default");
  });
});

describe("learning route patches", () => {
  it.each(LEARNING_ROUTING_ROLES)(
    "replaces the whole %s route without retaining old options",
    (role) => {
      const selection = { instanceId: developer.instanceId, model: developer.model };
      expect(buildLearningRoutePatch(role, selection)).toEqual(
        role === "fast"
          ? { textGenerationModelSelection: selection }
          : { learn: { routes: { [role]: selection } } },
      );
    },
  );
  it.each(LEARNING_ROUTING_ROLES)("resets %s without changing other rows", (role) => {
    const patch = buildLearningRoutePatch(role, null);
    expect(isSettingsPatch(patch)).toBe(true);
    expect(patch).toEqual(
      role === "fast"
        ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
        : { learn: { routes: { [role]: null } } },
    );
  });
});

describe("learning model option changes", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        currentValue: "medium",
        options: [
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
      },
    ],
  };
  const nextCapabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        currentValue: "high",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ],
  };
  it("keeps an inherited catalog Medium even when the new model defaults to High", () => {
    const inherited = resolveLearningRoute("practice", { ...routes, tutor: developer });
    if (!inherited) throw new Error("Missing inherited route");
    expect(
      changeLearningRouteModel(
        inherited,
        capabilities,
        developer.instanceId,
        "sonnet-5.5",
        nextCapabilities,
      ),
    ).toEqual({
      instanceId: developer.instanceId,
      model: "sonnet-5.5",
      options: [{ id: "effort", value: "medium" }],
    });
  });
  it("uses visible new catalog defaults for unsupported values and drops absent options", () => {
    const next = changeLearningRouteModel(
      {
        ...developer,
        options: [
          { id: "effort", value: "medium" },
          { id: "thinking", value: true },
        ],
      },
      capabilities,
      tutor.instanceId,
      "new-model",
      {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            currentValue: "high",
            options: [{ id: "high", label: "High", isDefault: true }],
          },
        ],
      },
    );
    expect(next.options).toEqual([{ id: "effort", value: "high" }]);
  });
  it("keeps explicit supported values over the old catalog default", () => {
    expect(
      changeLearningRouteModel(
        { ...developer, options: [{ id: "effort", value: "high" }] },
        capabilities,
        tutor.instanceId,
        "new-model",
        nextCapabilities,
      ).options,
    ).toEqual([{ id: "effort", value: "high" }]);
  });
});

describe("routing warnings", () => {
  it.each(["codex", "claudeAgent", "opencode", "antigravity"])(
    "allows structured jobs on %s",
    (kind) => {
      for (const role of ["extraction", "audit"] as const)
        expect(cannotRunGraphJobs(role, ProviderDriverKind.make(kind))).toBe(false);
    },
  );
  it.each(["cursor", "pi", "grok", "muse", "acpRegistry", "custom-driver"])(
    "flags structured jobs on %s",
    (kind) => {
      const driver = ProviderDriverKind.make(kind);
      expect(cannotRunGraphJobs("extraction", driver)).toBe(true);
      expect(cannotRunGraphJobs("audit", driver)).toBe(true);
      expect(cannotRunGraphJobs("tutor", driver)).toBe(false);
    },
  );
  it("does not claim an unresolved route has an unsupported provider", () => {
    expect(cannotRunGraphJobs("audit", undefined)).toBe(false);
  });
  it("warns only when resolved planning and tutor provider instances differ", () => {
    expect(planningNeedsHandoff(tutor, tutor)).toBe(false);
    expect(planningNeedsHandoff({ ...tutor, model: "another-model" }, tutor)).toBe(false);
    expect(planningNeedsHandoff(developer, tutor)).toBe(true);
    expect(
      planningNeedsHandoff({ ...tutor, instanceId: ProviderInstanceId.make("codex_work") }, tutor),
    ).toBe(true);
    expect(planningNeedsHandoff(null, tutor)).toBe(false);
    expect(planningNeedsHandoff(tutor, null)).toBe(false);
  });
});

describe("learning input validation", () => {
  it.each([
    "tcp://localhost:1",
    "tcp://127.0.0.1:10300",
    "tcp://speech.example:65535",
    "tcp://[::1]:10800",
  ])("accepts %s", (endpoint) => {
    expect(validateVoiceEndpoint(endpoint)).toBeNull();
  });
  it.each([
    "",
    "http://host:10300",
    "tcp://host:0",
    "tcp://host:65536",
    "tcp://host:1.5",
    "tcp://host",
    "tcp://host:123/path",
    "tcp://user@host:123",
    "tcp://host name:123",
  ])("refuses %s with the contract's message", (endpoint) => {
    expect(validateVoiceEndpoint(endpoint)).toContain(
      "Expected tcp://host:port with a port from 1 to 65535",
    );
  });
  it.each(["500", "8192", "10000"])("accepts %s chunk tokens", (value) => {
    expect(validateExtractionChunkTokens(value)).toBe(Number(value));
  });
  it.each(["", " ", "499", "500.5", "NaN", "Infinity"])("refuses %s chunk tokens", (value) => {
    expect(validateExtractionChunkTokens(value)).toBeNull();
  });
});
