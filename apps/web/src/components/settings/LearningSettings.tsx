import {
  DEFAULT_SERVER_SETTINGS,
  LEARN_ROLE_USE,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettingsPatch,
  type UnifiedSettings,
  type VoiceStatus,
} from "@t3tools/contracts";
import { createModelSelection, modelSelectionsEqual } from "@t3tools/shared/model";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getProviderModelCapabilities } from "../../providerModels";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { fetchVoiceStatus } from "../../voice/status";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
} from "./settingsLayout";
import { SettingsGroup } from "./SettingsGroup";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Select, SelectTrigger, SelectPopup, SelectItem, SelectValue } from "../ui/select";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  LEARNING_ROUTING_ROLES,
  buildLearningRoutePatch,
  cannotRunGraphJobs,
  changeLearningRouteModel,
  planningNeedsHandoff,
  resolveLearningRoute,
  validateExtractionChunkTokens,
  validateVoiceEndpoint,
} from "./learningSettings.logic";

function LearningRow({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <SettingsRow
      id={id}
      title={<label htmlFor={`${id}-control`}>{label}</label>}
      control={<div className="w-full min-w-0 sm:w-64">{children}</div>}
    />
  );
}

function DraftInput({
  id,
  label,
  value,
  disabled,
  type = "text",
  placeholder,
  commit,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  type?: "text" | "number";
  placeholder?: string;
  commit: (value: string) => string | null;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);
  return (
    <LearningRow id={id} label={label}>
      <Input
        nativeInput
        size="sm"
        id={`${id}-control`}
        aria-label={label}
        type={type}
        value={draft}
        min={type === "number" ? 500 : undefined}
        step={type === "number" ? 1 : undefined}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== null}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError(null);
        }}
        onBlur={() => {
          if (draft !== value) setError(commit(draft));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1 whitespace-pre-wrap text-xs text-destructive-foreground"
        >
          {error}
        </p>
      ) : null}
    </LearningRow>
  );
}

function RouteModelLabel({
  selection,
  providers,
}: {
  selection: ModelSelection | null;
  providers: readonly ServerProvider[];
}) {
  if (!selection) return <>No model available</>;
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  return (
    <>
      {provider?.displayName ?? selection.instanceId} / {model?.name ?? selection.model}
    </>
  );
}

