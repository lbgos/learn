import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import { flushRunIds, resetRecap } from "./contextFlush.ts";
import * as Memory from "./LearnMemoryStore.ts";
import {
  DENSE_MIN,
  memoryIndex,
  mergeRanked,
  pickRecalled,
  RECALL_MIN,
  recallQueries,
  recalledLine,
} from "./memory.ts";

/** A note recalled into a provider thread is not recalled there again for this many turns. */
const RECALL_REPEAT_TURNS = 10;
/** Provider threads whose recalled notes are remembered; the oldest is forgotten first. */
const SEEN_THREADS = 500;
/** Ranked candidates read per turn before the recall budget picks from them. */
const RECALL_CANDIDATES = 20;

/** What one provider thread has been shown, so a turn does not repeat what its history holds. */
interface Seen {
  turn: number;
  /** Whether the notes every turn carries have been counted as used in this thread. */
  coreCounted: boolean;
  readonly recalled: Map<string, number>;
}

/** The `learn_memory` block: the notes every turn carries, then notes recalled for this message. */
function formatMemoryContext(input: {
  readonly core: string;
  readonly recalled: ReadonlyArray<string>;
}): string {
  return [
    `Notes about the learner:\n${input.core}`,
    ...(input.recalled.length > 0
      ? [
          `More notes that may bear on this message, each with the date it was saved:\n${input.recalled.join("\n")}`,
        ]
      : []),
  ].join("\n");
}

/** Builds the learner-memory block of a tutor turn. */
export class LearnMemoryTurns extends Context.Service<
  LearnMemoryTurns,
  {
    /** Undefined when there is nothing to show; a failed read leaves the turn without the block. */
    readonly forTurn: (input: {
      readonly threadId: ThreadId;
      readonly runId: string;
      readonly providerThreadId: string;
      /** The learner's message that starts the run. */
      readonly message: string;
    }) => Effect.Effect<string | undefined>;
  }
>()("t3/learn/memory/LearnMemoryTurns") {}

export const layer = Layer.effect(
  LearnMemoryTurns,
  Effect.gen(function* () {
    const memory = yield* Memory.LearnMemoryStore;
    const projections = yield* Projections.ProjectionStoreV2;
    // Lives in memory: after a restart a thread may see a note recalled once more.
    const seenBy = new Map<string, Seen>();
    const seenIn = (providerThreadId: string) => {
      const seen = seenBy.get(providerThreadId) ?? {
        turn: 0,
        coreCounted: false,
        recalled: new Map(),
      };
      seenBy.delete(providerThreadId);
      seenBy.set(providerThreadId, seen);
      if (seenBy.size > SEEN_THREADS) seenBy.delete(seenBy.keys().next().value!);
      seen.turn += 1;
      return seen;
    };

    const notesForTurn = Effect.fn("LearnMemoryTurns.notesForTurn")(function* (
      input: {
        readonly providerThreadId: string;
        readonly message: string;
      },
      lastReply: string | undefined,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const at = DateTime.formatIso(DateTime.makeUnsafe(now));
      const core = yield* memory.core(at);
      if (core.total === 0) return undefined;
      const seen = seenIn(input.providerThreadId);
      const exclude = new Set([
        ...core.shown.map((note) => note.id),
        ...[...seen.recalled]
          .filter(([, turn]) => seen.turn - turn < RECALL_REPEAT_TURNS)
          .map(([id]) => id),
      ]);
      // Recall and the use counts only add to the core; when they fail the turn keeps the core.
      const ranked = yield* Effect.forEach(recallQueries(input.message, lastReply), (query) =>
        memory.search(query, {
          limit: RECALL_CANDIDATES,
          min: RECALL_MIN,
          now,
          scan: false,
          dense: DENSE_MIN.recall,
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Learn memory recall failed", { cause }).pipe(Effect.as([])),
        ),
      );
      const recalled = pickRecalled(mergeRanked(ranked), exclude);
      for (const { note } of recalled) seen.recalled.set(note.id, seen.turn);
      const used = [
        ...(seen.coreCounted ? [] : core.shown.map((note) => note.id)),
        ...recalled.map(({ note }) => note.id),
      ];
      seen.coreCounted = true;
      yield* memory
        .touch(used, at)
        .pipe(
          Effect.catch((cause) => Effect.logWarning("Learn memory use count failed", { cause })),
        );
      return formatMemoryContext({
        core: memoryIndex(core.shown, core.total),
        recalled: recalled.map(({ note }) => recalledLine(note)),
      });
    });

    return LearnMemoryTurns.of({
      forTurn: Effect.fn("LearnMemoryTurns.forTurn")(
        function* (input) {
          const records = yield* projections
            .getThreadRecords(input.threadId, ["runs", "messages"], { turnItemTypes: [] })
            .pipe(Effect.orElseSucceed(() => ({ runs: [], messages: [] })));
          const flush = flushRunIds(records.messages);
          const lastReply = records.messages
            .filter(
              (m) =>
                m.role === "assistant" &&
                m.runId !== input.runId &&
                !m.streaming &&
                (m.runId === null || !flush.has(m.runId)),
            )
            .toSorted(
              (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
            )
            .at(-1)?.text;
          const blocks = [
            yield* notesForTurn(input, lastReply),
            resetRecap({
              ...records,
              runId: input.runId,
              providerThreadId: input.providerThreadId,
            }),
          ].filter((block) => block !== undefined);
          return blocks.length === 0 ? undefined : blocks.join("\n");
        },
        // A defect, such as a corrupt stored vector, must not fail the turn either.
        Effect.catchCause((cause) =>
          Effect.logWarning("Learn memory unavailable for a turn", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      ),
    });
  }),
);
