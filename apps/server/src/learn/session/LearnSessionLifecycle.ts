import {
  CommandId,
  MessageId,
  ModelSelection,
  ThreadId,
  learnSessionPaused,
  resolveProjectProviderInstanceEnabled,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LearnCreateSessionInput, type LearnSessionSummary } from "@t3tools/contracts";
import * as Workspace from "../../physics/PhysicsWorkspaceService.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Providers from "../../provider/ProviderRegistry.ts";
import * as Settings from "../../serverSettings.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Graph from "../graph/LearnGraphService.ts";
import * as Router from "../LearnModelRouter.ts";
import { composerDefault } from "../LearnComposerDefault.ts";
import * as Store from "./LearnSessionStore.ts";
import { formatSessionContext } from "@t3tools/learn/session";

export class LearnSessionLifecycleError extends Schema.TaggedError<LearnSessionLifecycleError>()(
  "LearnSessionLifecycleError",
  {
    operation: Schema.Literals([
      "lab",
      "project",
      "default-model",
      "allocate-id",
      "create-thread",
      "initial-message",
      "list-threads",
      "input",
      "interrupt",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.operation === "default-model"
      ? "No enabled provider and model are available for a new learning session. Choose a default model in Settings."
      : `Could not prepare learning session during ${this.operation}.`;
  }
}
/** The tutor asks one to three warm-up questions and picks those nearest the goal. */
const WARM_UP_CANDIDATES = 5;
type Failure =
  | LearnSessionLifecycleError
  | Store.LearnSessionStoreError
  | Router.LearnRouteUnavailable
  | ServerSettingsError;
export class LearnSessionLifecycle extends Context.Service<
  LearnSessionLifecycle,
  {
    readonly createSession: (
      input: LearnCreateSessionInput,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, Failure>;
    readonly draftModel: (kind: "teach" | "practice") => Effect.Effect<ModelSelection, Failure>;
    readonly prepareDraft: (input: {
      threadId: ThreadId;
      session: LearnCreateSessionInput;
      modelSelection: ModelSelection;
      modelSelectionExplicit?: boolean | undefined;
    }) => Effect.Effect<{ modelSelection: ModelSelection; contextText: string }, Failure>;
    readonly listSessions: Effect.Effect<readonly LearnSessionSummary[], Failure>;
    /** Marks the session paused, then stops its running turn. The next message resumes it. */
    readonly pause: (threadId: ThreadId) => Effect.Effect<{ readonly pausedAt: string }, Failure>;
  }
>()("t3/learn/session/LearnSessionLifecycle") {}

const decodeCreateInput = Schema.decodeEffect(LearnCreateSessionInput);

const make = Effect.gen(function* () {
  const workspace = yield* Workspace.PhysicsWorkspaceService;
  const projects = yield* Projects.ProjectService;
  const providers = yield* Providers.ProviderRegistry;
  const settings = yield* Settings.ServerSettingsService;
  const threads = yield* Threads.ThreadManagementService;
  const launch = yield* Launch.ThreadLaunchService;
  const router = yield* Router.LearnModelRouter;
  const store = yield* Store.LearnSessionStore;
  const learnGraph = yield* Graph.LearnGraphService;
  const crypto = yield* Crypto.Crypto;
  const lab = workspace.ensureLab.pipe(
    Effect.mapError((cause) => new LearnSessionLifecycleError({ operation: "lab", cause })),
  );
  const uuid = crypto
    .randomUUIDv4()
    .pipe(
      Effect.mapError(
        (cause) => new LearnSessionLifecycleError({ operation: "allocate-id", cause }),
      ),
    );
  const createSession = Effect.fn("LearnSessionLifecycle.createSession")(function* (
    raw: LearnCreateSessionInput,
  ) {
    const input = yield* decodeCreateInput(raw).pipe(
      Effect.mapError((cause) => new LearnSessionLifecycleError({ operation: "input", cause })),
    );
    const root = yield* lab;
    const project = yield* projects
      .getById(root.projectId)
      .pipe(
        Effect.mapError((cause) => new LearnSessionLifecycleError({ operation: "project", cause })),
      );
    if (Option.isNone(project))
      return yield* new LearnSessionLifecycleError({ operation: "project" });
    const current = yield* settings.getSettings;
    const defaults = resolveProjectSettings(current, root.projectId, project.value).settings;
    const routed = yield* router.resolve(input.kind === "teach" ? "planning" : "practice").pipe(
      Effect.catchTags({
        LearnRouteUnavailable: (error) =>
          error.reason === "unset" ? Effect.undefined : Effect.fail(error),
      }),
    );
    const modelSelection =
      routed ??
      composerDefault(
        (yield* providers.getProviders).filter((provider) =>
          resolveProjectProviderInstanceEnabled(current, root.projectId, provider.instanceId),
        ),
        defaults.defaultModelSelection,
      );
    if (!modelSelection)
      return yield* new LearnSessionLifecycleError({ operation: "default-model" });
    const id = yield* uuid;
    const created = yield* launch
      .launch({
        commandId: CommandId.make(`learn:create:${id}`),
        threadId: ThreadId.make(id),
        projectId: root.projectId,
        title:
          input.title?.trim() || (input.kind === "teach" ? "Teaching session" : "Practice session"),
        modelSelection,
        runtimeMode: defaults.defaultRuntimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          (cause) => new LearnSessionLifecycleError({ operation: "create-thread", cause }),
        ),
      );
    // Metadata must exist before dispatch can start a provider turn or the graph reactor.
    yield* store.put({
      threadId: created.threadId,
      kind: input.kind,
      mechanic: "choice",
      createdAt: DateTime.formatIso(yield* DateTime.now),
      lastRoutedModel: modelSelection,
      ...(input.graphContext ? { graphContext: { nodeIds: input.graphContext.nodeIds } } : {}),
    });
    if (input.graphContext)
      yield* threads
        .sendToThread({
          commandId: CommandId.make(`learn:create:${id}:context`),
          projectId: root.projectId,
          threadId: created.threadId,
          messageId: MessageId.make(`learn:context:${id}`),
          text: `[graph context]\nSession: ${input.kind}\nNode ids: ${input.graphContext.nodeIds.join(", ")}\n\n${input.graphContext.text}\n[/graph context]`,
          attachments: [],
          mode: "auto",
          modelSelection,
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.mapError(
            (cause) => new LearnSessionLifecycleError({ operation: "initial-message", cause }),
          ),
        );
    return { threadId: created.threadId };
  });
  const draftModel = Effect.fn("LearnSessionLifecycle.draftModel")(function* (
    kind: "teach" | "practice",
  ) {
    const routed = yield* router.resolve(kind === "teach" ? "tutor" : "practice").pipe(
      Effect.catchTags({
        LearnRouteUnavailable: (error) =>
          error.reason === "unset" ? Effect.undefined : Effect.fail(error),
      }),
    );
    if (routed) return routed;
    const root = yield* lab;
    const project = yield* projects
      .getById(root.projectId)
      .pipe(
        Effect.mapError((cause) => new LearnSessionLifecycleError({ operation: "project", cause })),
      );
    if (Option.isNone(project))
      return yield* new LearnSessionLifecycleError({ operation: "project" });
    const current = yield* settings.getSettings;
    const defaults = resolveProjectSettings(current, root.projectId, project.value).settings;
    const selected = composerDefault(
      (yield* providers.getProviders).filter((provider) =>
        resolveProjectProviderInstanceEnabled(current, root.projectId, provider.instanceId),
      ),
      defaults.defaultModelSelection,
    );
    if (!selected) return yield* new LearnSessionLifecycleError({ operation: "default-model" });
    return selected;
  });
  // No thread or turn is created here. T3's normal first-send bootstrap owns both.
  const prepareDraft: (input: {
    threadId: ThreadId;
    session: LearnCreateSessionInput;
    modelSelection: ModelSelection;
    modelSelectionExplicit?: boolean | undefined;
  }) => Effect.Effect<{ modelSelection: ModelSelection; contextText: string }, Failure> = Effect.fn(
    "LearnSessionLifecycle.prepareDraft",
  )(function* (input) {
    const modelSelection = input.modelSelectionExplicit
      ? input.modelSelection
      : yield* draftModel(input.session.kind);
    const existing = yield* store.get(input.threadId);
    if (existing && existing.kind !== input.session.kind)
      return yield* new LearnSessionLifecycleError({ operation: "input" });
    const preparedAt = DateTime.formatIso(yield* DateTime.now);
    yield* store.update(input.threadId, (current) => ({
      ...current,
      threadId: input.threadId,
      kind: input.session.kind,
      mechanic: current?.mechanic ?? "choice",
      createdAt: current?.createdAt ?? preparedAt,
      lastRoutedModel: modelSelection,
      ...(input.modelSelectionExplicit ? { manuallyOverridden: true } : {}),
      ...(input.session.graphContext
        ? { graphContext: { nodeIds: input.session.graphContext.nodeIds } }
        : {}),
    }));
    // Review state is a warm-up aid; a session still opens without it.
    const due =
      input.session.kind === "teach"
        ? yield* learnGraph
            .dueForReview(WARM_UP_CANDIDATES)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Teach session opened without due reviews", cause).pipe(
                  Effect.as([]),
                ),
              ),
            )
        : [];
    yield* store.update(input.threadId, (current) => current && { ...current, warmUpDue: due });
    const contextText = formatSessionContext({
      includeInstructions: true,
      kind: input.session.kind,
      mechanic: existing?.mechanic ?? "choice",
      phase: "probe",
      plan: null,
      due,
    });
    const graph = input.session.graphContext;
    return {
      modelSelection,
      contextText: graph
        ? `${contextText}\n\n[graph context]\nNode ids: ${graph.nodeIds.join(", ")}\n${graph.text}\n[/graph context]`
        : contextText,
    };
  });
  const listSessions = Effect.gen(function* () {
    const root = yield* lab;
    const shells = yield* threads
      .listProjectThreads({ projectId: root.projectId, includeSubagents: false })
      .pipe(
        Effect.mapError(
          (cause) => new LearnSessionLifecycleError({ operation: "list-threads", cause }),
        ),
      );
    const records = new Map((yield* store.list).map((meta) => [meta.threadId, meta]));
    return shells
      .filter((shell) => shell.deletedAt === null)
      .map((shell): LearnSessionSummary => {
        const stored = records.get(shell.id);
        const meta = stored ?? {
          kind: "teach",
          mechanic: "choice",
          createdAt: DateTime.formatIso(shell.createdAt),
        };
        const paused = learnSessionPaused(
          stored?.pausedAt,
          shell.latestRunStartedAt
            ? DateTime.formatIso(shell.latestRunStartedAt)
            : shell.latestRunRequestedAt
              ? DateTime.formatIso(shell.latestRunRequestedAt)
              : null,
        );
        return {
          threadId: shell.id,
          title: shell.title,
          kind: meta.kind,
          mechanic: meta.mechanic,
          createdAt: meta.createdAt,
          ...("graphContext" in meta && meta.graphContext
            ? { graphContext: meta.graphContext }
            : {}),
          ...(paused && stored?.pausedAt ? { pausedAt: stored.pausedAt } : {}),
        };
      });
  });
  // The pause is written before the interrupt, so the interrupted run was requested before it.
  const pause = Effect.fn("LearnSessionLifecycle.pause")(function* (threadId: ThreadId) {
    const meta = yield* store.get(threadId);
    if (meta === null) return yield* new LearnSessionLifecycleError({ operation: "input" });
    const pausedAt = DateTime.formatIso(yield* DateTime.now);
    yield* store.update(threadId, (current) => current && { ...current, pausedAt });
    const root = yield* lab;
    const id = yield* uuid;
    yield* threads
      .interruptThread({
        projectId: root.projectId,
        commandId: CommandId.make(`learn:pause:${id}`),
        threadId,
        reason: "The learner paused the session.",
        holdQueue: true,
      })
      .pipe(
        Effect.mapError(
          (cause) => new LearnSessionLifecycleError({ operation: "interrupt", cause }),
        ),
      );
    return { pausedAt };
  });
  return LearnSessionLifecycle.of({
    createSession,
    prepareDraft,
    draftModel,
    listSessions,
    pause,
  });
});
export const layer = Layer.effect(LearnSessionLifecycle, make);
