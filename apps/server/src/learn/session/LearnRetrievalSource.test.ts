import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import { LearnRetrievals } from "../graph/LearnRetrievals.ts";
import * as Source from "./LearnRetrievalSource.ts";
import * as Store from "./LearnSessionStore.ts";
import { appendResult, conclusion, problem, projection, threadId } from "./testkit.ts";

const result = (id: string, name: "problem" | "conclude", input: unknown, at: string) => ({
  learnSession: { id, name, input, at },
  message: "",
});

it.effect(
  "replays practice threads into retrievals and rereads a thread only after it changes",
  () => {
    let snapshot: OrchestrationV2ThreadProjection = appendResult(
      projection(),
      result("p1", "problem", { ...problem, target: ["n_period"] }, "2026-10-24T12:01:00.000Z"),
    );
    let reads = 0;
    const layer = Source.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Store.LearnSessionStore, {
            update: () => Effect.succeed(null),
            get: () => Effect.succeed(null),
            put: () => Effect.void,
            list: Effect.succeed([
              {
                threadId,
                kind: "practice" as const,
                mechanic: "choice" as const,
                createdAt: "2026-10-24",
              },
            ]),
          }),
          Layer.mock(Projections.ProjectionStoreV2)({
            getThreadShell: () =>
              Effect.sync(() => ({
                ...liveThreadShell(threadId),
                itemCount: snapshot.turnItems.length,
              })),
            getThreadRecords: () =>
              Effect.sync(() => {
                reads++;
                return snapshot;
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const retrievals = yield* LearnRetrievals;
      assert.deepEqual((yield* retrievals.record).retrievals, []);
      snapshot = appendResult(
        snapshot,
        result("c1", "conclude", conclusion, "2026-10-24T12:02:00.000Z"),
      );
      const concluded = yield* retrievals.record;
      assert.deepEqual(
        concluded.retrievals.map(({ nodeId, outcome }) => [nodeId, outcome]),
        [["n_period", "solved"]],
      );
      yield* retrievals.record;
      assert.equal(reads, 2);
    }).pipe(Effect.provide(layer));
  },
);
