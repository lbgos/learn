import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import * as Access from "../../mcp/McpToolAccess.ts";
import * as Handlers from "../../mcp/toolkits/jobs/handlers.ts";
import {
  BuildSimTool,
  JobsToolkit,
  MakeVisualTool,
  ResearchTool,
} from "../../mcp/toolkits/jobs/tools.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { LearnModelRouter, LearnRouteUnavailable } from "../LearnModelRouter.ts";
import * as Jobs from "./LearnJobs.ts";
import { JOB_PROMPTS } from "./prompts.ts";
import { tutorInstructions } from "../../physics/templates/index.ts";

const decodeResearch = Schema.decodeSync(ResearchTool.parametersSchema);
const decodeBuildSim = Schema.decodeSync(BuildSimTool.parametersSchema);
const decodeMakeVisual = Schema.decodeSync(MakeVisualTool.parametersSchema);
const decodeUnknownMakeVisual = Schema.decodeUnknownSync(MakeVisualTool.parametersSchema);
const threadId = ThreadId.make("job-parent");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("jobs-test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "jobs-test",
  thread: {
    threadId,
    providerSessionId: "parent-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const routed: ModelSelection = {
  instanceId: ProviderInstanceId.make("custom-visual"),
  model: "vision-model",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const taskResult: OrchestratorMcpDelegateTaskResult = {
  taskId: NodeId.make("job-task"),
  childThreadId: ThreadId.make("job-child"),
  childRunId: null,
  childNodeId: NodeId.make("job-child-node"),
  status: "running",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: routed.instanceId,
  model: routed.model,
  summary: null,
  resultContextTransferId: null,
  hasPendingQuestion: false,
  pendingApproval: null,
  waitTimedOut: false,
};

function fixture(
  options: {
    reason?: LearnRouteUnavailable["reason"];
    caller?: OrchestrationV2ThreadShell | null;
    delegationFailure?: boolean;
  } = {},
) {
  const calls: Array<{ scope: McpInvocationScope; input: OrchestratorMcpDelegateTaskInput }> = [];
  const roles: Array<string> = [];
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(LearnModelRouter)({
      resolve: (role) => {
        roles.push(role);
        return options.reason === undefined
          ? Effect.succeed(routed)
          : Effect.fail(new LearnRouteUnavailable({ role, reason: options.reason }));
      },
    }),
    Layer.mock(ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed(options.caller === undefined ? liveThreadShell(threadId) : options.caller),
      dispatch: (command) => {
        commands.push(command);
        return Effect.succeed({ sequence: 0, storedEvents: [] });
      },
    }),
    Layer.mock(OrchestratorMcpService)({
      delegateTask: (callerScope, input) => {
        calls.push({ scope: callerScope, input });
        return options.delegationFailure
          ? Effect.fail(
              new OrchestratorMcpFailure({ code: "parent_not_active", message: "Session ended" }),
            )
          : Effect.succeed({
              ...taskResult,
              providerInstanceId: input.target?.providerInstanceId ?? routed.instanceId,
              model: input.target?.model ?? routed.model,
            });
      },
    }),
  );
  return { calls, roles, commands, layer: Jobs.layer.pipe(Layer.provideMerge(dependencies)) };
}

