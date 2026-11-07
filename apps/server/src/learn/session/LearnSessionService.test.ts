import { MessageId, TurnItemId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GraphNode } from "@t3tools/learn/graph";
import * as Effect from "effect/Effect";
import { McpSchema } from "effect/ai";
import {
  createSessionGate,
  sessionEventsFromThread,
  formatAnswerMessage,
  buildAnswer,
} from "@t3tools/learn/session";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Graph from "../graph/LearnGraphStore.ts";
import * as Router from "../LearnModelRouter.ts";
import * as Store from "./LearnSessionStore.ts";
import * as Sessions from "./LearnSessionService.ts";
import {
  appendResult,
  assessment,
  conclusion,
  plan,
  now,
  planning,
  practice,
  problem,
  projection,
  quiz,
  threadId,
  tutor,
} from "./testkit.ts";

const decodeGraphNode = Schema.decodeSync(GraphNode);
const encodeMcpResult = Schema.encodeEffect(McpSchema.CallToolResult);

function fixture(kind: "teach" | "practice" = "teach", managed = true) {
  let snapshot = projection();
  let meta: Store.StoredLearnSession | null = managed
    ? { threadId, kind, mechanic: "choice", createdAt: "2026-10-24", lastRoutedModel: tutor }
    : null;
  let routeFailure: "unset" | "instance-disabled" | undefined;
  const roles: string[] = [];
  let failWrite = false;
  const writes: Parameters<EventSink.EventSinkV2["Service"]["write"]>[0][] = [];
  const layer = Sessions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Projections.ProjectionStoreV2)({
          getThreadProjection: () => Effect.sync(() => snapshot),
        }),
        Layer.succeed(Store.LearnSessionStore, {
          update: (_id, change) =>
            Effect.sync(() => {
              meta = change(meta);
              return meta;
            }),
          get: () => Effect.sync(() => meta),
          put: (next) =>
            Effect.sync(() => {
              meta = next;
            }),
          list: Effect.sync(() => (meta ? [meta] : [])),
        }),
        Layer.succeed(Router.LearnModelRouter, {
          snapshot: () => Effect.die("unused snapshot"),
          resolve: (role) =>
            Effect.suspend(() => {
              roles.push(role);
              return routeFailure
                ? Effect.fail(new Router.LearnRouteUnavailable({ role, reason: routeFailure }))
                : Effect.succeed(
                    role === "planning" ? planning : role === "practice" ? practice : tutor,
                  );
            }),
        }),
        Layer.mock(Graph.LearnGraphStore)({
          read: Effect.succeed({
            nodes: [
              decodeGraphNode({
                id: "n_known",
                name: "Period",
                statement: "A cycle repeats.",
                aliases: [],
                createdAt: "now",
                provenance: [],
              }),
            ],
            chains: [],
            coverage: [],
            checkpoints: [],
            sources: [],
            positions: {},
          }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.suspend(() => {
              if (failWrite)
                return Effect.fail(
                  new EventSink.EventSinkWriteError({ eventCount: input.events.length }),
                );
              writes.push(input);
              const items = input.events.flatMap((event) =>
                event.type === "turn-item.updated" ? [event.payload] : [],
              );
              snapshot = { ...snapshot, turnItems: [...snapshot.turnItems, ...items] };
              return Effect.succeed([]);
            }),
        }),
        NodeServices.layer,
      ),
    ),
  );
  return {
    layer,
    roles,
    writes,
    failWrite: (value: boolean) => {
      failWrite = value;
    },
    getMeta: () => meta,
    setSnapshot: (next: typeof snapshot) => {
      snapshot = next;
    },
    getSnapshot: () => snapshot,
    failRoute: (reason: typeof routeFailure) => {
      routeFailure = reason;
    },
  };
}
it.effect("accepts free recall in an existing choice teach session", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const sessions = yield* Sessions.LearnSessionService;
    const invoking = projection().runs[0]!;
    const queued = { ...projection(2).runs[0]!, status: "queued" as const };
    f.setSnapshot({ ...projection(), runs: [invoking, queued] });
    const result = yield* sessions.call(
      threadId,
      "explain",
      {
        question: "Why does pendulum mass cancel?",
        correctAnswer: "Gravity and inertia both scale with mass.",
      },
      invoking.id,
    );
    assert.equal(f.getSnapshot().turnItems[0]?.runId, invoking.id);
    assert.equal(result.learnSession.name, "explain");
    assert.equal(
      createSessionGate(
        { kind: "teach", mechanic: "choice" },
        sessionEventsFromThread(f.getSnapshot()),
      )
        .questions.values()
        .next().value?.name,
      "explain",
    );
    const snapshot = f.getSnapshot();
    f.setSnapshot({
      ...snapshot,
      turnItems: [
        ...snapshot.turnItems,
        {
          threadId,
          runId: snapshot.runs[0]!.id,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          id: TurnItemId.make("answer"),
          ordinal: 1,
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          workflowScript: false,
          messageId: MessageId.make("answer"),
          attachments: [],
          text: formatAnswerMessage(
            buildAnswer(
              result.learnSession.id,
              { kind: "explain", input: { question: "Why?", correctAnswer: "Both scale." } },
              { text: "Both scale.", confidence: 80 },
            ),
          ),
        },
      ],
    });
    yield* sessions.call(threadId, "grade_answer", {
      questionId: result.learnSession.id,
      verdict: "incorrect",
      reason: "Missing gravity.",
    });
    yield* sessions.call(threadId, "correct_verdict", {
      questionId: result.learnSession.id,
      verdict: "correct",
      reason: "Gravity is included.",
    });
    assert.equal(f.writes.length, 3);
    assert.deepEqual(
      createSessionGate(
        { kind: "teach", mechanic: "choice" },
        sessionEventsFromThread(f.getSnapshot()),
      ).answers.get(result.learnSession.id)?.verdict,
      "correct",
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect("validates phases and sees probe_done, plan_init and quiz in the same turn", () => {
  const f = fixture("teach", false);
  return Effect.gen(function* () {
    const sessions = yield* Sessions.LearnSessionService;
    assert.include(
      (yield* sessions.call(threadId, "plan_init", plan).pipe(Effect.flip)).message,
      "probe_done first",
    );
    assert.include(
      (yield* sessions
        .call(threadId, "quiz", { ...quiz, type: "predict", nodeId: "force" })
        .pipe(Effect.flip)).message,
      "omit type and nodeId",
    );
    assert.include(
      (yield* sessions.call(threadId, "problem", problem).pipe(Effect.flip)).message,
      "only available in practice",
    );
    yield* sessions.call(threadId, "probe_done", assessment);
    assert.include(
      (yield* sessions.call(threadId, "quiz", quiz).pipe(Effect.flip)).message,
      "plan phase",
    );
    yield* sessions.call(threadId, "plan_init", plan);
    assert.include(
      (yield* sessions.call(threadId, "quiz", quiz).pipe(Effect.flip)).message,
      "type is required",
    );
    assert.include(
      (yield* sessions
        .call(threadId, "quiz", { ...quiz, type: "check", nodeId: "absent" })
        .pipe(Effect.flip)).message,
      "Unknown nodeId",
    );
    const result = yield* sessions.call(threadId, "quiz", {
      ...quiz,
      type: "check",
      nodeId: "force",
    });
    assert.include(result.message, `[answer ${result.learnSession.id}]`);
    assert.include(yield* sessions.contextForThread(threadId), "plan: current force");
    const parked = yield* sessions.call(threadId, "park_question", {
      question: "Why is a long pendulum slower?",
      nodeId: "period",
    });
    assert.include(
      yield* sessions.contextForThread(threadId),
      `parked questions:\n- ${parked.learnSession.id} | step period, due at the next step | Why is a long pendulum slower?`,
    );
    assert.deepEqual(
      (yield* sessions.stateForThread(threadId, 4)).parked?.map((event) => event.id),
      [parked.learnSession.id],
    );
    yield* sessions.call(threadId, "answer_parked", { id: parked.learnSession.id });
    assert.notInclude(yield* sessions.contextForThread(threadId), "parked questions:");
    const checkpoint = yield* sessions.stateForThread(threadId, 2);
    assert.equal(checkpoint.phase, "teach");
    assert.equal(checkpoint.plan?.nodes[0]?.id, "force");
    assert.deepEqual(checkpoint.questions, []);
    assert.equal(
      (yield* sessions.stateForThread(threadId, 3)).questions[0]?.id,
      result.learnSession.id,
    );
  }).pipe(Effect.provide(f.layer));
});
it.effect(
  "serializes parallel poses, validates whole-graph targets, and supports conclude then pose",
  () => {
    const f = fixture("practice");
    return Effect.gen(function* () {
      const sessions = yield* Sessions.LearnSessionService;
      assert.include(
        (yield* sessions
          .call(threadId, "problem", { ...problem, target: ["n_unknown"] })
          .pipe(Effect.flip)).message,
        "Unknown target ids",
      );
      const results = yield* Effect.all(
        [
          sessions
            .call(threadId, "problem", { ...problem, target: ["n_known"] })
            .pipe(Effect.result),
          sessions.call(threadId, "problem", problem).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((r) => r._tag === "Success").length, 1);
      const posed = results.find((r) => r._tag === "Success");
      assert.isDefined(posed);
      if (posed?._tag !== "Success") return;
      f.setSnapshot(appendResult(projection(2), posed.success));
      assert.include(
        (yield* sessions.call(threadId, "problem", problem).pipe(Effect.flip)).message,
        "already active",
      );
      yield* sessions.call(threadId, "conclude", conclusion);
      yield* sessions.call(threadId, "problem", problem);
      assert.include(
        (yield* sessions.call(threadId, "quiz", quiz).pipe(Effect.flip)).message,
        "unavailable in practice",
      );
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect(
  "rebuilds a gate for each new turn and routes probe/plan to planning, then teach to tutor",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const sessions = yield* Sessions.LearnSessionService;
      assert.deepEqual(yield* sessions.modelForTurn(threadId), planning);
      // Merely resolving never records a model that a failed dispatch did not apply.
      assert.deepEqual(f.getMeta()?.lastRoutedModel, tutor);
      yield* sessions.recordRoutedModel(threadId, planning);
      f.setSnapshot({ ...projection(1, planning) });
      const done = yield* sessions.call(threadId, "probe_done", assessment);
      f.setSnapshot(appendResult(projection(2, planning), done));
      assert.deepEqual(yield* sessions.modelForTurn(threadId), planning);
      const planned = yield* sessions.call(threadId, "plan_init", plan);
      f.setSnapshot(appendResult(appendResult(projection(3, planning), done), planned));
      assert.deepEqual(yield* sessions.modelForTurn(threadId), tutor);
      assert.include(yield* sessions.contextForThread(threadId), "phase: teach");
      f.setSnapshot(projection(4, planning));
      assert.include(yield* sessions.contextForThread(threadId), "phase: probe");
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("keeps a manual override permanently, including option-only composer picks", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const sessions = yield* Sessions.LearnSessionService;
    assert.isUndefined(
      yield* sessions.modelForTurn(threadId, {
        ...tutor,
        options: [{ id: "effort", value: "low" }],
      }),
    );
    assert.isTrue(f.getMeta()?.manuallyOverridden);
    assert.isUndefined(yield* sessions.modelForTurn(threadId, tutor));
    yield* sessions.recordRoutedModel(threadId, planning);
    assert.deepEqual(f.getMeta()?.lastRoutedModel, tutor);
    assert.deepEqual(f.roles, []);
  }).pipe(Effect.provide(f.layer));
});
it.effect("routes practice, ignores unmanaged threads, and only tolerates unset routes", () => {
  const f = fixture("practice");
  return Effect.gen(function* () {
    const sessions = yield* Sessions.LearnSessionService;
    assert.deepEqual(yield* sessions.modelForTurn(threadId), practice);
    f.failRoute("unset");
    assert.isUndefined(yield* sessions.modelForTurn(threadId));
    f.failRoute("instance-disabled");
    const failure = yield* sessions.modelForTurn(threadId).pipe(Effect.flip);
    assert.instanceOf(failure, Router.LearnRouteUnavailable);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "encodes an untagged problem as an MCP JSON result and records replayable practice state",
  () => {
    const f = fixture("practice");
    return Effect.gen(function* () {
      const sessions = yield* Sessions.LearnSessionService;
      const result = yield* sessions.call(threadId, "problem", problem);
      const encoded = yield* encodeMcpResult(
        new McpSchema.CallToolResult({
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        }),
      );
      assert.isDefined(encoded.structuredContent);
      assert.equal(f.writes.length, 1);
      const replay = () =>
        createSessionGate(
          { kind: "practice", mechanic: "choice" },
          sessionEventsFromThread(f.getSnapshot()),
        );
      assert.equal(replay().problem?.id, result.learnSession.id);
      yield* sessions.call(threadId, "conclude", conclusion);
      assert.isNull(replay().problem);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("sees an answer steered into the same run attempt", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const sessions = yield* Sessions.LearnSessionService;
    const input = { question: "What do you know?" };
    const posed = yield* sessions.call(threadId, "ask", input);
    const snapshot = f.getSnapshot();
    const item = snapshot.turnItems[0]!;
    f.setSnapshot({
      ...snapshot,
      turnItems: [
        ...snapshot.turnItems,
        {
          id: TurnItemId.make("steered-answer"),
          threadId,
          runId: item.runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
          updatedAt: item.updatedAt,
          type: "user_message",
          messageId: MessageId.make("steered-answer"),
          text: formatAnswerMessage(
            buildAnswer(
              posed.learnSession.id,
              { kind: "ask", input },
              { text: "I know a cycle repeats." },
            ),
          ),
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          inputIntent: "steer",
        },
      ],
    });
    yield* sessions.call(threadId, "probe_done", assessment);
  }).pipe(Effect.provide(f.layer));
});

it.effect("keeps the gate unchanged when recording a problem or conclusion fails", () => {
  const f = fixture("practice");
  return Effect.gen(function* () {
    const sessions = yield* Sessions.LearnSessionService;
    f.failWrite(true);
    assert.instanceOf(
      yield* sessions.call(threadId, "problem", problem).pipe(Effect.flip),
      Sessions.LearnSessionError,
    );
    assert.equal(f.writes.length, 0);
    f.failWrite(false);
    yield* sessions.call(threadId, "problem", problem);
    f.failWrite(true);
    assert.instanceOf(
      yield* sessions.call(threadId, "conclude", conclusion).pipe(Effect.flip),
      Sessions.LearnSessionError,
    );
    assert.include(
      (yield* sessions.call(threadId, "problem", problem).pipe(Effect.flip)).message,
      "already active",
    );
    f.failWrite(false);
    yield* sessions.call(threadId, "conclude", conclusion);
    yield* sessions.call(threadId, "problem", problem);
  }).pipe(Effect.provide(f.layer));
});
