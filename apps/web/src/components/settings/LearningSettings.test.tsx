// @vitest-environment jsdom
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
  type VoiceStatus,
} from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { fetchVoiceStatus } = vi.hoisted(() => ({
  fetchVoiceStatus:
    vi.fn<(signal: AbortSignal, environmentId: EnvironmentId) => Promise<VoiceStatus>>(),
}));
vi.mock("../../voice/status", () => ({ fetchVoiceStatus }));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: () => ({}) }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useScopedSettingsWriteAllowed: () => true,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("./useScopedModelAvailability", () => ({
  useScopedModelDisabledReason: () => () => null,
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  useSettingsSearchTarget: () => undefined,
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingsSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
    ...props
  }: ComponentProps<typeof import("./settingsLayout").SettingsRow>) => (
    <div {...props}>
      {title}
      {description}
      {status}
      {control}
      {children}
    </div>
  ),
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));

import { LearningSettingsForm } from "./LearningSettings";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Personal",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-24T00:00:00.000Z",
  models: [
    {
      slug: "gpt-6.1-sol",
      name: "GPT-6.1-Sol",
      isCustom: false,
      isDefault: false,
      capabilities: null,
    },
    {
      slug: "custom-tutor",
      name: "Custom tutor",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};
const claudeProvider: ServerProvider = {
  ...provider,
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  models: [{ ...provider.models[0]!, slug: "claude-opus-5-5", name: "Claude Opus 5.5" }],
};
const antigravityProvider: ServerProvider = {
  ...provider,
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  displayName: "Antigravity",
  models: [
    { ...provider.models[0]!, slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
  ],
};
const providers = [provider, claudeProvider, antigravityProvider];
const defaultLearningSettings: UnifiedSettings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: {
    ...DEFAULT_UNIFIED_SETTINGS.providerInstances,
    [antigravityProvider.instanceId]: {
      driver: antigravityProvider.driver,
      enabled: true,
      config: {},
    },
  },
};
const environmentId = EnvironmentId.make("learning-test");
const onUpdate = vi.fn<ComponentProps<typeof LearningSettingsForm>["onUpdate"]>();
let renderer: ReactTestRenderer | undefined;

async function render(settings: UnifiedSettings = defaultLearningSettings) {
  await act(() => {
    renderer = create(
      <LearningSettingsForm
        settings={settings}
        providers={providers}
        environmentId={environmentId}
        canWrite
        getModelDisabledReason={() => null}
        onUpdate={onUpdate}
      />,
    );
  });
  return renderer!.root;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onUpdate.mockClear();
  fetchVoiceStatus.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Learning settings with a live-shaped fake catalog", () => {
  it("shows neutral loading until the provider catalog arrives", async () => {
    const container = document.createElement("div");
    const domRoot = createRoot(container);
    const form = (loading: boolean) => (
      <LearningSettingsForm
        settings={defaultLearningSettings}
        providers={loading ? [] : providers}
        providersLoading={loading}
        environmentId={environmentId}
        canWrite
        getModelDisabledReason={() => null}
        onUpdate={onUpdate}
      />
    );
    try {
      await act(() => domRoot.render(form(true)));
      expect(container.textContent).toContain("Loading providers…");
      expect(container.textContent).not.toContain("Provider unavailable");
      expect(container.textContent).not.toContain("claudeAgent");
      await act(() => domRoot.render(form(false)));
      expect(container.textContent).not.toContain("Loading providers…");
      expect(container.textContent).not.toContain("Provider unavailable");
    } finally {
      await act(() => domRoot.unmount());
    }
  });

  it("hides the default sub-line and reset action until a route is overridden", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const domRoot = createRoot(container);
    try {
      await act(() =>
        domRoot.render(
          <LearningSettingsForm
            settings={defaultLearningSettings}
            providers={providers}
            environmentId={environmentId}
            canWrite
            getModelDisabledReason={() => null}
            onUpdate={onUpdate}
          />,
        ),
      );
      for (const row of container.querySelectorAll("[data-learning-role]")) {
        expect(row.textContent).not.toContain("Default:");
        expect(row.textContent).not.toContain("inherits ");
        expect(row.querySelector('[aria-label^="Reset "]')).toBeNull();
      }
      expect(container.querySelector('[aria-label="Clear fast route"]')).toBeNull();
    } finally {
      await act(() => domRoot.unmount());
      container.remove();
    }
  });

  it("resets fast through the existing storage key and recognizes a decoded default", async () => {
    const root = await render({
      ...defaultLearningSettings,
      textGenerationModelSelection: { instanceId: provider.instanceId, model: "custom-tutor" },
    });
    await act(() => root.findByProps({ "aria-label": "Clear fast route" }).props.onClick());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      textGenerationModelSelection: defaultLearningSettings.textGenerationModelSelection,
    });
    await act(() =>
      renderer!.update(
        <LearningSettingsForm
          settings={{
            ...defaultLearningSettings,
            textGenerationModelSelection: {
              ...defaultLearningSettings.textGenerationModelSelection,
            },
          }}
          providers={providers}
          environmentId={environmentId}
          canWrite
          getModelDisabledReason={() => null}
          onUpdate={onUpdate}
        />,
      ),
    );
    expect(root.findAllByProps({ "aria-label": "Clear fast route" })).toHaveLength(0);
    expect(
      root
        .findByProps({ "data-learning-role": "fast" })
        .findAllByType("span")
        .some((node) =>
          node.children.some((child) => typeof child === "string" && child.includes("Default:")),
        ),
    ).toBe(false);
  });

  it("shows resolved routing warnings in the DOM and resets an explicit review route", async () => {
    const unsupported = {
      ...provider,
      instanceId: ProviderInstanceId.make("cursor"),
      driver: ProviderDriverKind.make("cursor"),
      displayName: "Cursor",
    };
    const settings = {
      ...defaultLearningSettings,
      providerInstances: {
        ...defaultLearningSettings.providerInstances,
        [unsupported.instanceId]: { driver: unsupported.driver, enabled: true },
      },
      learn: {
        ...defaultLearningSettings.learn,
        routes: {
          ...defaultLearningSettings.learn.routes,
          tutor: { instanceId: provider.instanceId, model: "custom-tutor" },
          planning: { instanceId: unsupported.instanceId, model: "custom-tutor" },
          review: { instanceId: unsupported.instanceId, model: "custom-tutor" },
        },
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const domRoot = createRoot(container);
    try {
      await act(() =>
        domRoot.render(
          <LearningSettingsForm
            settings={settings}
            providers={[...providers, unsupported]}
            environmentId={environmentId}
            canWrite
            getModelDisabledReason={() => null}
            onUpdate={onUpdate}
          />,
        ),
      );
      const extraction = container.querySelector('[data-learning-role="extraction"]')?.textContent;
      expect(extraction).not.toContain("Default:");
      expect(extraction).not.toContain("inherits review:");
      expect(extraction).toContain("can't run graph jobs");
      expect(extraction).not.toContain("Provider unavailable");
      expect(container.querySelector('[data-learning-role="planning"]')?.textContent).toContain(
        "switching provider at plan → teach costs one context handoff",
      );
      expect(container.querySelector('[data-learning-role="visual"]')?.textContent).toContain(
        "needs a vision-capable model",
      );
      const planningReset = container.querySelector(
        '[aria-label="Reset planning route to default"]',
      );
      expect(planningReset?.parentElement?.textContent).toContain(
        "Default: Personal / Custom tutor",
      );
      const clear = container.querySelector<HTMLButtonElement>(
        '[aria-label="Reset review route to default"]',
      );
      if (!clear) throw new Error("Review clear action is missing");
      expect(clear.parentElement?.textContent).toContain("Default: Personal / GPT-6.1-Sol");
      await act(() => clear.click());
      expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ learn: { routes: { review: null } } });
    } finally {
      await act(() => domRoot.unmount());
      container.remove();
    }
  });

  it("uses default catalog options until a row gets its own selection", async () => {
    const options = [{ id: "reasoningEffort", value: "high" }];
    const root = await render();
    const visual = root.findByProps({ "data-learning-role": "visual" });
    const traits = visual.findByType(TraitsPicker);
    expect(traits.props.modelOptions).toEqual(options);
    await act(() => traits.props.onModelOptionsChange([{ id: "reasoningEffort", value: "low" }]));
    expect(onUpdate).toHaveBeenLastCalledWith({
      learn: {
        routes: {
          visual: {
            instanceId: provider.instanceId,
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        },
      },
    });
    await act(() =>
      visual
        .findByType(ProviderModelPicker)
        .props.onInstanceModelChange(provider.instanceId, "different-builder"),
    );
    expect(onUpdate).toHaveBeenLastCalledWith({
      learn: {
        routes: {
          visual: {
            instanceId: provider.instanceId,
            model: "different-builder",
          },
        },
      },
    });
  });

  it("shows an inherited model through the parent chain and updates when that parent changes", async () => {
    const settings = {
      ...defaultLearningSettings,
      learn: {
        ...defaultLearningSettings.learn,
        routes: {
          ...defaultLearningSettings.learn.routes,
          tutor: { instanceId: provider.instanceId, model: "custom-tutor" },
        },
      },
    };
    const root = await render(settings);
    const planning = () => root.findByProps({ "data-learning-role": "planning" });
    const inheritedModel = () => planning().findByType(ProviderModelPicker).props.model;
    expect(inheritedModel()).toBe("custom-tutor");
    expect(
      planning().findAllByProps({ "aria-label": "Reset planning route to default" }),
    ).toHaveLength(0);
    await act(() =>
      renderer!.update(
        <LearningSettingsForm
          settings={{
            ...settings,
            learn: {
              ...settings.learn,
              routes: {
                ...settings.learn.routes,
                tutor: { instanceId: provider.instanceId, model: "different-builder" },
              },
            },
          }}
          providers={providers}
          environmentId={environmentId}
          canWrite
          getModelDisabledReason={() => null}
          onUpdate={onUpdate}
        />,
      ),
    );
    expect(inheritedModel()).toBe("different-builder");
  });

  it("refuses malformed endpoints without saving and allows a corrected endpoint", async () => {
    const root = await render();
    const input = root.findByProps({ "aria-label": "STT endpoint" });
    await act(() => input.props.onChange({ currentTarget: { value: "http://wrong:10300" } }));
    await act(() => input.props.onBlur());
    expect(onUpdate).not.toHaveBeenCalled();
    expect(root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Expected tcp://host:port",
    );
    await act(() => input.props.onChange({ currentTarget: { value: "tcp://speech:10300" } }));
    await act(() => input.props.onBlur());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      learn: { voice: { sttEndpoint: "tcp://speech:10300" } },
    });
    expect(root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("refuses fractional chunk sizes and saves the valid boundary value", async () => {
    const root = await render();
    const input = root.findByProps({ "aria-label": "Extraction chunk tokens" });
    await act(() => input.props.onChange({ currentTarget: { value: "500.5" } }));
    await act(() => input.props.onBlur());
    expect(onUpdate).not.toHaveBeenCalled();
    expect(root.findByProps({ role: "alert" }).children.join("")).toContain(
      "integer of at least 500",
    );
    await act(() => input.props.onChange({ currentTarget: { value: "500" } }));
    await act(() => input.props.onBlur());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      learn: { graph: { extractionChunkTokens: 500 } },
    });
  });

  it("shows separate backend results from the selected environment", async () => {
    fetchVoiceStatus.mockResolvedValue({
      stt: { ok: true, endpoint: "tcp://stt:10300", detail: "Whisper ready" },
      tts: { ok: false, endpoint: "tcp://tts:10800", detail: "Connection refused" },
    });
    const root = await render();
    await act(() =>
      root.findByProps({ "aria-label": "Test saved voice endpoints" }).props.onClick(),
    );
    expect(fetchVoiceStatus).toHaveBeenCalledWith(expect.any(AbortSignal), environmentId);
    const results = root.findByProps({ role: "status" }).findAllByType("p");
    expect(results.map((node) => node.children.join(""))).toEqual([
      "STT: ok · tcp://stt:10300 · Whisper ready",
      "TTS: error · tcp://tts:10800 · Connection refused",
    ]);
  });

  it("shows a status request error without retrying", async () => {
    fetchVoiceStatus.mockRejectedValue(new Error("Voice requires a connected environment"));
    const root = await render();
    await act(() =>
      root.findByProps({ "aria-label": "Test saved voice endpoints" }).props.onClick(),
    );
    expect(root.findByProps({ role: "status" }).children.join("")).toBe(
      "Voice requires a connected environment",
    );
    expect(fetchVoiceStatus).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight status request when leaving the page", async () => {
    let requestSignal: AbortSignal | undefined;
    fetchVoiceStatus.mockImplementation((signal) => {
      requestSignal = signal;
      return new Promise(() => {});
    });
    const root = await render();
    await act(() =>
      root.findByProps({ "aria-label": "Test saved voice endpoints" }).props.onClick(),
    );
    expect(requestSignal?.aborted).toBe(false);
    expect(root.findByProps({ role: "status" }).children).toContain("Testing…");
    await act(() => renderer!.unmount());
    renderer = undefined;
    expect(requestSignal?.aborted).toBe(true);
  });
});