it.effect(
  "routes each job explicitly and composes the verbatim prompt followed by its full input",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const jobs = yield* Jobs.LearnJobs;
      const inputs = [
        {
          title: "Research: Pendulum period?",
          task: `${JOB_PROMPTS.research}\n\nQuestion: Pendulum period?\nWhy: Compare with a measurement`,
        },
        {
          title: "Sim: Damped spring",
          task: `${JOB_PROMPTS.build_sim}\n\nTitle: Damped spring\nBrief: Plot E (J)`,
        },
        {
          title: "Visual: A force vector",
          task: `${JOB_PROMPTS.make_visual_inline}\n\nBrief: A force vector`,
        },
      ];
      const results = [
        yield* jobs.research(scope, {
          question: "Pendulum period?",
          why: "Compare with a measurement",
        }),
        yield* jobs.buildSim(scope, { title: "Damped spring", brief: "Plot E (J)" }),
        yield* jobs.makeVisual(scope, { brief: "A force vector" }),
      ];
      expect(f.calls[0]?.input.task).toContain("## Sources");
      expect(f.calls[0]?.input.task).toContain(
        "## Gaps\nWhat stayed open, and what would settle it.",
      );
      expect(f.roles).toEqual(["research", "developer", "visual"]);
      for (const [index, call] of f.calls.entries()) {
        expect(call.scope).toBe(scope);
        expect(call.input).toEqual({
          ...inputs[index],
          mode: "async",
          isolation: "shared",
          target: {
            providerInstanceId: routed.instanceId,
            model: routed.model,
            options: routed.options,
          },
        });
        expect(results[index]).toMatchObject({
          taskId: taskResult.taskId,
          childThreadId: taskResult.childThreadId,
          model: routed.model,
          providerInstanceId: routed.instanceId,
        });
        expect(results[index]?.message).toContain("learn_jobs");
      }
      // Each job gives up its completion wake; the tutor reads results at its next turn.
      expect(f.commands).toEqual(
        f.calls.map(() => ({
          type: "delegated_task.completion-delivery.dispose",
          commandId: `command:learn-job-hold:${taskResult.taskId}`,
          parentThreadId: threadId,
          taskId: taskResult.taskId,
        })),
      );
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("falls back only for an unset route and reports the caller's exact model", () => {
  const caller = {
    ...liveThreadShell(threadId),
    modelSelection: {
      instanceId: ProviderInstanceId.make("my-tutor"),
      model: "manual-tutor",
      options: [{ id: "mode", value: "deep" }],
    },
  };
  const f = fixture({ reason: "unset", caller });
  return Effect.gen(function* () {
    const jobs = yield* Jobs.LearnJobs;
    const result = yield* jobs.makeVisual(scope, { brief: "A right triangle" });
    expect(f.calls[0]?.input.target).toEqual({
      providerInstanceId: caller.modelSelection.instanceId,
      model: "manual-tutor",
      options: caller.modelSelection.options,
    });
    expect(result.model).toBe("manual-tutor");
    expect(result.message).toContain("using the caller thread's own model");
    expect(result.message).toContain("my-tutor / manual-tutor");
  }).pipe(Effect.provide(f.layer));
});

it.effect.each(["instance-missing", "instance-disabled"] as const)(
  "refuses %s routes without delegation",
  (reason) => {
    const f = fixture({ reason });
    return Effect.gen(function* () {
      const jobs = yield* Jobs.LearnJobs;
      const error = yield* jobs
        .buildSim(scope, { title: "Spring", brief: "Plot energy" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "LearnJobError",
        role: "developer",
        reason: "route-unavailable",
      });
      expect(error.message).toContain("Settings → Learning → developer");
      expect(f.calls).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "refuses delegated children before route resolution, including through the MCP handler",
  () => {
    const f = fixture({
      caller: {
        ...liveThreadShell(threadId),
        lineage: {
          parentThreadId: ThreadId.make("tutor"),
          rootThreadId: ThreadId.make("tutor"),
          relationshipToParent: "subagent",
        },
      },
    });
    const handlers = Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(f.layer));
    return Effect.gen(function* () {
      const jobs = yield* Jobs.LearnJobs;
      for (const job of [
        jobs.research(scope, { question: "Why?", why: "Teach" }),
        jobs.buildSim(scope, { title: "Sim", brief: "Teach" }),
        jobs.makeVisual(scope, { brief: "Teach" }),
      ]) {
        expect(yield* job.pipe(Effect.flip)).toMatchObject({
          _tag: "LearnJobError",
          reason: "child-caller",
        });
      }
      const toolkit = yield* JobsToolkit;
      const error = yield* toolkit
        .handle("research", { question: "Why?", why: "Teach" })
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flip);
      expect(error.message).toContain("Background jobs cannot start");
      for (const error of [
        yield* toolkit
          .handle("build_sim", { title: "Sim", brief: "Teach" })
          .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flip),
        yield* toolkit
          .handle("make_visual", { brief: "Teach" })
          .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flip),
      ]) {
        expect(error).toMatchObject({ code: "invalid_request" });
        expect(error.message).toContain("Background jobs cannot start");
      }
      expect(f.calls).toEqual([]);
      expect(f.roles).toEqual([]);
    }).pipe(Effect.provide(handlers), Effect.provideService(McpInvocationContext, scope));
  },
);

