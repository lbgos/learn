// Ported from learnharness (AGPL-3.0-only) src/agent/tools/graph.ts @ c549494.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Graph from "../../../learn/graph/LearnGraphService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [
  Graph.LearnGraphService,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
const GraphSessionsTool = Tool.make("graph_sessions", {
  description:
    "List the knowledge graph's source sessions and imported notes, with titles and proposition counts. Use graph_propositions to read or search them.",
  success: Schema.String,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const GraphPropositionsTool = Tool.make("graph_propositions", {
  description:
    "Read graph propositions, statements, review status and reasoning chains. Review status gives when a proposition was taught, its last retrieval and when it is due. Optionally filter by session source id or search names, statements and aliases.",
  parameters: Schema.Struct({
    session: Schema.optional(Schema.String),
    query: Schema.optional(Schema.String),
  }),
  success: Schema.String,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const GraphToolkit = Toolkit.make(GraphSessionsTool, GraphPropositionsTool);
