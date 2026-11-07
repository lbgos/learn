import { LearnGraphError, type ThreadId } from "@t3tools/contracts";
import { learnerRecord, type LearnerRecord } from "@t3tools/learn/review";
import { sessionEventsFromThread } from "@t3tools/learn/session";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import { LearnRetrievals } from "../graph/LearnRetrievals.ts";
import * as Store from "./LearnSessionStore.ts";

const empty: LearnerRecord = { retrievals: [], answers: [] };

/** Replays each session thread once per change; the shell's item count and update time key the cache. */
export const layer = Layer.effect(
  LearnRetrievals,
  Effect.gen(function* () {
    const store = yield* Store.LearnSessionStore;
    const projections = yield* Projections.ProjectionStoreV2;
    const cache = new Map<ThreadId, { readonly key: string; readonly record: LearnerRecord }>();
    const threadRecord = Effect.fn("LearnRetrievalSource.thread")(function* (
      meta: Store.StoredLearnSession,
    ) {
      const shell = yield* projections.getThreadShell(meta.threadId);
      if (!shell || shell.deletedAt !== null) return empty;
      const key = `${shell.itemCount}:${DateTime.formatIso(shell.updatedAt)}`;
      const cached = cache.get(meta.threadId);
      if (cached?.key === key) return cached.record;
      const records = yield* projections.getThreadRecords(meta.threadId, ["turnItems", "runs"]);
      const record = learnerRecord(sessionEventsFromThread(records), { meta });
      cache.set(meta.threadId, { key, record });
      return record;
    });
    return LearnRetrievals.of({
      record: Effect.gen(function* () {
        const sessions = yield* store.list;
        const records = yield* Effect.forEach(
          sessions,
          (meta) =>
            threadRecord(meta).pipe(
              // One unreadable thread must not hide every other session's reviews.
              Effect.catch((cause) =>
                Effect.logWarning("Skipped a learn session in review state", cause).pipe(
                  Effect.as(empty),
                ),
              ),
            ),
          { concurrency: 4 },
        );
        return {
          retrievals: records.flatMap((record) => record.retrievals),
          answers: records.flatMap((record) => record.answers),
        };
      }).pipe(
        Effect.mapError(
          (cause) => new LearnGraphError({ operation: "review", reason: "unavailable", cause }),
        ),
      ),
    });
  }),
);
