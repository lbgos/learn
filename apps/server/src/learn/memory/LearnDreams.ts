import {
  LEARN_MEMORY_NOTES_MAX,
  type LearnMemory,
  type LearnMemoryDreams,
  MemoryChange,
  MemoryNote,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../../config.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import { forkParked } from "../../serverActivation.ts";
import * as Structured from "../LearnStructuredGeneration.ts";
import * as Sessions from "../session/LearnSessionStore.ts";
import * as Memory from "./LearnMemoryStore.ts";
import {
  applyDream,
  type DreamChange,
  type DreamMessage,
  DreamOutput,
  dreamPrompt,
  expireStale,
  undoChange,
} from "./dreaming.ts";
import { PINNED_CHARS, recallQueries, RECALL_MIN } from "./memory.ts";

/** How far back the first run reads, before there is a last run. */
const FIRST_WINDOW_MS = 14 * 86_400_000;
const MESSAGES_PER_RUN = 80;
/** Replies shorter than this get the tutor message they answer, so "yes" can be read. */
const SHORT_REPLY = 60;
const CHANGES_KEPT = 300;
const CHANGES_SHOWN = 100;
/** With more notes the check gets a batch instead of every note. */
const WHOLE_NOTES = 120;
/** A batch: unchecked notes, each with its likest notes, and the notes likest each message. */
const BATCH_UNCHECKED = 60;
const BATCH_NEIGHBOURS = 3;
const BATCH_PER_MESSAGE = 2;
/** Retired notes are deleted after this long. */
const RETIRED_KEPT_MS = 90 * 86_400_000;
/** Days of nightly note snapshots kept under the base directory. */
const BACKUP_DAYS = 14;

const Stored = Schema.Struct({
  enabled: Schema.Boolean,
  /** Learner messages after this are new to the check; it moves only when a run had no errors. */
  lastRunAt: Schema.optional(Schema.String),
  lastRun: Schema.optional(
    Schema.Struct({
      at: Schema.String,
      summary: Schema.String,
      errors: Schema.Array(Schema.String),
    }),
  ),
  changes: Schema.Array(MemoryChange),
});
type Stored = typeof Stored.Type;

export class LearnDreamsError extends Schema.TaggedError<LearnDreamsError>()("LearnDreamsError", {
  operation: Schema.Literals(["read", "write", "missing", "busy"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.operation === "busy"
      ? "The memory check is already running."
      : this.operation === "missing"
        ? "That change no longer exists."
        : `Memory check ${this.operation} failed.`;
  }
}

/** The nightly memory check: off until the learner turns it on, and its log of undoable changes. */
export class LearnDreams extends Context.Service<
  LearnDreams,
  {
    readonly state: Effect.Effect<LearnMemoryDreams>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<LearnMemoryDreams, LearnDreamsError>;
    /** Runs a check and answers once it has ended, as the nightly run does. */
    readonly check: Effect.Effect<LearnMemoryDreams, LearnDreamsError>;
    /** Starts a check in the background; `running` stays true until it ends. */
    readonly runNow: Effect.Effect<LearnMemoryDreams, LearnDreamsError>;
    readonly undo: (id: string) => Effect.Effect<LearnMemoryDreams, LearnDreamsError>;
    /** Runs the check every night at 03:30 server time while it is enabled. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/learn/memory/LearnDreams") {}

const NIGHTLY = { type: "fixed_time", timeOfDay: "03:30" } as const;
const nextRun = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone).pipe(
  Effect.map((now) => nextScheduledRunAt(NIGHTLY, now) ?? DateTime.add(now, { days: 1 })),
);

const COUNT_WORDS: Record<MemoryChange["op"] | "refused", string> = {
  add: "added",
  pin: "pinned",
  unpin: "unpinned",
  confirm: "confirmed",
  rewrite: "corrected",
  merge: "merged",
  stale: "marked stale",
  contradicted: "marked contradicted",
  delete: "deleted",
  expire: "expired",
  refused: "refused",
};

/** A run's changes and refused proposals as "1 corrected, 1 merged", or "No changes". */
function runSummary(changes: ReadonlyArray<Pick<MemoryChange, "op">>, refused: number) {
  const counts: Record<string, number> = refused > 0 ? { refused } : {};
  for (const change of changes) counts[change.op] = (counts[change.op] ?? 0) + 1;
  const parts = Object.entries(COUNT_WORDS).flatMap(([key, word]) =>
    counts[key] === undefined ? [] : [`${counts[key]} ${word}`],
  );
  return parts.length > 0 ? parts.join(", ") : "No changes";
}

const encodeStored = Schema.encodeEffect(Schema.fromJsonString(Stored));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(MemoryNote)));

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const memory = yield* Memory.LearnMemoryStore;
  const sessions = yield* Sessions.LearnSessionStore;
  const projections = yield* Projections.ProjectionStoreV2;
  const structured = yield* Structured.LearnStructuredGeneration;
  const file = path.join(config.stateDir, "learn-memory-dreams.json");
  const lock = yield* Semaphore.make(1);
  const runs = yield* Semaphore.make(1);
  // Runs started from a request outlive it, so a dropped client cannot cut a run short.
  const scope = yield* Effect.scope;
  let running = false;
  let stored: Stored = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Stored))),
    Effect.catchTags({
      PlatformError: (e) =>
        e.reason._tag === "NotFound"
          ? Effect.succeed<Stored>({ enabled: false, changes: [] })
          : Effect.fail(e),
    }),
    Effect.orDie,
  );
  const save = (next: Stored) =>
    lock.withPermit(
      encodeStored(next).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath: file, contents })),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.tap(() =>
          Effect.sync(() => {
            stored = next;
          }),
        ),
        Effect.mapError((cause) => new LearnDreamsError({ operation: "write", cause })),
      ),
    );

  const state = Effect.gen(function* () {
    return {
      enabled: stored.enabled,
      running,
      nextRunAt: stored.enabled ? DateTime.formatIso(yield* nextRun) : null,
      lastRun: stored.lastRun ?? null,
      changes: stored.changes.slice(0, CHANGES_SHOWN),
    } satisfies LearnMemoryDreams;
  });

  /** The learner's own messages in every tutoring session, each short reply with the tutor message it answers. */
  const learnerMessages = Effect.fn("LearnDreams.learnerMessages")(function* () {
    const out: DreamMessage[] = [];
    for (const session of yield* sessions.list.pipe(Effect.orElseSucceed(() => []))) {
      const label = `${session.kind} ${session.createdAt.slice(0, 10)}`;
      const records = yield* projections
        .getThreadRecords(session.threadId, ["messages"], { turnItemTypes: [] })
        .pipe(Effect.orElseSucceed(() => ({ messages: [] })));
      const ordered = records.messages
        .filter((m) => !m.streaming && m.role !== "system")
        .toSorted(
          (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
        );
      let lastTutorText: string | undefined;
      for (const message of ordered) {
        if (message.role === "assistant") {
          if (message.text.trim()) lastTutorText = message.text;
          continue;
        }
        if (message.createdBy !== "user" || !message.text.trim()) continue;
        out.push({
          id: message.id,
          at: DateTime.formatIso(message.createdAt),
          session: label,
          text: message.text,
          ...(message.text.length < SHORT_REPLY && lastTutorText ? { replyTo: lastTutorText } : {}),
        });
      }
    }
    return out;
  });

  /**
   * The notes a large memory sends the check: the oldest unchecked notes with their likest notes,
   * and the notes likest each new message, in stored order.
   */
  const batch = Effect.fn("LearnDreams.batch")(function* (
    all: LearnMemory,
    messages: ReadonlyArray<DreamMessage>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const picked = new Set<string>();
    const likest = (query: string, limit: number, min: number) =>
      memory.search(query, { limit, min, now, scan: false }).pipe(Effect.orElseSucceed(() => []));
    for (const note of all.filter((n) => n.checkedAt === undefined).slice(0, BATCH_UNCHECKED)) {
      picked.add(note.id);
      for (const { entry } of yield* likest(note.text, BATCH_NEIGHBOURS + 1, 0.35))
        picked.add(entry.note.id);
    }
    for (const message of messages) {
      const [query] = recallQueries(message.text);
      if (query === undefined) continue;
      for (const { entry } of yield* likest(query, BATCH_PER_MESSAGE, RECALL_MIN))
        picked.add(entry.note.id);
    }
    return all.filter((note) => picked.has(note.id));
  });

  const backups = path.join(config.baseDir, "backups", "learn-memory");
  /** Writes every note to `backups/learn-memory/notes-<day>.json` and drops copies past 14 days. */
  const backUpNotes = Effect.fn("LearnDreams.backUpNotes")(
    function* (nowMs: number) {
      const day = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(0, 10);
      yield* fs.makeDirectory(backups, { recursive: true });
      yield* writeFileStringAtomically({
        filePath: path.join(backups, `notes-${day(nowMs)}.json`),
        contents: yield* encodeSnapshot(yield* memory.snapshot),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const oldest = `notes-${day(nowMs - BACKUP_DAYS * 86_400_000)}.json`;
      for (const name of yield* fs.readDirectory(backups))
        if (/^notes-\d{4}-\d{2}-\d{2}\.json$/.test(name) && name < oldest)
          yield* fs.remove(path.join(backups, name));
    },
    Effect.mapError((cause) => new LearnDreamsError({ operation: "write", cause })),
  );

  const run = Effect.fn("LearnDreams.run")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const since =
      stored.lastRunAt ?? DateTime.formatIso(DateTime.makeUnsafe(nowMs - FIRST_WINDOW_MS));
    const everything = yield* learnerMessages();
    const messages = everything
      .filter((m) => m.at > since)
      .toSorted((a, b) => a.at.localeCompare(b.at))
      .slice(-MESSAGES_PER_RUN);
    // A failed snapshot stops the run before anything changes.
    yield* backUpNotes(nowMs);
    yield* memory
      .purgeRetired(DateTime.formatIso(DateTime.makeUnsafe(nowMs - RETIRED_KEPT_MS)))
      .pipe(Effect.ignore({ log: true }));
    const errors: string[] = [];
    const changes: DreamChange[] = [];
    const refusals: string[] = [];
    const all = yield* memory.notes.pipe(Effect.orElseSucceed((): LearnMemory => []));
    if (all.length > 0 || messages.length > 0) {
      const notes = all.length <= WHOLE_NOTES ? all : yield* batch(all, messages);
      const sources = new Map(
        notes.flatMap((note): Array<[string, DreamMessage]> => {
          const message = everything.find((m) => m.id === note.source.messageId);
          return message ? [[note.id, message]] : [];
        }),
      );
      // Notes nobody checked yet, or news from the learner, are worth a model call; else only expiry.
      const worthChecking =
        messages.length > 0 || notes.some((note) => note.checkedAt === undefined);
      const output = worthChecking
        ? yield* structured
            .run({
              role: "review",
              label: "learn.memory.dream",
              prompt: dreamPrompt({
                notes,
                pinChars: PINNED_CHARS,
                partial: notes.length < all.length,
                sources,
                messages,
                now,
              }),
              schema: DreamOutput,
            })
            .pipe(
              Effect.timeout("5 minutes"),
              Effect.catchCause((cause) =>
                Effect.logWarning("Learn memory check failed", { cause }).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      errors.push("Could not check the notes.");
                      return undefined;
                    }),
                  ),
                ),
              ),
            )
        : { ops: [] };
      if (output !== undefined) {
        const forgotten = yield* memory.forgotten.pipe(
          Effect.orElseSucceed(() => ({ hashes: new Set<string>(), messages: new Set<string>() })),
        );
        const snapshot = new Map(notes.map((note) => [note.id, JSON.stringify(note)]));
        const apply = (current: LearnMemory) => {
          // Runs again if the store retries; only the last pass's changes are logged.
          changes.length = 0;
          refusals.length = 0;
          const expired = expireStale(current, now);
          // A note the learner or the tutor changed while the model read it keeps that change.
          const unchanged = (id: string) =>
            snapshot.get(id) === JSON.stringify(current.find((note) => note.id === id));
          const result = applyDream({
            forgotten,
            notes: expired.notes,
            ops: output.ops.filter((op) => op.ids.every(unchanged)),
            messages,
            sources,
            now,
            pinChars: PINNED_CHARS,
            max: LEARN_MEMORY_NOTES_MAX,
          });
          refusals.push(...result.refused);
          changes.push(...expired.changes, ...result.changes);
          // Fresh notes the model read and left alone count as checked; stale ones keep their date to expire.
          return result.notes.map((note) =>
            worthChecking && note.status === "fresh" && snapshot.has(note.id) && unchanged(note.id)
              ? { ...note, checkedAt: now }
              : note,
          );
        };
        yield* Effect.asVoid(memory.edit(apply)).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              errors.push("Could not save the notes.");
            }),
          ),
        );
        if (refusals.length > 0)
          yield* Effect.logInfo("Learn memory check refused ops", { refusals });
      }
    }
    const logged = changes.map((change, index) => ({ ...change, id: `${now}#${index}` }));
    yield* save({
      ...stored,
      ...(errors.length === 0 ? { lastRunAt: now } : {}),
      lastRun: { at: now, summary: runSummary(changes, refusals.length), errors },
      changes: [...logged.toReversed(), ...stored.changes].slice(0, CHANGES_KEPT),
    });
  });

  const runOnce = runs.withPermit(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        running = true;
      }),
      () => run(),
      () =>
        Effect.sync(() => {
          running = false;
        }),
    ),
  );

  return LearnDreams.of({
    state,
    setEnabled: Effect.fn("LearnDreams.setEnabled")(function* (enabled) {
      yield* save({ ...stored, enabled });
      return yield* state;
    }),
    check: runOnce.pipe(Effect.andThen(state)),
    runNow: Effect.suspend(() => {
      if (running) return Effect.fail(new LearnDreamsError({ operation: "busy" }));
      running = true;
      return Effect.forkIn(
        runOnce.pipe(
          Effect.catchCause((cause) => Effect.logWarning("Learn memory check failed", { cause })),
        ),
        scope,
      );
    }).pipe(Effect.andThen(state)),
    undo: Effect.fn("LearnDreams.undo")(function* (id) {
      const change = stored.changes.find((c) => c.id === id);
      if (!change) return yield* new LearnDreamsError({ operation: "missing" });
      if (!change.undone) {
        yield* memory
          .edit((notes) => undoChange(notes, change))
          .pipe(Effect.mapError(() => new LearnDreamsError({ operation: "missing" })));
        yield* save({
          ...stored,
          changes: stored.changes.map((c) => (c.id === id ? { ...c, undone: true } : c)),
        });
      }
      return yield* state;
    }),
    start: Effect.fn("LearnDreams.start")(() =>
      forkParked(
        Effect.gen(function* () {
          while (true) {
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.sleep(Duration.millis(DateTime.toEpochMillis(yield* nextRun) - now));
            if (!stored.enabled) continue;
            yield* runOnce.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Learn memory check failed", { cause }),
              ),
            );
          }
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(LearnDreams, make);
