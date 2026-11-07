// Ported from learnharness (AGPL-3.0-only) src/agent/tools/jobs.ts @ c549494.
import { CommandId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Invocation from "../../mcp/McpInvocationContext.ts";
import * as Orchestration from "../../mcp/OrchestratorMcpService.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import { LearnModelRouter } from "../LearnModelRouter.ts";
import { JOB_PROMPTS } from "./prompts.ts";
import {
  type BuildSimInput,
  LearnJobError,
  type LearnJobResult,
  type LearnJobRole,
  type MakeVisualInput,
  type ResearchInput,
} from "./schemas.ts";

type JobMethod<Input> = (
  scope: Invocation.McpInvocationScope,
  input: Input,
) => Effect.Effect<LearnJobResult, LearnJobError | OrchestratorMcpFailure>;

export class LearnJobs extends Context.Service<
  LearnJobs,
  {
    readonly research: JobMethod<ResearchInput>;
    readonly buildSim: JobMethod<BuildSimInput>;
    readonly makeVisual: JobMethod<MakeVisualInput>;
  }
>()("t3/learn/jobs/LearnJobs") {}

/**
 * The tool result text a started job returns to the tutor. The learn-pacing eval reads it.
 * @public
 */
export const jobStartedMessage = (input: {
  readonly role: LearnJobRole;
  readonly routed: boolean;
  readonly providerInstanceId: string;
  readonly model: string;
}) =>
  `${input.routed ? "" : `No '${input.role}' route is configured; using the caller thread's own model. `}Started on ${input.providerInstanceId} / ${input.model}. When it finishes, its result appears in the learn_jobs context of your next turn.`;

const make = Effect.gen(function* () {
  const router = yield* LearnModelRouter;
  const threads = yield* Threads.ThreadManagementService;
  const orchestration = yield* Orchestration.OrchestratorMcpService;

  const start = Effect.fn("LearnJobs.start")(function* (
    callerScope: Invocation.McpInvocationScope,
    role: LearnJobRole,
    title: string,
    task: string,
  ) {
    const scope = yield* Invocation.requireThreadScope(callerScope, "physics");
    const caller = yield* threads.getThreadShell(scope.thread.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new LearnJobError({
            role,
            reason: "caller-unavailable",
            message: "The calling learning session could not be loaded.",
            cause,
          }),
      ),
    );
    if (caller === null || caller.deletedAt !== null)
      return yield* new LearnJobError({
        role,
        reason: "caller-unavailable",
        message: "The calling learning session could not be loaded.",
      });
    if (caller.lineage.relationshipToParent === "subagent")
      return yield* new LearnJobError({
        role,
        reason: "child-caller",
        message:
          "Background jobs cannot start more background jobs. Return the request to the tutor.",
      });

    const route = yield* router.resolve(role).pipe(
      Effect.catchTags({
        LearnRouteUnavailable: (error) =>
          error.reason === "unset" ? Effect.void : Effect.fail(error),
      }),
      Effect.mapError(
        (cause) =>
          new LearnJobError({
            role,
            reason: "route-unavailable",
            message: `The '${role}' model route is unavailable. Fix Settings → Learning → ${role} with an enabled provider and model.`,
            cause,
          }),
      ),
    );
    const selection = route ?? caller.modelSelection;
    const result = yield* orchestration.delegateTask(scope, {
      mode: "async",
      isolation: "shared",
      target: {
        providerInstanceId: selection.instanceId,
        model: selection.model,
        options: selection.options ?? [],
      },
      title: title.slice(0, 200),
      task,
    });
    // No completion wake: the result waits for the tutor's next turn in the learn_jobs context.
    yield* threads
      .dispatch({
        type: "delegated_task.completion-delivery.dispose",
        commandId: CommandId.make(`command:learn-job-hold:${result.taskId}`),
        parentThreadId: scope.thread.threadId,
        taskId: result.taskId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("learn job completion wake was not held", {
            taskId: result.taskId,
            cause,
          }),
        ),
      );
    const model = result.model ?? selection.model;
    return {
      taskId: result.taskId,
      childThreadId: result.childThreadId,
      providerInstanceId: result.providerInstanceId,
      model,
      message: jobStartedMessage({
        role,
        routed: route !== undefined,
        providerInstanceId: result.providerInstanceId,
        model,
      }),
    };
  });

  return LearnJobs.of({
    research: Effect.fn("LearnJobs.research")((scope, input) =>
      start(
        scope,
        "research",
        `Research: ${input.question}`,
        `${JOB_PROMPTS.research}\n\nQuestion: ${input.question}\nWhy: ${input.why}`,
      ),
    ),
    buildSim: Effect.fn("LearnJobs.buildSim")((scope, input) =>
      start(
        scope,
        "developer",
        `Sim: ${input.title}`,
        `${JOB_PROMPTS.build_sim}\n\nTitle: ${input.title}\nBrief: ${input.brief}`,
      ),
    ),
    makeVisual: Effect.fn("LearnJobs.makeVisual")((scope, input) =>
      start(
        scope,
        "visual",
        `${input.kind === "animation" ? "Animation" : input.kind === "figure" ? "Figure" : "Visual"}: ${input.brief}`,
        `${input.kind === "animation" ? JOB_PROMPTS.make_visual_animation : input.kind === "figure" ? JOB_PROMPTS.make_visual : JOB_PROMPTS.make_visual_inline}\n\nBrief: ${input.brief}`,
      ),
    ),
  });
});

export const layer = Layer.effect(LearnJobs, make);