/** The same live provider snapshots and catalog helpers used by the composer. */
export function LearningSettingsForm({
  settings,
  providers,
  environmentId,
  projectId = null,
  providersLoading = false,
  canWrite,
  canWriteFast = canWrite,
  getModelDisabledReason,
  onUpdate,
}: {
  settings: UnifiedSettings;
  providers: readonly ServerProvider[];
  environmentId: EnvironmentId | null;
  projectId?: Parameters<typeof applyProviderInstanceSettings>[2];
  providersLoading?: boolean;
  canWrite: boolean;
  canWriteFast?: boolean;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  onUpdate: (patch: ServerSettingsPatch) => void;
}) {
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
  const enabledProviders = providers.filter((provider) =>
    entries.some(
      (entry) => entry.instanceId === provider.instanceId && entry.enabled && entry.isAvailable,
    ),
  );
  const fastProviders = enabledProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const fastDefault = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
    },
    fastProviders,
  );
  const tutor = resolveLearningRoute("tutor", settings.learn.routes);
  const planning = resolveLearningRoute("planning", settings.learn.routes);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [voiceResult, setVoiceResult] = useState<VoiceStatus | string | null>(null);
  const [testing, setTesting] = useState(false);
  const testController = useRef<AbortController | null>(null);
  useEffect(() => {
    setVoiceResult(null);
    setTesting(false);
    return () => {
      testController.current?.abort();
      testController.current = null;
    };
  }, [environmentId]);
  const testVoice = async () => {
    if (!environmentId || testController.current) return;
    const controller = new AbortController();
    testController.current = controller;
    setTesting(true);
    setVoiceResult(null);
    try {
      const result = await fetchVoiceStatus(controller.signal, environmentId);
      if (!controller.signal.aborted) setVoiceResult(result);
    } catch (error) {
      if (!controller.signal.aborted)
        setVoiceResult(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) {
        testController.current = null;
        setTesting(false);
      }
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SettingsSection id="learning-routing" title="Model routing" variant="plain">
        {routeError ? (
          <p role="alert" className="mb-2 text-xs text-destructive-foreground">
            {routeError}
          </p>
        ) : null}
        <SettingsGroup variant="plain" role="table" aria-label="Learning model routing">
          {LEARNING_ROUTING_ROLES.map((role) => {
            const saved =
              role === "fast" ? settings.textGenerationModelSelection : settings.learn.routes[role];
            // Fast has a non-nullable legacy key; resetting it restores the T3 default.
            const inherits =
              role === "fast"
                ? modelSelectionsEqual(
                    settings.textGenerationModelSelection,
                    DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
                  )
                : saved === null;
            const selection =
              role === "fast"
                ? inherits
                  ? fastDefault.model
                    ? fastDefault
                    : null
                  : saved
                : resolveLearningRoute(role, settings.learn.routes);
            const defaultSelection =
              role === "fast"
                ? fastDefault.model
                  ? fastDefault
                  : null
                : resolveLearningRoute(role, { ...settings.learn.routes, [role]: null });
            const catalog = role === "fast" ? fastProviders : providers;
            const rowEntries =
              role === "fast"
                ? entries.filter((entry) => entry.snapshot.supportsTextGeneration !== false)
                : entries;
            const entry = entries.find(
              (candidate) => candidate.instanceId === selection?.instanceId,
            );
            const pickerSelection =
              selection ??
              resolveDefaultProviderModelSelection(
                role === "fast" ? fastProviders : enabledProviders,
                null,
              );
            const disabled = !(role === "fast" ? canWriteFast : canWrite);
            const choose = (next: ModelSelection) => {
              const reason = getModelDisabledReason(next.instanceId, next.model);
              if (reason) {
                setRouteError(`${role}: ${reason}`);
                return;
              }
              setRouteError(null);
              onUpdate(buildLearningRoutePatch(role, next));
            };
            return (
              <SettingsRow
                key={role}
                id={role === "fast" ? "text-generation-model" : undefined}
                role="row"
                data-learning-role={role}
                title={<span className="capitalize">{role}</span>}
                description={
                  role === "fast" ? "Thread titles and other generated text" : LEARN_ROLE_USE[role]
                }
                status={
                  <>
                    {/* The picker marks a disabled or unavailable provider; a missing one shows here. */}
                    {!providersLoading && selection && !entry ? (
                      <p className="text-xs text-muted-foreground">
                        Provider unavailable: {selection.instanceId}
                      </p>
                    ) : null}
                    {cannotRunGraphJobs(role, entry?.driverKind) ? (
                      <p className="text-xs text-muted-foreground">can't run graph jobs</p>
                    ) : null}
                    {role === "planning" && planningNeedsHandoff(planning, tutor) ? (
                      <p className="text-xs text-muted-foreground">
                        switching provider at plan → teach costs one context handoff
                      </p>
                    ) : null}
                  </>
                }
                control={
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {providersLoading ? (
                      <span role="status" className="text-xs text-muted-foreground">
                        Loading providers…
                      </span>
                    ) : pickerSelection ? (
                      <>
                        <ProviderModelPicker
                          environmentId={environmentId}
                          activeInstanceId={pickerSelection.instanceId}
                          model={pickerSelection.model}
                          lockedProvider={null}
                          instanceEntries={rowEntries}
                          modelOptionsByInstance={getCustomModelOptionsByInstance(
                            settings,
                            catalog,
                            pickerSelection.instanceId,
                            pickerSelection.model,
                          )}
                          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                          triggerAriaLabel={`${role} provider and model`}
                          disabled={disabled}
                          getModelDisabledReason={getModelDisabledReason}
                          onInstanceModelChange={(instanceId, model) => {
                            const nextEntry = rowEntries.find(
                              (candidate) => candidate.instanceId === instanceId,
                            );
                            if (!nextEntry) return;
                            choose(
                              changeLearningRouteModel(
                                pickerSelection,
                                entry
                                  ? getProviderModelCapabilities(
                                      entry.models,
                                      pickerSelection.model,
                                      entry.driverKind,
                                      settings.planModeEnabled ||
                                        selectsPlanAgent(pickerSelection.options),
                                    )
                                  : { optionDescriptors: [] },
                                instanceId,
                                model,
                                getProviderModelCapabilities(
                                  nextEntry.models,
                                  model,
                                  nextEntry.driverKind,
                                  settings.planModeEnabled ||
                                    selectsPlanAgent(pickerSelection.options),
                                ),
                              ),
                            );
                          }}
                        />
                        {entry ? (
                          <TraitsPicker
                            provider={entry.driverKind}
                            instanceId={entry.instanceId}
                            models={entry.models}
                            model={pickerSelection.model}
                            modelOptions={pickerSelection.options}
                            allowPromptInjectedEffort={false}
                            planModeEnabled={
                              settings.planModeEnabled || selectsPlanAgent(pickerSelection.options)
                            }
                            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                            disabled={disabled}
                            onModelOptionsChange={(options) =>
                              choose(
                                createModelSelection(
                                  pickerSelection.instanceId,
                                  pickerSelection.model,
                                  options,
                                ),
                              )
                            }
                          />
                        ) : null}
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Connect a provider to choose a model.
                      </span>
                    )}
                    {!providersLoading && !inherits ? (
                      <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs text-muted-foreground">
                          Default:{" "}
                          <RouteModelLabel selection={defaultSelection} providers={providers} />
                        </span>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={disabled}
                          aria-label={
                            role === "fast" ? "Clear fast route" : `Reset ${role} route to default`
                          }
                          onClick={() => {
                            setRouteError(null);
                            onUpdate(buildLearningRoutePatch(role, null));
                          }}
                        >
                          {role === "fast" ? "Clear" : "Reset to default"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                }
              />
            );
          })}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection id="learning-voice" title="Voice" variant="plain">
        <DraftInput
          id="learning-stt-endpoint"
          label="STT endpoint"
          value={settings.learn.voice.sttEndpoint}
          disabled={!canWrite}
          commit={(value) => {
            const error = validateVoiceEndpoint(value);
            if (!error) onUpdate({ learn: { voice: { sttEndpoint: value } } });
            return error;
          }}
        />
        <DraftInput
          id="learning-stt-language"
          label="STT language"
          placeholder="Auto"
          value={settings.learn.voice.sttLanguage}
          disabled={!canWrite}
          commit={(value) => {
            onUpdate({ learn: { voice: { sttLanguage: value } } });
            return null;
          }}
        />
        <DraftInput
          id="learning-tts-endpoint"
          label="TTS endpoint"
          value={settings.learn.voice.ttsEndpoint}
          disabled={!canWrite}
          commit={(value) => {
            const error = validateVoiceEndpoint(value);
            if (!error) onUpdate({ learn: { voice: { ttsEndpoint: value } } });
            return error;
          }}
        />
        <DraftInput
          id="learning-tts-voice"
          label="TTS voice"
          value={settings.learn.voice.ttsVoice}
          disabled={!canWrite}
          commit={(value) => {
            onUpdate({ learn: { voice: { ttsVoice: value } } });
            return null;
          }}
        />
        <LearningRow id="learning-read-aloud" label="Read aloud">
          <Select
            value={settings.learn.voice.readAloud}
            disabled={!canWrite}
            onValueChange={(value) => {
              if (value === "off" || value === "manual" || value === "auto")
                onUpdate({ learn: { voice: { readAloud: value } } });
            }}
          >
            <SelectTrigger id="learning-read-aloud-control" aria-label="Read aloud" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="auto">Auto</SelectItem>
            </SelectPopup>
          </Select>
        </LearningRow>
        <SettingsRow
          title="Voice connection"
          control={
            <Button
              variant="outline"
              size="sm"
              aria-label="Test saved voice endpoints"
              disabled={!environmentId || testing}
              onClick={() => void testVoice()}
            >
              Test
            </Button>
          }
        >
          <div
            role="status"
            aria-live="polite"
            className={
              typeof voiceResult === "string"
                ? "mt-1 text-xs text-destructive-foreground"
                : "mt-1 text-xs text-muted-foreground"
            }
          >
            {testing ? "Testing…" : null}
            {typeof voiceResult === "string" ? (
              voiceResult
            ) : voiceResult ? (
              <>
                {/* Dictation tries Nemotron first; when it is down, the STT endpoint answers. */}
                {voiceResult.nemotron ? (
                  <p>
                    Nemotron: {voiceResult.nemotron.ok ? "ok" : "off"} ·{" "}
                    {voiceResult.nemotron.endpoint} · {voiceResult.nemotron.detail}
                  </p>
                ) : null}
                {/* Colour marks a failure; the endpoints are in the fields above. */}
                <p className={voiceResult.stt.ok ? undefined : "text-destructive-foreground"}>
                  STT · {voiceResult.stt.detail}
                </p>
                <p className={voiceResult.tts.ok ? undefined : "text-destructive-foreground"}>
                  TTS · {voiceResult.tts.detail}
                </p>
              </>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="learning-graph" title="Graph" variant="plain">
        <LearningRow id="learning-extraction" label="Extraction">
          <Switch
            size="sm"
            id="learning-extraction-control"
            aria-label="Extraction"
            checked={settings.learn.graph.extraction}
            disabled={!canWrite}
            onCheckedChange={(checked) => onUpdate({ learn: { graph: { extraction: checked } } })}
          />
        </LearningRow>
        <DraftInput
          id="learning-chunk-tokens"
          label="Extraction chunk tokens"
          type="number"
          value={String(settings.learn.graph.extractionChunkTokens)}
          disabled={!canWrite}
          commit={(value) => {
            const tokens = validateExtractionChunkTokens(value);
            if (tokens === null) return "Expected an integer of at least 500";
            onUpdate({ learn: { graph: { extractionChunkTokens: tokens } } });
            return null;
          }}
        />
        <LearningRow id="learning-tutor-graph-tools" label="Tutor graph tools">
          <Switch
            size="sm"
            id="learning-tutor-graph-tools-control"
            aria-label="Tutor graph tools"
            checked={settings.learn.graph.tutorGraphTools}
            disabled={!canWrite}
            onCheckedChange={(checked) =>
              onUpdate({ learn: { graph: { tutorGraphTools: checked } } })
            }
          />
        </LearningRow>
      </SettingsSection>
    </div>
  );
}

const NO_ENVIRONMENT_PROVIDERS = Atom.make(null).pipe(Atom.keepAlive);

export function LearningSettingsPanel() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const { environment, target, scope } = useSettingsScope();
  const writable = useScopedSettingsWriteAllowed();
  const environmentId = environment?.environmentId ?? null;
  const providers =
    useAtomValue(
      environmentId === null
        ? NO_ENVIRONMENT_PROVIDERS
        : serverEnvironment.providersValueAtom(environmentId),
    ) ?? EMPTY_SERVER_PROVIDERS;
  const providersLoading = useAtomValue(
    useMemo(
      () =>
        Atom.make(
          (get) =>
            environmentId === null ||
            Option.match(
              AsyncResult.value(
                get(serverEnvironment.configProjection({ environmentId, input: {} })),
              ),
              { onNone: () => true, onSome: (projection) => projection.source !== "live" },
            ),
        ),
      [environmentId],
    ),
  );
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    settings,
    target?.projectId ?? null,
  );
  const getModelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const environmentWide = scope.kind === "all" || scope.kind === "environment";
  return (
    <SettingsPageContainer width="wide">
      {!environmentWide ? (
        <p className="text-sm">Select an environment to change learning settings.</p>
      ) : null}
      <LearningSettingsForm
        key={JSON.stringify([environment?.environmentId, target?.projectId])}
        settings={settings}
        providers={providers}
        providersLoading={providersLoading}
        environmentId={environment?.environmentId ?? null}
        projectId={target?.projectId ?? null}
        canWrite={writable && environmentWide}
        canWriteFast={writable}
        getModelDisabledReason={getModelDisabledReason}
        onUpdate={update}
      />
    </SettingsPageContainer>
  );
}
