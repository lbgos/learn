import * as Schema from "effect/Schema";
import { MessageId, ThreadId } from "./baseSchemas.ts";

/**
 * Notes about the learner (goals, background, preferences, recurring difficulties), as opposed to
 * the knowledge graph, which records the subject and what was taught and retrieved. The tutor
 * writes them with `update_memory`, the nightly check consolidates them, and the learner sees and
 * edits them in Settings → Learning.
 */
export const MEMORY_NOTE_MAX_LENGTH = 300;
export const MemoryNoteText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MEMORY_NOTE_MAX_LENGTH),
);
/**
 * Fresh until the nightly check finds a note outdated (stale) or at odds with something newer the
 * learner said (contradicted). Only fresh notes reach tutor turns; search shows the others marked.
 */
export const MemoryNoteStatus = Schema.Literals(["fresh", "stale", "contradicted"]);
export type MemoryNoteStatus = typeof MemoryNoteStatus.Type;
/** Where a note came from: who wrote it, in which session, resting on which of the learner's words. */
export const MemoryNoteSource = Schema.Struct({
  /** "user" for the learner's own edits, "tutor", or the nightly check. */
  by: Schema.String,
  /** The session thread it was written in. */
  threadId: Schema.optional(ThreadId),
  /** The learner's message it rests on, and the words quoted from it. */
  messageId: Schema.optional(MessageId),
  quote: Schema.optional(Schema.String),
  at: Schema.String,
});
export type MemoryNoteSource = typeof MemoryNoteSource.Type;
export const MemoryNote = Schema.Struct({
  id: Schema.String,
  text: MemoryNoteText,
  status: MemoryNoteStatus,
  /** Why the nightly check marked the note stale or contradicted. */
  reason: Schema.optional(Schema.String),
  source: MemoryNoteSource,
  /** When the nightly check last looked at the note. */
  checkedAt: Schema.optional(Schema.String),
  /**
   * Kept in every tutor turn while it fits. "user": the learner pinned it, and only they unpin it.
   * "auto": pinned by the nightly check, which may unpin it.
   */
  pinned: Schema.optional(Schema.Literals(["user", "auto"])),
  /** The date (YYYY-MM-DD) after which the note no longer holds; the nightly check marks it stale. */
  until: Schema.optional(Schema.String),
  /**
   * When the tutor removed the note or the nightly check replaced it. Retired notes leave turns
   * and search and are purged after 90 days; the learner can restore one until then.
   */
  retiredAt: Schema.optional(Schema.String),
  /** The note that replaced this one. */
  supersededBy: Schema.optional(Schema.String),
  /** How often the note reached a turn, which orders the unpinned notes every turn carries. */
  useCount: Schema.optional(Schema.Number),
  lastUsedAt: Schema.optional(Schema.String),
});
export type MemoryNote = typeof MemoryNote.Type;
/** Live notes kept; retired notes do not count. */
export const LEARN_MEMORY_NOTES_MAX = 1000;
export const LearnMemory = Schema.Array(MemoryNote).check(
  Schema.isMaxLength(LEARN_MEMORY_NOTES_MAX),
);
export type LearnMemory = typeof LearnMemory.Type;

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();
/** A short stable id from the note's first text and time (FNV-1a), so ids need no randomness. */
export function noteId(text: string, at: string): string {
  let hash = 0x811c9dc5;
  for (const character of `${at}\n${text}`) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `n${hash.toString(36).padStart(7, "0")}`;
}

/**
 * The learner's edit of one note, which makes it theirs: `id` null adds one, empty text or a copy
 * of another note forgets it, and unchanged text on a stale or contradicted note marks it fresh.
 * A pin and an end date still ahead stay. Returns the same list when nothing changes.
 */
export function editNote(
  notes: LearnMemory,
  id: string | null,
  text: string,
  at: string,
  max: number = LEARN_MEMORY_NOTES_MAX,
): LearnMemory {
  const line = oneLine(text).slice(0, MEMORY_NOTE_MAX_LENGTH);
  const duplicate = (except?: string) =>
    notes.some((note) => note.id !== except && note.text.toLowerCase() === line.toLowerCase());
  if (id === null) {
    if (!line || duplicate() || notes.length >= max) return notes;
    return [
      ...notes,
      { id: noteId(line, at), text: line, status: "fresh", source: { by: "user", at } },
    ];
  }
  const current = notes.find((note) => note.id === id);
  if (!current || (line === current.text && current.status === "fresh")) return notes;
  if (!line || duplicate(id)) return notes.filter((note) => note.id !== id);
  // An end date that has passed would mark the note stale again the next night.
  const { reason: _reason, until: _until, ...rest } = current;
  const until = current.until && current.until >= at.slice(0, 10) ? { until: current.until } : {};
  const next: MemoryNote =
    line === current.text
      ? { ...rest, ...until, status: "fresh", checkedAt: at }
      : {
          id,
          text: line,
          status: "fresh",
          source: { by: "user", at },
          ...(current.pinned ? { pinned: current.pinned } : {}),
          ...until,
        };
  return notes.map((note) => (note.id === id ? next : note));
}

export const MEMORY_PAGE_MAX = 100;
export const MemoryNotesPage = Schema.Struct({
  notes: Schema.Array(MemoryNote),
  /** Notes matching the request across all pages. */
  total: Schema.Int,
});
export type MemoryNotesPage = typeof MemoryNotesPage.Type;

/** One change the nightly check made, kept so the learner can undo it. */
export const MemoryChange = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  op: Schema.Literals([
    "confirm",
    "rewrite",
    "merge",
    "stale",
    "contradicted",
    "delete",
    "expire",
    "add",
    "pin",
    "unpin",
  ]),
  reason: Schema.optional(Schema.String),
  before: Schema.Array(MemoryNote),
  after: Schema.Array(MemoryNote),
  undone: Schema.optional(Schema.Boolean),
});
export type MemoryChange = typeof MemoryChange.Type;

/** The nightly memory check: whether it runs, its last run and the changes it made. It runs on the review route. */
export const LearnMemoryDreams = Schema.Struct({
  enabled: Schema.Boolean,
  running: Schema.Boolean,
  nextRunAt: Schema.NullOr(Schema.String),
  lastRun: Schema.NullOr(
    Schema.Struct({
      at: Schema.String,
      /** One line, such as "2 merged, 1 marked stale". */
      summary: Schema.String,
      errors: Schema.Array(Schema.String),
    }),
  ),
  /** Newest first. */
  changes: Schema.Array(MemoryChange),
});
export type LearnMemoryDreams = typeof LearnMemoryDreams.Type;
