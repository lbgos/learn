import { assert, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { compactJobResult, formatLearnJobsContext } from "./jobsContext.ts";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 30, 12, minute));
const task = (
  name: string,
  patch: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent => ({
  id: NodeId.make(`node:${name}`),
  threadId: ThreadId.make("thread:tutor"),
  runId: RunId.make("run:1"),
  parentNodeId: NodeId.make("node:root"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerThreadId: null,
  childThreadId: ThreadId.make(`thread:${name}`),
  nativeTaskRef: null,
  prompt: `Run ${name}.`,
  title: name,
  model: null,
  completionWake: "always",
  completionDelivery: { state: "disposed", observedByRunId: null },
  status: "completed",
  result: `${name} result`,
  startedAt: at(0),
  completedAt: at(5),
  updatedAt: at(5),
  ...patch,
});
// Run 2 started at minute 10; run 3 is the turn being built.
const runs = [
  { ordinal: 1, startedAt: at(0) },
  { ordinal: 2, startedAt: at(10) },
  { ordinal: 3, startedAt: at(20) },
];

it("lists each held result once, at the first turn built after it finished", () => {
  const text = formatLearnJobsContext({
    runs,
    runOrdinal: 3,
    subagents: [
      task("Research: seen at run 2", { completedAt: at(5) }),
      task("Visual: finished during run 2", { completedAt: at(12) }),
      task("Sim: still building", { status: "running", completedAt: null, result: null }),
      task("Sim: pendulum length", {
        completedAt: at(14),
        result: "sims/pendulum-length.sim.js\nPeriod checks pass.",
      }),
      task("Visual: float gaps", {
        completedAt: at(4),
        result: '{"path":"visuals/float-gaps.html","title":"Gaps","height":640}',
      }),
      task("Woke the tutor", {
        completedAt: at(12),
        completionDelivery: { state: "delivered", observedByRunId: null },
      }),
    ],
  });
  assert.include(text, "- Visual: finished during run 2 [completed] taskId node:Visual: finished");
  assert.include(text, "  Visual: finished during run 2 result");
  assert.include(text, "Still running: Sim: still building");
  // A finished file names its show call; one listed at an earlier turn stays under Prepared.
  assert.include(text, 'show with sim_show({ path: "sims/pendulum-length.sim.js" })');
  assert.include(
    text,
    'Prepared earlier; show each when its step comes, once:\n- html_render({ path: "visuals/float-gaps.html", height: 640 }) · Visual: float gaps',
  );
  assert.notInclude(text, "seen at run 2");
  assert.notInclude(text, "Woke the tutor");
  assert.isUndefined(
    formatLearnJobsContext({
      runs,
      runOrdinal: 3,
      subagents: [task("Research: seen at run 2", { completedAt: at(5) })],
    }),
  );
});

it("keeps a research brief's summary and bounds other results", () => {
  assert.equal(
    compactJobResult(
      "## Summary\nPeriod is 2.0 s.\nIt scales with √L.\n\n## Findings\n1. **Long.** Detail.\n\n## Gaps\nNone.",
    ),
    "Period is 2.0 s.\nIt scales with √L.",
  );
  const visual = `{"path":"visuals/seasons.html","title":"Seasons","height":640}\n${"Drag the tilt. ".repeat(60)}`;
  const compact = compactJobResult(visual);
  assert.isTrue(compact.startsWith('{"path":"visuals/seasons.html"'));
  assert.isAtMost(compact.length, 601);
  assert.isTrue(compact.endsWith("…"));
});
