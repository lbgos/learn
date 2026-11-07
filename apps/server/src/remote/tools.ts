import * as Schema from "effect/Schema";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Configuration from "./Configuration.ts";
import * as Remote from "./RemoteEnvironments.ts";
const dependencies = [
  Configuration.Configuration,
  Remote.RemoteEnvironments,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
const common = { success: Schema.String, failure: OrchestratorMcpFailure, dependencies };
export const RemoteToolkit = Toolkit.make(
  Tool.make("list_environments", {
    ...common,
    description: "List remote environments. Credentials stay on the server.",
    parameters: Tool.EmptyParams,
  }).annotate(Tool.Readonly, true),
  Tool.make("remote_thread_list", {
    ...common,
    description: "List remote projects and threads.",
    parameters: Remote.ListInput,
  }).annotate(Tool.Readonly, true),
  Tool.make("remote_thread_read", {
    ...common,
    description: "Read remote messages and pending requests.",
    parameters: Remote.ReadInput,
  }).annotate(Tool.Readonly, true),
  Tool.make("remote_thread_send", {
    ...common,
    description: "Send a message to a remote thread. Full-access callers only.",
    parameters: Remote.SendInput,
  }).annotate(Tool.Destructive, false),
  Tool.make("remote_thread_answer", {
    ...common,
    description: "Answer a remote pending request. Full-access callers only.",
    parameters: Remote.AnswerInput,
  }).annotate(Tool.Destructive, false),
  Tool.make("remote_thread_launch", {
    ...common,
    description:
      "Launch a full-access thread in a remote project. Use its modelSelection. Full-access callers only.",
    parameters: Remote.LaunchInput,
  }).annotate(Tool.Destructive, false),
);
