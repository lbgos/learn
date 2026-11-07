import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Graph from "@t3tools/learn/graph";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Workspace from "../../physics/PhysicsWorkspaceService.ts";
import * as Settings from "../../serverSettings.ts";
import * as Generation from "../LearnStructuredGeneration.ts";
import * as GraphLayer from "./index.ts";
import * as Reactor from "./LearnGraphReactor.ts";
import * as Service from "./LearnGraphService.ts";
import * as Store from "./LearnGraphStore.ts";
import * as Kinds from "./LearnSessionKinds.ts";
import * as Retrievals from "./LearnRetrievals.ts";
import { LearnGraphEvent } from "@t3tools/contracts";

const now = DateTime.makeUnsafe("2026-10-24T12:00:00Z");
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const isGraphEvent = Schema.is(LearnGraphEvent);
const projection = (id: ThreadId) => {
  const base = idleThreadProjection(liveThreadShell(id));
  return {
    ...base,
    thread: { ...base.thread, title: `Session ${id}` },
    messages: [
      {
        id: MessageId.make(`message-${id}`),
        threadId: id,
        role: "assistant" as const,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        runId: null,
        nodeId: null,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        text:
          id === "teach-small" ? "Short explanation" : "Force causes acceleration. ".repeat(100),
      },
    ],
  };
};
const event = (threadId: ThreadId) =>
  decodeEvent({
    id: `event-${threadId}`,
    threadId,
    occurredAt: now,
    type: "run.updated",
    payload: {
      id: `run-${threadId}`,
      threadId,
      ordinal: 1,
      providerInstanceId: "fake",
      modelSelection: { instanceId: "fake", model: "fake" },
      providerThreadId: null,
      userMessageId: "m",
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: null,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
const layer = (
  root: string,
  events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.never,
  calls: string[] = [],
) =>
  GraphLayer.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Settings.layerTest({ learn: { graph: { extractionChunkTokens: 500 } } }),
        Layer.succeed(Retrievals.LearnRetrievals, {
          record: Effect.succeed({
            retrievals: [
              {
                nodeId: "n_shared",
                at: "2026-10-30T12:00:00.000Z",
                outcome: "incorrect" as const,
                rung: null,
                missClass: null,
                confidence: 90,
              },
            ],
            answers: [
              { at: "2026-10-30T12:00:00.000Z", confidence: 90, correct: false },
              { at: "2026-10-30T12:05:00.000Z", confidence: 85, correct: true },
            ],
          }),
        }),
        Layer.succeed(Kinds.LearnSessionKinds, {
          kindOf: (id) =>
            Effect.succeed(
              id.startsWith("teach") ? "teach" : id === "practice" ? "practice" : undefined,
            ),
        }),
        Layer.mock(Workspace.PhysicsWorkspaceService)({
          ensureLab: Effect.succeed({
            workspaceRoot: root,
            projectId: projection(ThreadId.make("teach")).thread.projectId,
            created: false,
            unmanagedInstructionFiles: [],
          }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: events,
          getThreadProjection: (id) => Effect.succeed(projection(id)),
        }),
        Layer.succeed(
          Generation.LearnStructuredGeneration,
          Generation.LearnStructuredGeneration.of({
            run: (input) =>
              Effect.suspend(() => {
                calls.push(input.role);
                // oxlint-disable-next-line t3code/no-inline-schema-compile -- The fake decodes the structured schema supplied by each caller.
                return Schema.decodeEffect(input.schema)(
                  input.role === "audit"
                    ? { links: [] }
                    : {
                        propositions: [
                          {
                            id: "p1",
                            name: "Force",
                            statement: "Force causes acceleration",
                            aliases: [],
                            messageId: "message-teach-large",
                          },
                        ],
                        chains: [],
                      },
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new Generation.LearnStructuredError({
                        role: input.role,
                        label: input.label,
                        attempts: 1,
                        cause,
                      }),
                  ),
                );
              }),
          }),
        ),
      ),
    ),
  );
const node = (id: string, sources: string[]): Graph.GraphNode => ({
  id,
  name: id === "n_shared" ? "Force" : "Motion",
  statement: id === "n_shared" ? "Force causes acceleration" : "Motion changes position",
  aliases: [],
  createdAt: "now",
  provenance: sources.map((chatId) => ({ chatId, messageId: "m" })),
});

