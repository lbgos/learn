import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Cortex from "../../../learn/cortex/Cortex.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
const dependencies = [
  Cortex.Cortex,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
const query = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
export const CortexToolkit = Toolkit.make(
  Tool.make("cortex_search", {
    description: "Search the user's Cortex memory before asking for information.",
    parameters: Schema.Struct({ query, k: Schema.optional(Schema.Number) }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("cortex_read", {
    description: "Read a Cortex source passage.",
    parameters: Schema.Struct({
      sourceId: Schema.String,
      from: Schema.optional(Schema.Number),
      to: Schema.optional(Schema.Number),
    }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("cortex_beliefs", {
    description: "Search recorded beliefs and evidence, including supersession history.",
    parameters: Schema.Struct({ query }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("cortex_add_source", {
    description: "Import a text source into Cortex.",
    parameters: Schema.Struct({
      text: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
      kind: Schema.String,
      title: Schema.String,
      url: Schema.optional(Schema.String),
      language: Schema.optional(Schema.String),
    }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Destructive, false),
  Tool.make("cortex_record", {
    description: "Record a useful observation with explicit confidence and evidence.",
    parameters: Schema.Struct({
      type: Schema.String,
      statement: query,
      stance: Schema.optional(Schema.String),
      confidence: Schema.NullOr(Schema.Number),
      sourceRef: Schema.optional(Schema.Unknown),
      supersedes: Schema.optional(Schema.String),
    }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Destructive, false),
);
