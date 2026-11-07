import {
  learnSessionPaused,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { formatBreakContext } from "@t3tools/learn/session";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LearnModelRouter from "./LearnModelRouter.ts";
import * as Sessions from "./session/LearnSessionService.ts";
import * as LearnSessionStore from "./session/LearnSessionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { providerConstraints } from "../provider/delegationConstraints.ts";
import { formatLearnRoutingContext } from "./routingContext.ts";
import { formatLearnJobsContext, isHeldTask } from "./jobs/jobsContext.ts";

type LearningThread = Pick<OrchestrationV2AppThread, "id" | "projectId" | "lineage">;

export class LearnRoutingContext extends Context.Service<
  LearnRoutingContext,
  {
    readonly isLearningTutor: (
      thread: LearningThread,
    ) => Effect.Effect<boolean, LearnSessionStore.LearnSessionStoreError>;
    readonly sessionForTurn: (thread: LearningThread) => Effect.Effect<string | undefined>;
    readonly forTurn: (thread: LearningThread) => Effect.Effect<string | undefined>;
    /** Background job results held for this run's turn; see formatLearnJobsContext. */
    readonly jobsForTurn: (
      thread: LearningThread,
      run: Pick<OrchestrationV2Run, "ordinal">,
    ) => Effect.Effect<string | undefined>;
    /** The break before this run when it is the first run requested after a pause. */
    readonly breakForTurn: (
      thread: LearningThread,
      run: Pick<OrchestrationV2Run, "ordinal" | "requestedAt"> &
        Partial<Pick<OrchestrationV2Run, "startedAt">>,
    ) => Effect.Effect<string | undefined>;
  }
>()("t3/learn/LearnRoutingContext") {}

const make = Effect.gen(function* () {
  const sessions = yield* Sessions.LearnSessionService;
  const store = yield* LearnSessionStore.LearnSessionStore;
  const router = yield* LearnModelRouter.LearnModelRouter;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const isLearningTutor = (thread: LearningThread) =>
    thread.lineage.relationshipToParent === "subagent"
      ? Effect.succeed(false)
      : store.get(thread.id).pipe(Effect.map((session) => session !== null));
  return LearnRoutingContext.of({
    isLearningTutor,
    sessionForTurn: Effect.fn("LearnRoutingContext.sessionForTurn")(function* (thread) {
      if (!(yield* isLearningTutor(thread).pipe(Effect.orElseSucceed(() => false))))
        return undefined;
      return yield* sessions
        .contextForThread(thread.id)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Learn session context unavailable", cause).pipe(
              Effect.as(undefined),
            ),
          ),
        );
    }),
    forTurn: Effect.fn("LearnRoutingContext.forTurn")(function* (thread) {
      if (!(yield* isLearningTutor(thread).pipe(Effect.orElseSucceed(() => false))))
        return undefined;
      return yield* Effect.gen(function* () {
        const routes = yield* router.snapshot(thread.projectId);
        const providers = yield* registry.getProviders;
        const capable = yield* adapters.list();
        return formatLearnRoutingContext(
          routes.map((route) => {
            if (route.selection === undefined || route.availability !== "configured") return route;
            const provider = providers.find(
              (candidate) => candidate.instanceId === route.selection?.instanceId,
            );
            const constraints = [
              ...providerConstraints(provider, capable.includes(route.selection.instanceId)),
            ];
            if (provider === undefined) constraints.push("Provider is not registered.");
            if (
              provider !== undefined &&
              provider.models.length > 0 &&
              !provider.models.some((model) => model.slug === route.selection?.model)
            )
              constraints.push("Model is not advertised.");
            return {
              ...route,
              availability:
                constraints.length === 0 ? "configured" : `unavailable: ${constraints[0]}`,
            };
          }),
        );
      }).pipe(
        Effect.orElseSucceed(
          () =>
            "Learning routing unavailable: settings could not be read. Do not substitute another route.",
        ),
      );
    }),
    jobsForTurn: Effect.fn("LearnRoutingContext.jobsForTurn")(function* (thread, run) {
      if (!(yield* isLearningTutor(thread).pipe(Effect.orElseSucceed(() => false))))
        return undefined;
      return yield* Effect.gen(function* () {
        const { subagents } = yield* projections.getThreadRecords(thread.id, ["subagents"]);
        if (!subagents.some(isHeldTask)) return undefined;
        const { runs } = yield* projections.getThreadRecords(thread.id, ["runs"]);
        return formatLearnJobsContext({ subagents, runs, runOrdinal: run.ordinal });
      }).pipe(
        Effect.orElseSucceed(
          () =>
            "Background job results could not be read this turn; task_status reads a job by taskId.",
        ),
      );
    }),
    breakForTurn: Effect.fn("LearnRoutingContext.breakForTurn")(function* (thread, run) {
      if (thread.lineage.relationshipToParent === "subagent") return undefined;
      return yield* Effect.gen(function* () {
        const pausedAt = (yield* store.get(thread.id))?.pausedAt;
        if (pausedAt === undefined) return undefined;
        const requestedAt = DateTime.toEpochMillis(run.startedAt ?? run.requestedAt);
        if (requestedAt < Date.parse(pausedAt)) return undefined;
        const { runs } = yield* projections.getThreadRecords(thread.id, ["runs"]);
        const before = runs
          .filter(
            (candidate) =>
              candidate.ordinal !== run.ordinal &&
              DateTime.toEpochMillis(candidate.startedAt ?? candidate.requestedAt) <= requestedAt,
          )
          .map((candidate) => DateTime.formatIso(candidate.startedAt ?? candidate.requestedAt))
          .toSorted()
          .at(-1);
        return learnSessionPaused(pausedAt, before)
          ? formatBreakContext(requestedAt - Date.parse(pausedAt))
          : undefined;
      }).pipe(
        // The break note is a pacing aid; the turn runs without it.
        Effect.catch((cause) =>
          Effect.logWarning("Learn break context unavailable", cause).pipe(Effect.as(undefined)),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(LearnRoutingContext, make);
export const layerEmpty = Layer.succeed(LearnRoutingContext, {
  isLearningTutor: Effect.fn("LearnRoutingContext.isLearningTutor")(() => Effect.succeed(false)),
  sessionForTurn: Effect.fn("LearnRoutingContext.sessionForTurn")(() => Effect.undefined),
  forTurn: Effect.fn("LearnRoutingContext.forTurn")(() => Effect.undefined),
  jobsForTurn: Effect.fn("LearnRoutingContext.jobsForTurn")(() => Effect.undefined),
  breakForTurn: Effect.fn("LearnRoutingContext.breakForTurn")(() => Effect.undefined),
});
