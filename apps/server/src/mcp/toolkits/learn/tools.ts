import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  questionToolNames,
  sessionToolSchemas,
  sessionToolDescriptions,
} from "@t3tools/learn/session";
import { Tool, Toolkit } from "effect/ai";
import { LearnSessionToolResult } from "@t3tools/contracts";
import * as Sessions from "../../../learn/session/LearnSessionService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [
  Sessions.LearnSessionService,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
function makeTool<const Name extends keyof typeof sessionToolSchemas>(name: Name) {
  return Tool.make(name, {
    description: sessionToolDescriptions[name],
    parameters: sessionToolSchemas[name],
    success: LearnSessionToolResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false);
}
export const LearnToolkit = Toolkit.make(
  makeTool("grade_answer"),
  makeTool("correct_verdict"),
  makeTool("ask"),
  makeTool("quiz"),
  makeTool("explain"),
  makeTool("probe_done"),
  makeTool("plan_init"),
  makeTool("problem"),
  makeTool("conclude"),
  makeTool("park_question"),
  makeTool("answer_parked"),
);

/**
 * The `_meta` of a learn tool's MCP result. Claude Code ends the turn right after a result with
 * `claude/endTurn`, so an accepted question waits for the learner; other MCP clients ignore the key.
 */
export const learnResultMeta = (tool: string, isError: boolean) =>
  !isError && questionToolNames.has(tool) ? { "claude/endTurn": true } : undefined;
