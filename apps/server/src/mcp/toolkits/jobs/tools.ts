// Ported from learnharness (AGPL-3.0-only) src/agent/tools/jobs.ts @ c549494.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import { LearnJobs } from "../../../learn/jobs/LearnJobs.ts";
import {
  BuildSimInput,
  LearnJobResult,
  MakeVisualInput,
  ResearchInput,
} from "../../../learn/jobs/schemas.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [LearnJobs, ThreadManagementService, McpInvocationContext];
export const ResearchTool = Tool.make("research", {
  description:
    "Research a question with sources in a background child. Its result appears in learn_jobs at a later turn.",
  parameters: ResearchInput,
  success: LearnJobResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);
export const BuildSimTool = Tool.make("build_sim", {
  description:
    "Build and check one interactive physics sim in the Lab in a background child. Its result appears in learn_jobs at a later turn.",
  parameters: BuildSimInput,
  success: LearnJobResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
export const MakeVisualTool = Tool.make("make_visual", {
  description:
    "Build and check one visual in a background child. kind defaults to inline (interactive HTML the tutor shows with html_render({ path })); figure draws SVG on the board; animation makes step-driven HTML for visual_show. All HTML lives in visuals/. Its result appears in learn_jobs at a later turn.",
  parameters: MakeVisualInput,
  success: LearnJobResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
export const JobsToolkit = Toolkit.make(ResearchTool, BuildSimTool, MakeVisualTool);
