// Ported from learnharness (AGPL-3.0-only) src/agent/tools/practice.ts, src/agent/tool-execute.ts @ c549494.
import {
  EventId,
  type RunId,
  TurnItemId,
  ModelSelection,
  type ServerSettingsError,
  type LearnSessionState,
  ThreadId,
} from "@t3tools/contracts";
import {
  applySessionEvent,
  createSessionGate,
  derivePlanStatuses,
  formatParkedContext,
  formatSessionContext,
  prepareToolInput,
  sessionEventsFromThread,
  sessionReplayState,
  sessionToolResultMessage,
  validateSessionCall,
  type SessionGate,
  type SessionToolName,
  type SessionEvent,
} from "@t3tools/learn/session";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { LearnSessionToolResult } from "@t3tools/contracts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Router from "../LearnModelRouter.ts";
import * as Graph from "../graph/LearnGraphStore.ts";
import * as Store from "./LearnSessionStore.ts";

export class LearnSessionError extends Schema.TaggedError<LearnSessionError>()(
  "LearnSessionError",
  {
    operation: Schema.Literals([
      "projection",
      "metadata",
      "graph",
      "allocate-id",
      "encode",
      "record",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Learning session ${this.operation} failed.`;
  }
}
export class LearnSessionCallRefused extends Schema.TaggedError<LearnSessionCallRefused>()(
  "LearnSessionCallRefused",
  { tool: Schema.String, problems: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `${this.tool} was not applied:\n${this.problems.join("\n")}\nCorrect the arguments or use the tool allowed in this phase, then retry.`;
  }
}
export class LearnSessionService extends Context.Service<
  LearnSessionService,
  {
    readonly call: (
      threadId: ThreadId,
      name: SessionToolName,
      input: unknown,
      runId?: RunId,
    ) => Effect.Effect<LearnSessionToolResult, LearnSessionError | LearnSessionCallRefused>;
    readonly stateForThread: (
      threadId: ThreadId,
      beforeOrdinal: number,
    ) => Effect.Effect<LearnSessionState, LearnSessionError>;
    readonly contextForThread: (threadId: ThreadId) => Effect.Effect<string, LearnSessionError>;
    /** A proposed composer selection lets turn dispatch detect a manual pick before it is persisted. */
    readonly modelForTurn: (
      threadId: ThreadId,
      proposedSelection?: ModelSelection,
    ) => Effect.Effect<
      ModelSelection | undefined,
      LearnSessionError | Router.LearnRouteUnavailable | ServerSettingsError
    >;
    /** Call only after dispatch successfully applies the returned selection. */
    readonly recordRoutedModel: (
      threadId: ThreadId,
      selection: ModelSelection,
    ) => Effect.Effect<void, LearnSessionError>;
  }
>()("t3/learn/session/LearnSessionService") {}

const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

const make = Effect.gen(function* () {
  const projections = yield* Projections.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* Store.LearnSessionStore;
  const router = yield* Router.LearnModelRouter;
  const graph = yield* Graph.LearnGraphStore;
  const crypto = yield* Crypto.Crypto;
  const locks = yield* KeyedLock.make<ThreadId>();
  const gates = new Map<
    ThreadId,
    { turn: string; gate: SessionGate; events: readonly SessionEvent[] }
  >();
  const metadata = (id: ThreadId) =>
    store
      .get(id)
      .pipe(Effect.mapError((cause) => new LearnSessionError({ operation: "metadata", cause })));
  const updateMetadata = (
    id: ThreadId,
    change: Parameters<Store.LearnSessionStore["Service"]["update"]>[1],
  ) =>
    store
      .update(id, change)
      .pipe(Effect.mapError((cause) => new LearnSessionError({ operation: "metadata", cause })));
  const projection = (id: ThreadId) =>
    projections
      .getThreadProjection(id)
      .pipe(Effect.mapError((cause) => new LearnSessionError({ operation: "projection", cause })));
  const loadGate = Effect.fn("LearnSessionService.loadGate")(function* (threadId: ThreadId) {
    const snapshot = yield* projection(threadId);
    const meta = (yield* metadata(threadId)) ?? { kind: "teach", mechanic: "choice" };
    const latest = snapshot.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    // A restart attempt of the same run is a fresh provider turn too.
    const turn = `${latest?.id ?? "idle"}:${latest?.activeAttemptId ?? "none"}`;
    const nodes = yield* graph.read.pipe(
      Effect.mapError((cause) => new LearnSessionError({ operation: "graph", cause })),
    );
    const graphNodeIds = new Set(nodes.nodes.map((node) => node.id));
    const events = sessionEventsFromThread(snapshot);
    const cached = gates.get(threadId);
    if (
      cached?.turn === turn &&
      cached.events.length === events.length &&
      cached.events.every((event, i) => {
        const next = events[i];
        return (
          next?.id === event.id &&
          next.type === event.type &&
          (event.type !== "learner-message" ||
            next.type !== "learner-message" ||
            next.text === event.text)
        );
      })
    ) {
      const gate = { ...cached.gate, graphNodeIds };
      gates.set(threadId, { ...cached, gate });
      return gate;
    }
    const gate = createSessionGate(meta, events, graphNodeIds);
    gates.set(threadId, { turn, gate, events });
    return gate;
  });
  const call = (threadId: ThreadId, name: SessionToolName, raw: unknown, runId?: RunId) =>
    locks.withLock(
      threadId,
      Effect.gen(function* () {
        const gate = yield* loadGate(threadId);
        const input = prepareToolInput(name, raw);
        const problems = validateSessionCall(gate, name, input);
        if (problems.length) return yield* new LearnSessionCallRefused({ tool: name, problems });
        const id = yield* crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError((cause) => new LearnSessionError({ operation: "allocate-id", cause })),
          );
        const event = {
          type: "tool-call",
          id,
          name,
          input,
          at: DateTime.formatIso(yield* DateTime.now),
        } as const;
        const applied = applySessionEvent(gate, event);
        if (applied.problems.length)
          return yield* new LearnSessionCallRefused({ tool: name, problems: applied.problems });
        const message = sessionToolResultMessage(name, id);
        const result = { learnSession: { id, name, input, at: event.at }, message };
        // MCP structuredContent must be JSON before any state is committed.
        yield* decodeJson(result).pipe(
          Effect.mapError((cause) => new LearnSessionError({ operation: "encode", cause })),
        );
        const snapshot = yield* projection(threadId);
        const run =
          runId === undefined
            ? snapshot.runs.find((candidate) => candidate.status === "running")
            : snapshot.runs.find((candidate) => candidate.id === runId);
        if (runId !== undefined && run === undefined)
          return yield* new LearnSessionCallRefused({
            tool: name,
            problems: ["The invoking run was not found in this thread."],
          });
        const at = DateTime.makeUnsafe(event.at);
        // Commit the complete result ourselves. Provider tool echoes can arrive later or never;
        // shared session replay deduplicates them by learnSession.id.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* sink
              .write({
                events: [
                  {
                    id: EventId.make(`learn:${id}`),
                    threadId,
                    ...(run ? { runId: run.id } : {}),
                    occurredAt: at,
                    type: "turn-item.updated",
                    payload: {
                      id: TurnItemId.make(`learn:${id}`),
                      threadId,
                      runId: run?.id ?? null,
                      nodeId: null,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal:
                        snapshot.turnItems.reduce((max, item) => Math.max(max, item.ordinal), -1) +
                        1,
                      type: "dynamic_tool",
                      status: "completed",
                      title: null,
                      startedAt: at,
                      completedAt: at,
                      updatedAt: at,
                      toolName: `learn.${name}`,
                      input,
                      output: result,
                    },
                  },
                ],
              })
              .pipe(
                Effect.mapError((cause) => new LearnSessionError({ operation: "record", cause })),
              );
            const cached = gates.get(threadId);
            if (cached)
              gates.set(threadId, {
                ...cached,
                gate: applied.gate,
                events: [...cached.events, event],
              });
          }),
        );
        return result;
      }),
    );
  return LearnSessionService.of({
    call,
    stateForThread: Effect.fn("LearnSessionService.stateForThread")(
      function* (threadId, beforeOrdinal) {
        const snapshot = yield* projection(threadId);
        const meta = (yield* metadata(threadId)) ?? { kind: "teach", mechanic: "choice" };
        return sessionReplayState(
          sessionEventsFromThread({
            ...snapshot,
            visibleTurnItems: [],
            turnItems: snapshot.turnItems.filter((item) => item.ordinal < beforeOrdinal),
          }),
          { meta },
        );
      },
    ),
    contextForThread: Effect.fn("LearnSessionService.contextForThread")((threadId) =>
      locks.withLock(
        threadId,
        Effect.gen(function* () {
          const gate = yield* loadGate(threadId);
          const meta = yield* metadata(threadId);
          const planStatuses = gate.plan
            ? derivePlanStatuses(
                gate.plan,
                gates.get(threadId)?.events ?? [],
                gate.meta ? { meta: gate.meta } : {},
              )
            : undefined;
          const text = formatSessionContext({
            due: gate.phase === "probe" ? (meta?.warmUpDue ?? []) : [],
            includeInstructions: true,
            kind: gate.meta?.kind ?? "teach",
            mechanic: gate.meta?.mechanic ?? "choice",
            phase: gate.phase,
            plan: gate.plan,
            ...(planStatuses ? { planStatuses } : {}),
          });
          const pending = [...gate.questions.values()].at(-1);
          return [
            text,
            gate.plan
              ? `plan nodes: ${gate.plan.nodes.map((node) => `${node.id}: ${node.title}`).join("; ")}\ndependencies: ${gate.plan.edges.map((edge) => `${edge.from} -> ${edge.to}`).join("; ") || "none"}`
              : "",
            pending
              ? `pending question: ${pending.id} (${pending.name}): ${pending.input.question}`
              : "",
            gate.problem
              ? `active problem: ${gate.problem.id}: ${gate.problem.input.statement}`
              : "",
            planStatuses
              ? formatParkedContext({ plan: gate.plan, planStatuses, parked: gate.parked.values() })
              : "",
          ]
            .filter(Boolean)
            .join("\n");
        }),
      ),
    ),
    modelForTurn: Effect.fn("LearnSessionService.modelForTurn")((threadId, proposedSelection) =>
      locks.withLock(
        threadId,
        Effect.gen(function* () {
          const meta = yield* metadata(threadId);
          if (!meta?.lastRoutedModel || meta.manuallyOverridden) return undefined;
          const snapshot = yield* projection(threadId);
          const current = proposedSelection ?? snapshot.thread.modelSelection;
          if (
            !modelSelectionsEqual(snapshot.thread.modelSelection, meta.lastRoutedModel) ||
            !modelSelectionsEqual(current, meta.lastRoutedModel)
          ) {
            yield* updateMetadata(
              threadId,
              (current) => current && { ...current, manuallyOverridden: true },
            );
            return undefined;
          }
          const gate = createSessionGate(meta, sessionEventsFromThread(snapshot));
          const role =
            meta.kind === "practice" ? "practice" : gate.phase === "teach" ? "tutor" : "planning";
          return yield* router.resolve(role).pipe(
            Effect.catchTags({
              LearnRouteUnavailable: (error) =>
                error.reason === "unset" ? Effect.undefined : Effect.fail(error),
            }),
          );
        }),
      ),
    ),
    recordRoutedModel: Effect.fn("LearnSessionService.recordRoutedModel")((threadId, selection) =>
      locks.withLock(
        threadId,
        Effect.gen(function* () {
          const meta = yield* metadata(threadId);
          if (meta && !meta.manuallyOverridden)
            yield* updateMetadata(threadId, (current) =>
              current && !current.manuallyOverridden
                ? { ...current, lastRoutedModel: selection }
                : current,
            );
        }),
      ),
    ),
  });
});
export const layer = Layer.effect(LearnSessionService, make);
