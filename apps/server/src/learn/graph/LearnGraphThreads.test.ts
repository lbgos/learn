import { assert, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId, RunId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Workspace from "../../physics/PhysicsWorkspaceService.ts";
import * as Kinds from "./LearnSessionKinds.ts";
import { projection as sessionProjection } from "../session/testkit.ts";
import * as Threads from "./LearnGraphThreads.ts";

const threadId = ThreadId.make("teach");
const projection = idleThreadProjection(liveThreadShell(threadId));
const now = DateTime.makeUnsafe("2026-10-24T12:00:00Z");
const decodeTool = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const message = (id: string, text: string, role: "assistant" | "user" = "assistant") => ({
  id: MessageId.make(id),
  threadId,
  role,
  text,
  createdBy: "agent" as const,
  creationSource: "provider" as const,
  runId: null,
  nodeId: null,
  attachments: [],
  streaming: false,
  createdAt: now,
  updatedAt: now,
});
const tool = (id: string, toolName: string, input: unknown, owner = threadId) =>
  decodeTool({
    id,
    threadId: owner,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    type: "dynamic_tool",
    toolName,
    input,
  });
it("takes only complete assistant text owned by this thread", () => {
  assert.deepEqual(
    Threads.teacherProse({
      ...projection,
      messages: [
        message("m1", "Teacher prose"),
        message("m2", "Learner response", "user"),
        message("m3", "[answer tool-1] response"),
        { ...message("m4", "Child text"), threadId: ThreadId.make("child") },
        { ...message("m5", "Forwarded text"), senderThreadId: ThreadId.make("child") },
        { ...message("m6", "Streaming text"), streaming: true },
      ],
    }),
    [{ id: "m1", text: "Teacher prose" }],
  );
});
it("excludes rolled-back prose and evidence from extraction", () => {
  const runId = RunId.make("discarded");
  const snapshot = {
    ...projection,
    runs: sessionProjection().runs.map((run) => ({
      ...run,
      id: runId,
      status: "rolled_back" as const,
    })),
    messages: [{ ...message("discarded", "Discarded lesson"), runId }],
    turnItems: [{ ...tool("discarded", "sim_show", { path: "discarded.sim.js" }), runId }],
  };
  assert.deepEqual(Threads.teacherProse(snapshot), []);
  assert.deepEqual(Threads.threadEvidence(snapshot), { sims: [], boards: [] });
});
it("derives evidence from prefixed MCP calls without reading tool output", () => {
  assert.deepEqual(
    Threads.threadEvidence({
      ...projection,
      turnItems: [
        tool("t1", "mcp__t3_code__sim_show", { path: "sims/pendulum.sim.js" }),
        tool("t2", "board_write", { board: "forces" }),
        tool("t3", "mcp__t3_code__board_write", {}),
        tool("t4", "sim_show", { path: "sims/pendulum.sim.js" }),
        tool("t5", "sim_show", { path: "sims/child.sim.js" }, ThreadId.make("child")),
        tool("t6", "sim_run", { path: "sims/not-shown.sim.js" }),
        tool("t7", "t3-code.board_write", JSON.stringify({ board: "energy" })),
        tool("t8", "sim_show", "invalid JSON"),
        { ...tool("t9", "sim_show", { path: "sims/failed.sim.js" }), status: "failed" },
      ],
    }),
    { sims: ["sims/pendulum.sim.js"], boards: ["forces", "main", "energy"] },
  );
});
it.effect("loads only teach sessions in the Lab and excludes delegated children", () =>
  Effect.gen(function* () {
    let kind: "teach" | "practice" | undefined = "teach";
    let current = projection;
    let loads = 0;
    const service = yield* Threads.LearnGraphThreads.pipe(
      Effect.provide(
        Threads.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Kinds.LearnSessionKinds, { kindOf: () => Effect.sync(() => kind) }),
              Layer.mock(Workspace.PhysicsWorkspaceService)({
                ensureLab: Effect.succeed({
                  projectId: projection.thread.projectId,
                  workspaceRoot: "/unused",
                  created: false,
                  unmanagedInstructionFiles: [],
                }),
              }),
              Layer.mock(Orchestrator.OrchestratorV2)({
                streamDomainEvents: Stream.never,
                getThreadProjection: () =>
                  Effect.sync(() => {
                    loads++;
                    return current;
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    assert.isDefined(yield* service.load(threadId));
    kind = "practice";
    assert.isUndefined(yield* service.load(threadId));
    kind = undefined;
    assert.isUndefined(yield* service.load(threadId));
    assert.equal(loads, 1);
    kind = "teach";
    current = {
      ...projection,
      thread: {
        ...projection.thread,
        lineage: {
          ...projection.thread.lineage,
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
      },
    };
    assert.isUndefined(yield* service.load(threadId));
    current = {
      ...projection,
      thread: { ...projection.thread, projectId: ProjectId.make("outside-lab") },
    };
    assert.isUndefined(yield* service.load(threadId));
  }),
);
