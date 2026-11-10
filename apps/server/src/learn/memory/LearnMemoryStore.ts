import {
  LEARN_MEMORY_NOTES_MAX,
  type LearnMemory,
  MemoryNote,
  type MemoryNotesPage,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { layer as MemoryEmbedderLayer, MemoryEmbedder } from "./MemoryEmbedder.ts";
import {
  coreNotes,
  cosine,
  type Forgotten,
  forgetKey,
  ftsQuery,
  fuseRanked,
  MIN_MATCH,
  QUERY_CHARS,
  type Ranked,
  rankNotes,
  searchText,
} from "./memory.ts";

/** The `pinned` column: who pinned the note. */
const PIN = { none: 0, auto: 1, user: 2 } as const;
/** Full-text candidates read before reranking; fewer than `SCAN_BELOW` falls back to a scan. */
const CANDIDATES = 100;
const SCAN_BELOW = 5;
/** Notes embedded per call to the embedder while vectors catch up. */
const EMBED_BATCH = 32;

export class LearnMemoryError extends Schema.TaggedError<LearnMemoryError>()("LearnMemoryError", {
  operation: Schema.Literals(["read", "write", "missing", "cap"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.operation === "cap"
      ? "Memory is full. Merge or remove some notes."
      : this.operation === "missing"
        ? "That note no longer exists."
        : `Memory ${this.operation} failed.`;
  }
}

const isMemoryError = Schema.is(LearnMemoryError);

export interface SearchOptions {
  readonly limit: number;
  /** Lowest relevance (mean likeness of the query's words) a note needs. */
  readonly min: number;
  readonly now: number;
  /** Search retired notes instead of the others. */
  readonly retired?: boolean | undefined;
  /** Only notes saved on or after this date (YYYY-MM-DD). */
  readonly since?: string | undefined;
  /** Scan every note when the index finds few; the per-turn recall skips that to stay fast. */
  readonly scan?: boolean | undefined;
  /**
   * Also rank notes by their vector's cosine similarity to the query's (`DENSE_MIN`) and fuse
   * both rankings. Left out, or while the embedder is unavailable, search goes by words alone.
   */
  readonly dense?: number | undefined;
}

export interface MemoryEntry {
  readonly note: MemoryNote;
}

/**
 * The learner's memory notes in the server database, with a trigram full-text index for search,
 * use counts for ranking and, with an embedder, a vector per live note. Callers change notes
 * through `edit` with the pure functions in `memory.ts`, as plain lists without use counts.
 */
export class LearnMemoryStore extends Context.Service<
  LearnMemoryStore,
  {
    /** Live notes in stored order, without use counts. */
    readonly notes: Effect.Effect<LearnMemory, LearnMemoryError>;
    /**
     * Applies `change` to the notes as stored now (as `notes` gives them). Notes it leaves out
     * retire, or are deleted with `remove: "delete"`; a note that comes back is restored.
     */
    readonly edit: (
      change: (notes: LearnMemory) => LearnMemory,
      options?: {
        readonly remove?: "retire" | "delete" | undefined;
        /** The note that replaced the retired ones, read once `change` has run. */
        readonly supersededBy?: (() => string | undefined) | undefined;
        /** The learner asked to forget the removed notes: they leave a tombstone even when retired. */
        readonly forget?: (() => boolean) | undefined;
      },
    ) => Effect.Effect<LearnMemory, LearnMemoryError>;
    /** Pins or unpins a note, or retires or restores it. */
    readonly setNote: (
      id: string,
      change: { readonly pinned?: boolean | undefined; readonly retired?: boolean | undefined },
    ) => Effect.Effect<void, LearnMemoryError>;
    readonly page: (request: {
      readonly query?: string | undefined;
      readonly retired?: boolean | undefined;
      readonly offset: number;
      readonly limit: number;
    }) => Effect.Effect<MemoryNotesPage, LearnMemoryError>;
    /** The notes every turn carries (see `coreNotes`) and how many live notes there are. */
    readonly core: (
      today: string,
    ) => Effect.Effect<
      { readonly shown: ReadonlyArray<MemoryNote>; readonly total: number },
      LearnMemoryError
    >;
    readonly search: (
      query: string,
      options: SearchOptions,
    ) => Effect.Effect<Array<Ranked<MemoryEntry>>, LearnMemoryError>;
    /** Counts each note as used once more at `at`. */
    readonly touch: (
      ids: ReadonlyArray<string>,
      at: string,
    ) => Effect.Effect<void, LearnMemoryError>;
    /** Hashes (`forgetKey`) and source messages of the notes the learner forgot. */
    readonly forgotten: Effect.Effect<Forgotten, LearnMemoryError>;
    /** Every note, retired ones too, for the nightly backup. */
    readonly snapshot: Effect.Effect<LearnMemory, LearnMemoryError>;
    /** Deletes notes retired before `before`; returns how many. */
    readonly purgeRetired: (before: string) => Effect.Effect<number, LearnMemoryError>;
    /**
     * Embeds the live notes that have no vector yet, and returns how many live notes there are
     * and how many have one. Writes run it in the background; it stops early while the embedder
     * is unavailable. Undefined without an embedder.
     */
    readonly syncVectors: Effect.Effect<
      { readonly notes: number; readonly vectors: number } | undefined,
      LearnMemoryError
    >;
  }
>()("t3/learn/memory/LearnMemoryStore") {}

interface Row {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly reason: string | null;
  readonly source_by: string;
  readonly thread_id: string | null;
  readonly message_id: string | null;
  readonly quote: string | null;
  readonly at: string;
  readonly checked_at: string | null;
  readonly until: string | null;
  readonly superseded_by: string | null;
  readonly retired_at: string | null;
  readonly pinned: number;
  readonly use_count: number;
  readonly last_used_at: string | null;
}

const STATUSES = new Set<string>(["fresh", "stale", "contradicted"]);

const toNote = (row: Row): MemoryNote => ({
  id: row.id,
  text: row.text,
  status: STATUSES.has(row.status) ? (row.status as MemoryNote["status"]) : "stale",
  ...(row.reason === null ? {} : { reason: row.reason }),
  source: {
    by: row.source_by,
    ...(row.thread_id === null ? {} : { threadId: ThreadId.make(row.thread_id) }),
    ...(row.message_id === null ? {} : { messageId: MessageId.make(row.message_id) }),
    ...(row.quote === null ? {} : { quote: row.quote }),
    at: row.at,
  },
  ...(row.checked_at === null ? {} : { checkedAt: row.checked_at }),
  ...(row.pinned === PIN.user
    ? { pinned: "user" }
    : row.pinned === PIN.auto
      ? { pinned: "auto" }
      : {}),
  ...(row.until === null ? {} : { until: row.until }),
  ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
  ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
  ...(row.use_count > 0 ? { useCount: row.use_count } : {}),
  ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
});

/** A note as `edit` hands it out and compares it: use counts change on every turn, so they stay out. */
const content = (note: MemoryNote): MemoryNote => {
  const { useCount: _useCount, lastUsedAt: _lastUsedAt, ...rest } = note;
  return rest;
};

/** A note's content as one string, to tell whether `edit` changed it. */
const fingerprint = Schema.encodeSync(Schema.fromJsonString(MemoryNote));

const toVector = (blob: Uint8Array) => new Float32Array(Uint8Array.from(blob).buffer);

/**
 * Builds the store on `sql`, creating its tables when missing. With a `MemoryEmbedder` it keeps a
 * vector per live note and `search` can fuse dense ranking with the lexical one.
 */
export const makeMemoryStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const embedder = Option.getOrUndefined(yield* Effect.serviceOption(MemoryEmbedder));
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const syncLock = yield* Semaphore.make(1);
  const failed =
    (operation: "read" | "write") =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new LearnMemoryError({ operation, cause })));

  // Tables of their own, created here and not by a numbered migration: migration numbers belong
  // to upstream T3 Code, and a fork's number would collide with its next one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS learn_memory_notes (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      source_by TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      quote TEXT,
      at TEXT NOT NULL,
      checked_at TEXT,
      until TEXT,
      superseded_by TEXT,
      retired_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      search_text TEXT NOT NULL
    )
  `.pipe(failed("write"));
  // What the learner forgot, so the nightly check does not add it again: no text, only its hash.
  yield* sql`
    CREATE TABLE IF NOT EXISTS learn_memory_forgotten (
      hash TEXT NOT NULL,
      message_id TEXT,
      at TEXT NOT NULL
    )
  `.pipe(failed("write"));
  // `seq` is the rowid, so VACUUM keeps the index's rowids valid. Builds without FTS5 trigram
  // support search by scanning.
  const fts = yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS learn_memory_notes_fts USING fts5(
      search_text, content = 'learn_memory_notes', content_rowid = 'seq', tokenize = 'trigram'
    )
  `.pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) =>
        Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
      (cause) =>
        Effect.logWarning("Memory search index unavailable; search will scan notes.", cause).pipe(
          Effect.as(false),
        ),
    ),
    failed("write"),
  );
  if (fts) {
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS learn_memory_notes_fts_insert AFTER INSERT ON learn_memory_notes
      BEGIN
        INSERT INTO learn_memory_notes_fts (rowid, search_text) VALUES (new.seq, new.search_text);
      END
    `.pipe(failed("write"));
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS learn_memory_notes_fts_delete AFTER DELETE ON learn_memory_notes
      BEGIN
        INSERT INTO learn_memory_notes_fts (learn_memory_notes_fts, rowid, search_text)
        VALUES ('delete', old.seq, old.search_text);
      END
    `.pipe(failed("write"));
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS learn_memory_notes_fts_update
      AFTER UPDATE OF search_text ON learn_memory_notes
      BEGIN
        INSERT INTO learn_memory_notes_fts (learn_memory_notes_fts, rowid, search_text)
        VALUES ('delete', old.seq, old.search_text);
        INSERT INTO learn_memory_notes_fts (rowid, search_text) VALUES (new.seq, new.search_text);
      END
    `.pipe(failed("write"));
  }

  // A live note's vector, made by `model`. Edits that change a note's text or delete it drop the
  // vector; a retired note keeps its own unless the learner forgot it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS learn_memory_vectors (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      vector BLOB NOT NULL
    )
  `.pipe(failed("write"));
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS learn_memory_vectors_note_delete AFTER DELETE ON learn_memory_notes
    BEGIN
      DELETE FROM learn_memory_vectors WHERE id = old.id;
    END
  `.pipe(failed("write"));
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS learn_memory_vectors_note_text
    AFTER UPDATE OF text ON learn_memory_notes
    WHEN old.text IS NOT new.text
    BEGIN
      DELETE FROM learn_memory_vectors WHERE id = old.id;
    END
  `.pipe(failed("write"));

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const liveVectors = sql<{ readonly notes: number; readonly vectors: number }>`
    SELECT COUNT(*) AS notes, COUNT(v.id) AS vectors FROM learn_memory_notes n
    LEFT JOIN learn_memory_vectors v ON v.id = n.id
    WHERE n.retired_at IS NULL
  `.pipe(
    failed("read"),
    Effect.map((found) => ({ notes: found[0]?.notes ?? 0, vectors: found[0]?.vectors ?? 0 })),
  );

  // Set while notes wait for the embedder; the next query it answers resumes the sync.
  let behind = false;
  const syncVectors = Effect.fn("LearnMemoryStore.syncVectors")(function* () {
    if (!embedder) return undefined;
    return yield* syncLock.withPermit(
      Effect.gen(function* () {
        while (true) {
          const missing = yield* sql<{ readonly id: string; readonly text: string }>`
            SELECT n.id, n.text FROM learn_memory_notes n
            WHERE n.retired_at IS NULL AND NOT EXISTS (
              SELECT 1 FROM learn_memory_vectors v WHERE v.id = n.id
            )
            ORDER BY n.seq LIMIT ${EMBED_BATCH}
          `.pipe(failed("read"));
          if (missing.length === 0) {
            behind = false;
            break;
          }
          const embedded = yield* embedder.embed(
            missing.map((note) => note.text),
            "passage",
          );
          if (!embedded) {
            behind = true;
            break;
          }
          const stored = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                // Vectors of another model do not compare with this one's queries: after a model
                // change, the first note embedded clears them and this loop embeds every note again.
                yield* sql`DELETE FROM learn_memory_vectors WHERE model <> ${embedded.model}`;
                let stored = 0;
                for (const [index, note] of missing.entries()) {
                  const vector = embedded.vectors[index]!;
                  // Only while the note still reads as embedded; an edit meanwhile waits for the next pass.
                  const written = yield* sql<{ readonly id: string }>`
                    INSERT OR REPLACE INTO learn_memory_vectors (id, model, vector)
                    SELECT id, ${embedded.model},
                      ${new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)}
                    FROM learn_memory_notes
                    WHERE id = ${note.id} AND text = ${note.text} AND retired_at IS NULL
                    RETURNING id
                  `;
                  stored += written.length;
                }
                return stored;
              }),
            )
            .pipe(failed("write"));
          if (stored === 0) break;
        }
        return yield* liveVectors;
      }),
    );
  });

  /** Brings vectors up to date in the background after a write; failures only log. */
  const syncLater = embedder
    ? syncVectors().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Learn memory vectors failed to sync", { cause }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    : Effect.void;

  const rows = (retired = false) =>
    (retired
      ? sql<Row>`SELECT * FROM learn_memory_notes WHERE retired_at IS NOT NULL ORDER BY seq`
      : sql<Row>`SELECT * FROM learn_memory_notes WHERE retired_at IS NULL ORDER BY seq`
    ).pipe(failed("read"));

  const notes = rows().pipe(Effect.map((found) => found.map((row) => content(toNote(row)))));

  /** Writes a note's content, restoring a retired note with the same id. */
  const upsert = (note: MemoryNote) =>
    sql`
      INSERT INTO learn_memory_notes (
        id, text, status, reason, source_by, thread_id, message_id, quote, at,
        checked_at, until, pinned, search_text
      ) VALUES (
        ${note.id}, ${note.text}, ${note.status}, ${note.reason ?? null},
        ${note.source.by}, ${note.source.threadId ?? null}, ${note.source.messageId ?? null},
        ${note.source.quote ?? null}, ${note.source.at}, ${note.checkedAt ?? null},
        ${note.until ?? null}, ${note.pinned ? PIN[note.pinned] : PIN.none}, ${searchText(note.text)}
      )
      ON CONFLICT (id) DO UPDATE SET
        text = excluded.text, status = excluded.status, reason = excluded.reason,
        source_by = excluded.source_by, thread_id = excluded.thread_id,
        message_id = excluded.message_id, quote = excluded.quote, at = excluded.at,
        checked_at = excluded.checked_at, until = excluded.until, pinned = excluded.pinned,
        search_text = excluded.search_text, retired_at = NULL, superseded_by = NULL
    `;

  const edit = Effect.fn("LearnMemoryStore.edit")(function* (
    change: (notes: LearnMemory) => LearnMemory,
    options?: {
      readonly remove?: "retire" | "delete" | undefined;
      readonly supersededBy?: (() => string | undefined) | undefined;
      readonly forget?: (() => boolean) | undefined;
    },
  ) {
    return yield* lock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* notes;
            const after = change(before);
            if (after === before) return before;
            if (after.length > LEARN_MEMORY_NOTES_MAX)
              return yield* new LearnMemoryError({ operation: "cap" });
            const at = yield* now;
            const supersededBy = options?.supersededBy?.() ?? null;
            const forget = options?.forget?.() ?? false;
            const previous = new Map(before.map((note) => [note.id, fingerprint(note)]));
            const kept = new Set(after.map((note) => note.id));
            for (const note of after) {
              const next = content(note);
              if (previous.get(note.id) !== fingerprint(next)) yield* upsert(next);
            }
            for (const note of before) {
              if (kept.has(note.id)) continue;
              if (options?.remove === "delete" || forget)
                yield* sql`
                  INSERT INTO learn_memory_forgotten (hash, message_id, at)
                  VALUES (${forgetKey(note.text)}, ${note.source.messageId ?? null}, ${at})
                `;
              if (options?.remove === "delete")
                yield* sql`DELETE FROM learn_memory_notes WHERE id = ${note.id}`;
              else
                yield* sql`
                  UPDATE learn_memory_notes
                  SET retired_at = ${at}, superseded_by = ${supersededBy}, pinned = 0
                  WHERE id = ${note.id}
                `;
              if (forget) yield* sql`DELETE FROM learn_memory_vectors WHERE id = ${note.id}`;
            }
            return after.map(content);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isMemoryError(cause) ? cause : new LearnMemoryError({ operation: "write", cause }),
          ),
          Effect.tap(() => syncLater),
        ),
    );
  });

  const setNote = Effect.fn("LearnMemoryStore.setNote")(function* (
    id: string,
    change: { readonly pinned?: boolean | undefined; readonly retired?: boolean | undefined },
  ) {
    const found = yield* sql<Row>`SELECT * FROM learn_memory_notes WHERE id = ${id}`.pipe(
      failed("read"),
    );
    const row = found[0];
    if (!row) return yield* new LearnMemoryError({ operation: "missing" });
    if (change.retired === false && row.retired_at !== null) {
      const live = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM learn_memory_notes WHERE retired_at IS NULL
      `.pipe(failed("read"));
      if ((live[0]?.count ?? 0) >= LEARN_MEMORY_NOTES_MAX)
        return yield* new LearnMemoryError({ operation: "cap" });
    }
    const at = yield* now;
    const retiredAt =
      change.retired === undefined
        ? row.retired_at
        : change.retired
          ? (row.retired_at ?? at)
          : null;
    // A pin the learner sets or clears is theirs; the nightly check leaves it alone.
    const pinned =
      retiredAt !== null
        ? PIN.none
        : change.pinned === undefined
          ? row.pinned
          : change.pinned
            ? PIN.user
            : PIN.none;
    yield* sql`
      UPDATE learn_memory_notes
      SET pinned = ${pinned}, retired_at = ${retiredAt},
        superseded_by = ${retiredAt === null ? null : row.superseded_by}
      WHERE id = ${id}
    `.pipe(failed("write"));
    if (retiredAt === null && row.retired_at !== null) yield* syncLater;
  });

  const search = Effect.fn("LearnMemoryStore.search")(function* (
    query: string,
    options: SearchOptions,
  ) {
    const retired = options.retired === true;
    const match = fts ? ftsQuery(query) : undefined;
    let found: ReadonlyArray<Row> =
      match === undefined
        ? []
        : yield* (
            retired
              ? sql<Row>`
                SELECT n.* FROM learn_memory_notes_fts f JOIN learn_memory_notes n ON n.seq = f.rowid
                WHERE learn_memory_notes_fts MATCH ${match} AND n.retired_at IS NOT NULL
                ORDER BY bm25(learn_memory_notes_fts) LIMIT ${CANDIDATES}`
              : sql<Row>`
                SELECT n.* FROM learn_memory_notes_fts f JOIN learn_memory_notes n ON n.seq = f.rowid
                WHERE learn_memory_notes_fts MATCH ${match} AND n.retired_at IS NULL
                ORDER BY bm25(learn_memory_notes_fts) LIMIT ${CANDIDATES}`
          ).pipe(failed("read"));
    if (found.length < SCAN_BELOW && (options.scan ?? true)) found = yield* rows(retired);
    const since = options.since;
    const lexical = rankNotes(
      found
        .filter((row) => since === undefined || row.at.slice(0, 10) >= since)
        .map((row) => ({ note: toNote(row) })),
      query,
      options,
    );
    const denseMin = options.dense;
    if (denseMin === undefined || !embedder || query.trim() === "") return lexical;
    const embedded = yield* embedder.embed([query.trim().slice(0, QUERY_CHARS)], "query");
    const target = embedded?.vectors[0];
    if (!embedded || !target) return lexical;
    if (behind) {
      behind = false;
      yield* syncLater;
    }
    const near = yield* (
      retired
        ? sql<Row & { readonly vector: Uint8Array }>`
          SELECT n.*, v.vector FROM learn_memory_vectors v JOIN learn_memory_notes n ON n.id = v.id
          WHERE v.model = ${embedded.model} AND n.retired_at IS NOT NULL`
        : sql<Row & { readonly vector: Uint8Array }>`
          SELECT n.*, v.vector FROM learn_memory_vectors v JOIN learn_memory_notes n ON n.id = v.id
          WHERE v.model = ${embedded.model} AND n.retired_at IS NULL`
    ).pipe(failed("read"));
    const dense = near
      .filter((row) => since === undefined || row.at.slice(0, 10) >= since)
      .map((row) => ({
        entry: { note: toNote(row) },
        similarity: cosine(target, toVector(row.vector)),
      }))
      .filter((found) => found.similarity >= denseMin)
      .toSorted((a, b) => b.similarity - a.similarity)
      .slice(0, options.limit);
    return fuseRanked(lexical, dense, options.limit);
  });

  const count = (retired: boolean) =>
    (retired
      ? sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM learn_memory_notes WHERE retired_at IS NOT NULL`
      : sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM learn_memory_notes WHERE retired_at IS NULL`
    ).pipe(
      failed("read"),
      Effect.map((found) => found[0]?.count ?? 0),
    );

  const page = Effect.fn("LearnMemoryStore.page")(function* (request: {
    readonly query?: string | undefined;
    readonly retired?: boolean | undefined;
    readonly offset: number;
    readonly limit: number;
  }) {
    const retired = request.retired === true;
    const query = request.query?.trim();
    if (query) {
      const ranked = yield* search(query, {
        limit: LEARN_MEMORY_NOTES_MAX,
        min: MIN_MATCH,
        now: yield* Clock.currentTimeMillis,
        retired,
      });
      return {
        notes: ranked
          .slice(request.offset, request.offset + request.limit)
          .map(({ entry }) => entry.note),
        total: ranked.length,
      };
    }
    const found = yield* (
      retired
        ? sql<Row>`
          SELECT * FROM learn_memory_notes WHERE retired_at IS NOT NULL
          ORDER BY retired_at DESC, seq DESC LIMIT ${request.limit} OFFSET ${request.offset}`
        : sql<Row>`
          SELECT * FROM learn_memory_notes WHERE retired_at IS NULL
          ORDER BY pinned DESC, at DESC, seq DESC LIMIT ${request.limit} OFFSET ${request.offset}`
    ).pipe(failed("read"));
    return { notes: found.map(toNote), total: yield* count(retired) };
  });

  // Vectors for notes saved before the embedder answered, or while it was down.
  if (embedder)
    yield* syncVectors().pipe(
      Effect.tap((synced) => Effect.logInfo("Learn memory vectors synced", synced)),
      Effect.catch((cause) => Effect.logWarning("Learn memory vectors failed to sync", { cause })),
      Effect.forkIn(scope),
    );

  return LearnMemoryStore.of({
    notes,
    edit,
    setNote,
    page,
    core: Effect.fn("LearnMemoryStore.core")(function* (today) {
      const found = (yield* rows()).map(toNote);
      return { shown: coreNotes(found, today), total: found.length };
    }),
    search,
    touch: Effect.fn("LearnMemoryStore.touch")(function* (ids, at) {
      if (ids.length === 0) return;
      yield* sql`
        UPDATE learn_memory_notes SET use_count = use_count + 1, last_used_at = ${at}
        WHERE id IN ${sql.in(ids)}`.pipe(failed("write"));
    }),
    forgotten: sql<{ readonly hash: string; readonly message_id: string | null }>`
      SELECT hash, message_id FROM learn_memory_forgotten
    `.pipe(
      failed("read"),
      Effect.map((found) => ({
        hashes: new Set(found.map((row) => row.hash)),
        messages: new Set(found.flatMap((row) => (row.message_id ? [row.message_id] : []))),
      })),
    ),
    snapshot: sql<Row>`SELECT * FROM learn_memory_notes ORDER BY seq`.pipe(
      failed("read"),
      Effect.map((found) => found.map(toNote)),
    ),
    purgeRetired: Effect.fn("LearnMemoryStore.purgeRetired")(function* (before) {
      const purged = yield* sql<{ readonly id: string }>`
        DELETE FROM learn_memory_notes WHERE retired_at IS NOT NULL AND retired_at < ${before}
        RETURNING id
      `.pipe(failed("write"));
      return purged.length;
    }),
    syncVectors: syncVectors(),
  });
});

/** The store on the server database, with vectors when an embedder is configured. */
export const layer = Layer.effect(LearnMemoryStore, makeMemoryStore).pipe(
  Layer.provide(MemoryEmbedderLayer),
);