it.effect("refuses external or missing callers", () => {
  const f = fixture({ caller: null });
  return Effect.gen(function* () {
    const jobs = yield* Jobs.LearnJobs;
    expect(
      yield* jobs.makeVisual({ ...scope, thread: undefined }, { brief: "x" }).pipe(Effect.flip),
    ).toMatchObject({ code: "thread_credential_required" });
    expect(yield* jobs.makeVisual(scope, { brief: "x" }).pipe(Effect.flip)).toMatchObject({
      reason: "caller-unavailable",
    });
    expect(f.calls).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("propagates delegation failures", () => {
  const f = fixture({ delegationFailure: true });
  return Effect.gen(function* () {
    const jobs = yield* Jobs.LearnJobs;
    const error = yield* jobs.makeVisual(scope, { brief: "x" }).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "parent_not_active" });
  }).pipe(Effect.provide(f.layer));
});

it("has no model input and rejects blank job inputs", () => {
  expect(Object.keys(ResearchTool.parametersSchema.fields)).toEqual(["question", "why"]);
  expect(Object.keys(BuildSimTool.parametersSchema.fields)).toEqual(["title", "brief"]);
  expect(Object.keys(MakeVisualTool.parametersSchema.fields)).toEqual(["brief", "kind"]);
  for (const blank of ["", " \n\t"]) {
    expect(() => decodeResearch({ question: blank, why: "x" })).toThrow();
    expect(() => decodeResearch({ question: "x", why: blank })).toThrow();
    expect(() => decodeBuildSim({ title: blank, brief: "x" })).toThrow();
    expect(() => decodeMakeVisual({ brief: blank })).toThrow();
  }
});

it("accepts explicit inline, animation and figure modes, rejects unknown kinds", () => {
  expect(decodeMakeVisual({ brief: "Seasons", kind: "inline" }).kind).toBe("inline");
  expect(decodeMakeVisual({ brief: "Route matrices", kind: "animation" }).kind).toBe("animation");
  expect(decodeMakeVisual({ brief: "A triangle", kind: "figure" }).kind).toBe("figure");
  expect(() => decodeUnknownMakeVisual({ brief: "x", kind: "video" })).toThrow();
});
it.effect("gives animation builders the contract and mandatory check", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const jobs = yield* Jobs.LearnJobs;
    yield* jobs.makeVisual(scope, { brief: "Route matrices", kind: "animation" });
    expect(f.roles).toEqual(["visual"]);
    expect(f.calls[0]?.input.task).toBe(
      `${JOB_PROMPTS.make_visual_animation}\n\nBrief: Route matrices`,
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect.each(["inline", "figure"] as const)(
  "dispatches explicit %s through the visual route",
  (kind) => {
    const f = fixture();
    return Effect.gen(function* () {
      const jobs = yield* Jobs.LearnJobs;
      yield* jobs.makeVisual(scope, { brief: "Seasons", kind });
      expect(f.roles).toEqual(["visual"]);
      expect(f.calls[0]?.input.task).toBe(
        `${kind === "inline" ? JOB_PROMPTS.make_visual_inline : JOB_PROMPTS.make_visual}\n\nBrief: Seasons`,
      );
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("hands inline seasons visuals back to the tutor for publication", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const jobs = yield* Jobs.LearnJobs;
    yield* jobs.makeVisual(scope, { brief: "Explain seasons with a fixed tilted axis" });
    const brief = f.calls[0]?.input.task;
    expect(brief).toContain("Return JSON { path, title, height }");
    expect(brief).toContain(
      "Tutor: when its step comes, call html_render({ path, title, height }) in the learner thread.",
    );
    expect(tutorInstructions).toContain("`html_render({ path, title, height })`");
  }).pipe(Effect.provide(f.layer));
});
