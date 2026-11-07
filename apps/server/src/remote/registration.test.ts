import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Configuration from "./Configuration.ts";
import * as Remote from "./RemoteEnvironments.ts";
import * as Handlers from "./handlers.ts";
import { RemoteToolkit } from "./tools.ts";
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const threadId = ThreadId.make("caller");
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("local-a"),
  requestNamespace: "test",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
it.effect("registers all remote tools and denies restricted writes before connecting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let writes = 0;
      const write = () =>
        Effect.sync(() => {
          writes++;
          return "sent";
        });
      const remote = Layer.succeed(Remote.RemoteEnvironments, {
        list: () => Effect.succeed("listed"),
        read: () => Effect.succeed("read"),
        send: write,
        answer: write,
        launch: write,
      });
      for (const modes of [
        { runtimeMode: "approval-required" as const },
        { interactionMode: "plan" as const },
        { activeRunId: null },
        {},
      ]) {
        const registration = McpHttpServer.toolkitRegistration(RemoteToolkit, Handlers.layer).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(remote),
          Layer.provide(
            Layer.mock(Configuration.Configuration)({
              list: Effect.succeed([{ name: "local-b", baseUrl: "https://b.example" }]),
            }),
          ),
          Layer.provide(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(threadId, modes)),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const listed = yield* server.callTool({ name: "list_environments", arguments: {} });
          expect(listed.isError).not.toBe(true);
          const result = yield* server.callTool({
            name: "remote_thread_send",
            arguments: { environment: "local-b", threadId: "remote-thread", text: "hello" },
          });
          expect(result.isError === true).toBe(Object.keys(modes).length > 0);
        }).pipe(
          Effect.provide(registration),
          Effect.provideService(Invocation.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      }
      expect(writes).toBe(1);
    }),
  ),
);
