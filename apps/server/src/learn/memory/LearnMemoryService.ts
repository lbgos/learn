import {
  LEARN_MEMORY_NOTES_MAX,
  type LearnMemory,
  type MemoryNote,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../session/LearnSessionStore.ts";
import { ContextSource, type ContextResult, ContextSourceError } from "./ContextSource.ts";
import * as Memory from "./LearnMemoryStore.ts";
import {
  changeMemory,
  DENSE_MIN,
  type MemoryEdit,
  memorySearchResult,
  memorySource,
  MIN_MATCH,
} from "./memory.ts";

/** Likeness a saved note needs to come back as similar to one `update_memory` adds. */
const SIMILAR_MIN = 0.5;

export class LearnMemoryRefused extends Schema.TaggedError<LearnMemoryRefused>()(
  "LearnMemoryRefused",
  { message: Schema.String },
) {}

/** What the tutor's memory tools do; the MCP handlers only decode and map errors. */
export class LearnMemoryService extends Context.Service<
  LearnMemoryService,
  {
    readonly update: (
      threadId: ThreadId,
      change: {
        readonly add?: ReadonlyArray<string> | undefined;
        readonly remove?: ReadonlyArray<string> | undefined;
        readonly quote?: string | undefined;
        readonly until?: string | undefined;
      },
    ) => Effect.Effect<
      {
        readonly added: ReadonlyArray<{ readonly id: string; readonly text: string }>;
        readonly removed: ReadonlyArray<{ readonly id: string; readonly text: string }>;
        readonly notes: number;
        readonly similar?:
          | ReadonlyArray<{ readonly id: string; readonly text: string; readonly at: string }>
          | undefined;
        readonly next?: string | undefined;
      },
      LearnMemoryRefused | Memory.LearnMemoryError
    >;
    readonly search: (
      threadId: ThreadId,
      input: {
        readonly query: string;
        readonly limit?: number | undefined;
        readonly since?: string | undefined;
        readonly retired?: boolean | undefined;
      },
    ) => Effect.Effect<
      ReturnType<typeof memorySearchResult>,
      LearnMemoryRefused | Memory.LearnMemoryError
    >;
    /** Reads the external personal context source; fails when none is configured. */
    readonly contextSearch: (
      threadId: ThreadId,
      input: { readonly query: string; readonly limit?: number | undefined },
    ) => Effect.Effect<
      { readonly results: ReadonlyArray<ContextResult> },
      LearnMemoryRefused | ContextSourceError
    >;
  }
>()("t3/learn/memory/LearnMemoryService") {}

export const layer = Layer.effect(
  LearnMemoryService,
  Effect.gen(function* () {
    const memory = yield* Memory.LearnMemoryStore;
    const sessions = yield* Sessions.LearnSessionStore;
    const projections = yield* Projections.ProjectionStoreV2;
    const context = yield* Effect.serviceOption(ContextSource);

    /** Only a tutoring session's own thread has the learner's memory. */
    const requireSession = (threadId: ThreadId) =>
      sessions.get(threadId).pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((session) =>
          session === null
            ? Effect.fail(
                new LearnMemoryRefused({
                  message: "Only a tutoring session's own thread has the learner's memory.",
                }),
              )
            : Effect.void,
        ),
      );

    const learnerMessages = (threadId: ThreadId) =>
      projections.getThreadRecords(threadId, ["messages"], { turnItemTypes: [] }).pipe(
        Effect.map(({ messages }) =>
          messages
            .filter((m) => m.role === "user" && m.createdBy === "user" && !m.streaming)
            .map((m) => ({ id: m.id, text: m.text, at: DateTime.formatIso(m.createdAt) })),
        ),
        Effect.orElseSucceed(() => []),
      );

    return LearnMemoryService.of({
      update: Effect.fn("LearnMemoryService.update")(function* (threadId, change) {
        yield* requireSession(threadId);
        const sourced = memorySource({
          threadId,
          quote: change.quote,
          at: DateTime.formatIso(yield* DateTime.now),
          userMessages: change.quote?.trim() ? yield* learnerMessages(threadId) : [],
        });
        if (Result.isFailure(sourced))
          return yield* new LearnMemoryRefused({ message: sourced.failure });
        const source = sourced.success;
        // Applied to the stored notes inside the store lock, so a concurrent learner edit is kept.
        let refused: string | undefined;
        let result: MemoryEdit | undefined;
        const changed = (notes: LearnMemory) =>
          Result.match(changeMemory(notes, change, source, LEARN_MEMORY_NOTES_MAX), {
            onSuccess: (next) => {
              result = next;
              return next.notes;
            },
            onFailure: (reason) => {
              refused = reason;
              return notes;
            },
          });
        // Removed notes retire; one added note in the same call is what replaced them. A removal
        // with nothing added is the learner asking to forget, so the nightly check must not re-add it.
        yield* memory.edit(changed, {
          supersededBy: () =>
            result?.added.length === 1 && result.removed.length > 0
              ? result.added[0]!.id
              : undefined,
          forget: () => result !== undefined && result.added.length === 0,
        });
        if (refused || !result)
          return yield* new LearnMemoryRefused({ message: refused ?? "Nothing changed." });
        const edit = result;
        const brief = ({ id, text }: MemoryNote) => ({ id, text });
        // Notes like the new ones, so the tutor can remove what they replace.
        const addedIds = new Set(edit.added.map((note) => note.id));
        const now = yield* Clock.currentTimeMillis;
        const similar = new Map<string, MemoryNote>();
        for (const note of edit.added.slice(0, 3))
          for (const { entry } of yield* memory
            .search(note.text, { limit: 4, min: SIMILAR_MIN, now, dense: DENSE_MIN.similar })
            .pipe(Effect.orElseSucceed(() => [])))
            if (!addedIds.has(entry.note.id) && similar.size < 3)
              similar.set(entry.note.id, entry.note);
        return {
          added: edit.added.map(brief),
          removed: edit.removed.map(brief),
          notes: edit.notes.length,
          ...(similar.size === 0
            ? {}
            : {
                similar: [...similar.values()].map((note) => ({
                  ...brief(note),
                  at: note.source.at.slice(0, 10),
                })),
                next: "These saved notes look alike. Remove any that the new note replaces or that no longer hold.",
              }),
        };
      }),
      search: Effect.fn("LearnMemoryService.search")(function* (threadId, input) {
        yield* requireSession(threadId);
        const now = yield* Clock.currentTimeMillis;
        const ranked = yield* memory.search(input.query, {
          limit: input.limit ?? 5,
          min: MIN_MATCH,
          now,
          since: input.since,
          retired: input.retired,
          dense: DENSE_MIN.search,
        });
        yield* memory
          .touch(
            ranked.map(({ entry }) => entry.note.id),
            DateTime.formatIso(DateTime.makeUnsafe(now)),
          )
          .pipe(Effect.ignore({ log: true }));
        return memorySearchResult(ranked);
      }),
      contextSearch: Effect.fn("LearnMemoryService.contextSearch")(function* (threadId, input) {
        yield* requireSession(threadId);
        if (Option.isNone(context))
          return yield* new LearnMemoryRefused({
            message: "No personal context source is set up.",
          });
        const results = yield* context.value
          .search({ query: input.query, limit: input.limit ?? 5 })
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Personal context search failed", { reason: error.reason }),
            ),
          );
        return { results };
      }),
    });
  }),
);
