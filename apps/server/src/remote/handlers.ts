import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Configuration from "./Configuration.ts";
import * as Remote from "./RemoteEnvironments.ts";
import { RemoteToolkit } from "./tools.ts";
const failure = (
  error:
    | Configuration.RemoteConfigurationError
    | Remote.RemoteEnvironmentError
    | Schema.SchemaError,
) => new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
const handlers = {
  list_environments: Access.readsAsCaller(() =>
    Configuration.Configuration.pipe(
      Effect.flatMap((c) => c.list),
      Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))),
      Effect.mapError(failure),
    ),
  ),
  remote_thread_list: Access.readsAsCaller((input) =>
    Remote.RemoteEnvironments.pipe(
      Effect.flatMap((r) => r.list(input)),
      Effect.mapError(failure),
    ),
  ),
  remote_thread_read: Access.readsAsCaller((input) =>
    Remote.RemoteEnvironments.pipe(
      Effect.flatMap((r) => r.read(input)),
      Effect.mapError(failure),
    ),
  ),
  // Remote bearer sessions cannot carry a local caller's mode ceiling. Require the full-access ceiling before forwarding writes.
  remote_thread_send: Access.writesEnvironment((input) =>
    Remote.RemoteEnvironments.pipe(
      Effect.flatMap((r) => r.send(input)),
      Effect.mapError(failure),
    ),
  ),
  remote_thread_answer: Access.writesEnvironment((input) =>
    Remote.RemoteEnvironments.pipe(
      Effect.flatMap((r) => r.answer(input)),
      Effect.mapError(failure),
    ),
  ),
  remote_thread_launch: Access.writesEnvironment((input) =>
    Remote.RemoteEnvironments.pipe(
      Effect.flatMap((r) => r.launch(input)),
      Effect.mapError(failure),
    ),
  ),
} satisfies Access.Handlers<typeof RemoteToolkit.tools>;
export const layer = Access.toLayer(RemoteToolkit, handlers);
