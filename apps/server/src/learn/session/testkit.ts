import {
  MessageId,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import type { LearnSessionToolResult } from "@t3tools/contracts";

export const threadId = ThreadId.make("learn-session-test");
export const now = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");
export const tutor = { ...liveThreadShell(threadId).modelSelection, model: "tutor" };
export const planning = { ...tutor, model: "planning" };
export const practice = { ...tutor, model: "practice" };
export const assessment = {
  assessment: { strands: [{ strand: "Period", assessment: "Can measure a cycle." }] },
};
export const plan = { mermaid: "graph TD\nforce[Restoring force] --> period[Period]" };
export const quiz = {
  question: "Period?",
  answer: { kind: "number", unit: "s", tolerance: 0.05 },
  explanation: "T=2π√(L/g).",
  correctAnswer: 2,
};
export const problem = {
  statement: "Find the period.",
  mode: "recall",
  modelSolution: "2 seconds.",
};
export const conclusion = {
  outcome: "solved",
  verdict: "Used the relation correctly.",
  rung: null,
  missClass: null,
  retest: false,
};

export function projection(
  turn = 1,
  selection: ModelSelection = tutor,
): OrchestrationV2ThreadProjection {
  const empty = idleThreadProjection({ ...liveThreadShell(threadId), modelSelection: selection });
  return {
    ...empty,
    runs: [
      {
        id: RunId.make(`run-${turn}`),
        threadId,
        ordinal: turn,
        providerInstanceId: selection.instanceId,
        modelSelection: selection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message-${turn}`),
        rootNodeId: null,
        activeAttemptId: RunAttemptId.make(`attempt-${turn}`),
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
  };
}
export function appendResult(
  snapshot: OrchestrationV2ThreadProjection,
  result: LearnSessionToolResult,
): OrchestrationV2ThreadProjection {
  return {
    ...snapshot,
    turnItems: [
      ...snapshot.turnItems,
      {
        id: TurnItemId.make(`item:${result.learnSession.id}`),
        threadId,
        runId: snapshot.runs.at(-1)?.id ?? null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: snapshot.turnItems.length,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool",
        toolName: `mcp__t3-code__${result.learnSession.name}`,
        input: result.learnSession.input,
        output: result,
      },
    ],
  };
}