it.layer(NodeServices.layer)("graph layer", (it) => {
  it.effect("reacts only to teach sessions with enough uncovered prose", () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const dispatched = yield* Deferred.make<void>();
      const ids = ["teach-large", "teach-small", "practice", "unknown"].map((id) =>
        ThreadId.make(id),
      );
      const calls: string[] = [];
      yield* Effect.gen(function* () {
        yield* Deferred.await(dispatched);
        const reactor = yield* Reactor.LearnGraphReactor;
        yield* Effect.forEach(ids, reactor.awaitIdle);
        assert.deepEqual(calls, ["extraction", "audit"]);
        const store = yield* Store.LearnGraphStore;
        assert.equal((yield* store.read).nodes[0]?.provenance[0]?.chatId, "teach-large");
        yield* reactor.trigger(ThreadId.make("teach-large"));
        yield* reactor.awaitIdle(ThreadId.make("teach-large"));
        assert.equal(calls.length, 2);
      }).pipe(
        Effect.provide(
          layer(
            root,
            Stream.fromIterable(ids.map(event)).pipe(
              Stream.ensuring(Deferred.succeed(dispatched, undefined)),
            ),
            calls,
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("serves snapshots, tutor reads, coverage and source deletion", () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        const store = yield* Store.LearnGraphStore;
        const service = yield* Service.LearnGraphService;
        const settings = yield* Settings.ServerSettingsService;
        const sourceId = "teach-large";
        yield* store.transact(() => ({
          append: {
            nodes: [node("n_shared", [sourceId, "teach-other"]), node("n_only", [sourceId])],
            chains: [
              {
                id: "arg_motion",
                premises: ["n_shared"],
                conclusion: "n_only",
                createdAt: "now",
                provenance: [{ chatId: sourceId, messageId: "" }],
              },
            ],
            coverage: [{ chatId: sourceId, fp: "fp", tokens: 1, foldedAt: "now" }],
            checkpoints: [{ chatId: sourceId, foldedAt: "now" }],
          },
          rewrite: {
            positions: {
              n_shared: { x: 1, y: 2 },
              n_only: { x: 3, y: 4 },
              arg_motion: { x: 5, y: 6 },
            },
          },
          result: undefined,
        }));
        const snapshot = yield* service.snapshot;
        assert.isTrue(isGraphEvent(snapshot));
        assert.equal(snapshot.snapshot.sessions[sourceId], `Session ${sourceId}`);
        assert.equal(snapshot.snapshot.propositions.length, 2);
        assert.equal(snapshot.snapshot.chains.length, 1);
        assert.include(yield* service.graphSessions, "2 propositions");
        assert.include(
          yield* service.graphPropositions({ query: "Force" }),
          "Force causes acceleration",
        );
        assert.include(yield* service.graphPropositions({ session: sourceId }), "arg_motion");
        yield* TestClock.setTime(Date.parse("2026-11-02T12:00:00.000Z"));
        assert.include(
          yield* service.graphPropositions({ query: "Force" }),
          "review: retrieved 2026-10-30: wrong at confidence 90 (confident miss); due now",
        );
        const review = yield* service.reviewSummary;
        assert.deepEqual(review.due, ["n_shared"]);
        assert.deepEqual(review.calibration.at(-1), { from: 80, to: 100, answers: 2, correct: 1 });
        assert.deepEqual(
          (yield* service.dueForReview(3)).map((node) => node.id),
          ["n_shared"],
        );
        assert.deepEqual(
          yield* service.evidence([sourceId, sourceId, "notes:ignored", "practice"]),
          [
            {
              threadId: ThreadId.make(sourceId),
              title: `Session ${sourceId}`,
              sims: [],
              boards: [],
            },
          ],
        );
        const preview = yield* service.deletionPreview(sourceId);
        assert.deepEqual(preview, {
          nodesRemoved: 1,
          chainsRemoved: 1,
          coverageRemoved: 1,
          checkpointsRemoved: 1,
        });
        assert.equal(yield* store.revision, 1);
        assert.deepEqual(yield* service.deleteSessionTraces(ThreadId.make(sourceId)), preview);
        const remaining = yield* store.read;
        assert.deepEqual(remaining.positions, { n_shared: { x: 1, y: 2 } });
        assert.deepEqual(remaining.nodes[0]?.provenance, [
          { chatId: "teach-other", messageId: "m" },
        ]);
        assert.deepEqual(yield* service.deletionPreview(sourceId), {
          nodesRemoved: 0,
          chainsRemoved: 0,
          coverageRemoved: 0,
          checkpointsRemoved: 0,
        });
        yield* settings.updateSettings({ learn: { graph: { tutorGraphTools: false } } });
        assert.equal(yield* service.graphSessions, "The graph tools are turned off in Settings.");
        assert.equal(
          yield* service.graphPropositions({}),
          "The graph tools are turned off in Settings.",
        );
        const coverage = yield* service.coverageSummary(ThreadId.make(sourceId));
        assert.equal(coverage.uncoveredCount, 1);
        const ready = yield* Deferred.make<void>();
        const updates = yield* service.subscribe.pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        yield* service.putPositions({ n_shared: { x: 7, y: 8 } });
        assert.deepEqual((yield* store.read).positions, { n_shared: { x: 7, y: 8 } });
        const events = yield* Fiber.join(updates);
        assert.deepEqual(
          events.map((event) => event.revision),
          [2, 3],
        );
        assert.deepEqual(events[1]?.snapshot.positions, { n_shared: { x: 7, y: 8 } });
      }).pipe(Effect.provide(layer(root)));
    }).pipe(Effect.scoped),
  );
});
