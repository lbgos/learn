import {
  type LearnMemory,
  MEMORY_NOTE_MAX_LENGTH,
  type MemoryNote,
  type MemoryNoteSource,
  MessageId,
  noteId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

/**
 * Prompt room for the notes every tutor turn carries: pinned notes first within `PINNED_CHARS`,
 * then the most used and newest within `CORE_CHARS` in all.
 */
const CORE_CHARS = 1200;
export const PINNED_CHARS = 1200;
/** What a turn may add for its message: at most this many notes in this many characters. */
const RECALL_NOTES = 6;
const RECALL_CHARS = 800;

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();

export const isUserNote = (note: MemoryNote) => note.source.by === "user";

const QUOTE_MARKS = /[‘’‚‛′`]/g;
const DOUBLE_QUOTE_MARKS = /[“”„‟«»″]/g;
const EDGES = /^[\s"'.,;:!?…()[\]-]+|[\s"'.,;:!?…()[\]-]+$/g;

/** Case, quote marks and spacing folded the same way for a quote and the message it cites. */
const foldQuote = (text: string) =>
  text
    .normalize("NFKC")
    .replace(QUOTE_MARKS, "'")
    .replace(DOUBLE_QUOTE_MARKS, '"')
    .toLowerCase()
    .replaceAll(/\s+/g, " ")
    .trim();

/**
 * Whether `quote` is the user's own words from `text`: each part between ellipses appears in
 * it, in order, ignoring case, quote marks and spacing.
 */
export function quotes(text: string, quote: string): boolean {
  const parts = foldQuote(quote)
    .split(/…|\.\.\./)
    .map((part) => part.replace(EDGES, ""))
    .filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  const folded = foldQuote(text);
  let from = 0;
  for (const part of parts) {
    const at = folded.indexOf(part, from);
    if (at === -1) return false;
    from = at + part.length;
  }
  return true;
}

/** The newest of the user's messages that holds `quote`. */
function quotedMessage<M extends { readonly text: string; readonly at: string }>(
  messages: ReadonlyArray<M>,
  quote: string,
): M | undefined {
  return messages
    .filter((message) => quotes(message.text, quote))
    .toSorted((a, b) => b.at.localeCompare(a.at))[0];
}

/** Who wrote a note the tutor saves with `update_memory`. */
const TUTOR_AUTHOR = "tutor";

/**
 * The source the tutor's `update_memory` call gives the notes it adds, or why it is refused. A
 * `quote` must be the learner's own words from one of their messages in this session, so a page,
 * transcript or file the tutor read cannot pass for what the learner said.
 */
export function memorySource(input: {
  readonly threadId: ThreadId;
  readonly quote: string | undefined;
  readonly at: string;
  /** The learner's own messages in the session. */
  readonly userMessages: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly at: string;
  }>;
}): Result.Result<MemoryNoteSource, string> {
  const source = { by: TUTOR_AUTHOR, threadId: input.threadId, at: input.at };
  const quote = input.quote?.trim();
  if (!quote) return Result.succeed(source);
  const message = quotedMessage(input.userMessages, quote);
  if (!message)
    return Result.fail(
      `"${quote.slice(0, 80)}" is not in the learner's messages in this session. Copy their words exactly.`,
    );
  return Result.succeed({
    ...source,
    messageId: MessageId.make(message.id),
    quote: quote.slice(0, MEMORY_NOTE_MAX_LENGTH),
  });
}

export interface MemoryEdit {
  readonly notes: LearnMemory;
  readonly added: ReadonlyArray<MemoryNote>;
  readonly removed: ReadonlyArray<MemoryNote>;
}

const CARD = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;
const KEY = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/;
// `\b` only sees ASCII letters, so the label's edges are written out for Cyrillic.
const LABELLED =
  /(?<![\p{L}\p{N}_])(?:password|passcode|pin|cvv|cvc|api[ _-]?key|token|secret|пароль|пин-?код|пін-?код|токен)(?![\p{L}\p{N}_])(?:\s+[\p{L}\p{N}]+){0,3}\s*[:=]\s*\S/iu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
};

/** Text that looks like a card number, key, password or private key, which notes never keep. */
export const looksSecret = (text: string) =>
  PRIVATE_KEY.test(text) ||
  LABELLED.test(text) ||
  KEY.test(text) ||
  [...text.matchAll(CARD)].some((match) => luhn(match[0].replaceAll(/\D/g, "")));

/**
 * Applies the tutor's `update_memory` call: each `remove` (a note id, or a fragment of one note)
 * takes that note out, then `add` appends new notes from `source`, ending on `until` when given.
 * Failures are written for the tutor to act on.
 */
export function changeMemory(
  notes: LearnMemory,
  change: {
    readonly add?: ReadonlyArray<string> | undefined;
    readonly remove?: ReadonlyArray<string> | undefined;
    readonly until?: string | undefined;
  },
  source: MemoryNoteSource,
  max: number,
): Result.Result<MemoryEdit, string> {
  let next = [...notes];
  const removed: MemoryNote[] = [];
  for (const fragment of change.remove ?? []) {
    const needle = fragment.trim().toLowerCase();
    const byId = next.find((note) => note.id === fragment.trim());
    const matches = byId ? [byId] : next.filter((note) => note.text.toLowerCase().includes(needle));
    if (!needle || matches.length === 0) return Result.fail(`No note contains "${fragment}".`);
    if (matches.length > 1)
      return Result.fail(`"${fragment}" matches ${matches.length} notes; quote more of one.`);
    removed.push(matches[0]!);
    next = next.filter((note) => note !== matches[0]);
  }
  const until = change.until?.trim().slice(0, 10);
  if (until !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(until))
    return Result.fail("`until` is a date: YYYY-MM-DD.");
  const added: MemoryNote[] = [];
  for (const entry of change.add ?? []) {
    const text = oneLine(entry);
    if (!text || next.some((note) => note.text.toLowerCase() === text.toLowerCase())) continue;
    if (text.length > MEMORY_NOTE_MAX_LENGTH)
      return Result.fail(
        `A note holds at most ${MEMORY_NOTE_MAX_LENGTH} characters. Shorten or split it.`,
      );
    if (looksSecret(text)) return Result.fail("Notes never keep passwords, keys or card numbers.");
    const note: MemoryNote = {
      id: noteId(text, source.at),
      text,
      status: "fresh",
      source,
      ...(until ? { until } : {}),
    };
    added.push(note);
    next.push(note);
  }
  return next.length <= max
    ? Result.succeed({ notes: next, added, removed })
    : Result.fail(`Memory holds at most ${max} notes. Merge or remove some.`);
}

/** Whether a note may reach a turn: fresh, not retired, and not past its end date. */
const isLive = (note: MemoryNote, today: string) =>
  note.status === "fresh" &&
  note.retiredAt === undefined &&
  (note.until === undefined || note.until >= today.slice(0, 10));

/**
 * The notes every tutor turn carries: pinned notes in stored order within `PINNED_CHARS`, then
 * the others, most used and then newest first, within `CORE_CHARS`. A note that does not fit is
 * skipped, so one long note does not hide the shorter ones after it.
 */
export function coreNotes(notes: ReadonlyArray<MemoryNote>, today: string): MemoryNote[] {
  const live = notes.filter((note) => isLive(note, today));
  const unpinned = live
    .filter((note) => !note.pinned)
    .toSorted(
      (a, b) => (b.useCount ?? 0) - (a.useCount ?? 0) || b.source.at.localeCompare(a.source.at),
    );
  const shown: MemoryNote[] = [];
  let used = 0;
  const take = (note: MemoryNote, budget: number) => {
    const length = note.text.length + 2;
    if (used + length > budget) return;
    shown.push(note);
    used += length + 1;
  };
  for (const note of live) if (note.pinned) take(note, PINNED_CHARS);
  for (const note of unpinned) take(note, CORE_CHARS);
  return shown;
}

/** The core notes as a turn shows them, then how many more memory_search reaches. */
export function memoryIndex(shown: ReadonlyArray<MemoryNote>, total: number): string {
  if (total === 0) return "empty";
  const lines = shown.map((note) => `- ${note.text}`);
  const more = total - shown.length;
  return more > 0
    ? [...lines, `(${more} more ${more === 1 ? "note" : "notes"}: memory_search finds them)`].join(
        "\n",
      )
    : lines.join("\n");
}

const searchWords = (text: string) =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Words that carry no topic, in RU, UK and EN, folded like `searchWords` folds them. */
const FILLER = new Set(
  searchWords(
    [
      "что как где когда какой какая какие какое каких какую кто чем чего почему зачем сколько",
      "мне меня мой моя мое мои моего моей моих моему тебе тебя твой твоя ты вы вас вам ваш",
      "она он они оно его ее их это эти этот эта тот там тут здесь есть был была были было",
      "будет буду быть нет или для при про над под без после перед через между уже еще тоже",
      "также только очень можно нужно надо пожалуйста давай сделай скажи напомни найди подбери",
      "проверь запиши сейчас сегодня завтра вчера всегда опять снова так если чтобы потому",
      "що як де коли який яка які яке хто чому скільки мені мене мій моя моє мої тобі тебе",
      "твій він вона вони воно його її їх це ці цей ця той є був була були було буде немає або",
      "під після між вже ще теж також тільки дуже можна треба будь ласка зроби нагадай знайди",
      "перевір зараз сьогодні вчора завжди знову якщо щоб",
      "what when where which who whom why how much many the and for with from about into",
      "my mine me you your our his her their this that these those there here is are was were",
      "be been have has had do does did can could should would will please tell find make check",
      "give any some now today tomorrow again also just not but or if then than",
    ].join(" "),
  ),
);

/** Search and ranking run on the event loop: a pasted wall of text only counts by its start. */
export const QUERY_CHARS = 400;
const QUERY_TERMS = 40;

/**
 * The words of a query that name its topic: words of 3 or more letters that are not `FILLER`,
 * or every word when none is left.
 */
const queryWords = (text: string) => {
  const words = searchWords(text.slice(0, QUERY_CHARS));
  const topical = words.filter((word) => word.length >= 3 && !FILLER.has(word));
  return [...new Set(topical.length > 0 ? topical : words)].slice(0, QUERY_TERMS);
};

/**
 * A note's words as the index stores them: accents dropped (so ё is е and й is и, in notes and
 * queries alike), lower case, one space apart.
 */
export const searchText = (text: string) => searchWords(text).join(" ");

/** What the learner forgot: `forgetKey` hashes and the messages the notes rested on. */
export interface Forgotten {
  readonly hashes: ReadonlySet<string>;
  readonly messages: ReadonlySet<string>;
}

/**
 * What a forgotten note leaves behind: a hash of its words (FNV-1a), so the nightly check can
 * refuse to add it again without keeping its text.
 */
export function forgetKey(text: string): string {
  let hash = 0x811c9dc5;
  for (const character of searchText(text)) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The full-text query that finds candidates for `query`: each word of 3 or more letters, or its
 * stem when longer, so RU and UK endings still match. Undefined when no word is long enough.
 */
export function ftsQuery(query: string): string | undefined {
  const stems = [
    ...new Set(
      queryWords(query)
        .filter((word) => word.length >= 3)
        .map((word) => (word.length >= 6 ? word.slice(0, word.length - 2) : word)),
    ),
  ];
  return stems.length === 0 ? undefined : stems.map((stem) => `"${stem}"`).join(" OR ");
}

const letterPairs = (word: string) => {
  const pairs = new Map<string, number>();
  for (let i = 0; i < word.length - 1; i++) {
    const pair = word.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  return pairs;
};

interface SearchWord {
  readonly word: string;
  readonly pairs: Map<string, number>;
}
const searchWord = (word: string): SearchWord => ({ word, pairs: letterPairs(word) });

/** Dice overlap of two words' letter pairs: 1 for the same word, high for a typo or another ending. */
function likeness(a: SearchWord, b: SearchWord): number {
  if (a.word === b.word) return 1;
  if (a.word.length < 2 || b.word.length < 2) return 0;
  let shared = 0;
  for (const [pair, count] of a.pairs) shared += Math.min(count, b.pairs.get(pair) ?? 0);
  return (2 * shared) / (a.word.length + b.word.length - 2);
}

/** Below this mean likeness a note does not match memory_search; it keeps typos and RU/UK endings in. */
export const MIN_MATCH = 0.25;

/** Weights of a note's age and use beside its likeness when ranking. */
const RECENCY_WEIGHT = 0.1;
const USAGE_WEIGHT = 0.05;
const RECENCY_DAYS = 180;
const DAY_MS = 86_400_000;

export interface Ranked<T> {
  readonly entry: T;
  /** Mean likeness of the query's words, 0 to 1. */
  readonly relevance: number;
  readonly score: number;
}

/**
 * The notes that match `query`, best first; fresh notes before the others. Each query word scores
 * its likest word in the note and a note's relevance is the mean; recent and often-used notes get
 * a small lift. On a RU/UK/EN benchmark with typos and paraphrases the likeness alone matched a
 * BM25 + trigram + T3 hybrid within a point.
 */
export function rankNotes<T extends { readonly note: MemoryNote }>(
  entries: ReadonlyArray<T>,
  query: string,
  options: { readonly limit: number; readonly min: number; readonly now: number },
): Array<Ranked<T>> {
  const terms = queryWords(query).map(searchWord);
  if (terms.length === 0) return [];
  return entries
    .flatMap((entry) => {
      const words = searchWords(entry.note.text).map(searchWord);
      const relevance =
        terms.reduce(
          (sum, term) => sum + Math.max(0, ...words.map((word) => likeness(term, word))),
          0,
        ) / terms.length;
      if (relevance < options.min) return [];
      const last = Math.max(
        Date.parse(entry.note.source.at) || 0,
        Date.parse(entry.note.lastUsedAt ?? "") || 0,
      );
      const recency = Math.exp(-Math.max(0, options.now - last) / DAY_MS / RECENCY_DAYS);
      const usage = Math.min(entry.note.useCount ?? 0, 10) / 10;
      return [
        { entry, relevance, score: relevance + RECENCY_WEIGHT * recency + USAGE_WEIGHT * usage },
      ];
    })
    .toSorted(
      (a, b) =>
        Number(b.entry.note.status === "fresh") - Number(a.entry.note.status === "fresh") ||
        b.score - a.score ||
        b.entry.note.source.at.localeCompare(a.entry.note.source.at),
    )
    .slice(0, options.limit);
}

/** `memory_search`'s answer: each note with its status and the date it was saved. */
export function memorySearchResult(ranked: ReadonlyArray<Ranked<{ readonly note: MemoryNote }>>) {
  return {
    notes: ranked.map(({ entry: { note } }) => ({
      id: note.id,
      text: note.text,
      status: note.status,
      ...(note.retiredAt === undefined ? {} : { retired: true }),
      ...(note.until === undefined ? {} : { until: note.until }),
      by: note.source.by,
      at: note.source.at.slice(0, 10),
    })),
  };
}

/** Reciprocal rank fusion's constant, as Cortex fuses its own lexical and dense results. */
const RRF_K = 60;
/**
 * A word match this strong stays ahead of what the vectors add: rank fusion cannot tell it from a
 * weak match the vectors also found. Notes asked about in their own words score 0.77 and up.
 */
const STRONG_MATCH = 0.8;

/** Cosine similarity of two vectors of the same length. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa === 0 || bb === 0 ? 0 : dot / Math.sqrt(aa * bb);
}

/**
 * The word ranking and the notes nearest the query's vector (best first) as one ranking. Each
 * note scores 1/(K + rank) in each list it is in, so a note both find leads; a strong word match
 * adds 1, so it leads in `mergeRanked` too. Fresh notes stay first. A note only the vector found
 * has its similarity as its relevance.
 */
export function fuseRanked<T extends { readonly note: MemoryNote }>(
  lexical: ReadonlyArray<Ranked<T>>,
  dense: ReadonlyArray<{ readonly entry: T; readonly similarity: number }>,
  limit: number,
): Array<Ranked<T>> {
  const fused = new Map<string, { entry: T; relevance: number; score: number }>();
  const add = (entry: T, rank: number, relevance: number, lift = 0) => {
    const key = entry.note.id;
    const found = fused.get(key);
    const score = 1 / (RRF_K + rank + 1);
    if (found) found.score += score;
    else fused.set(key, { entry, relevance, score: score + lift });
  };
  lexical.forEach((found, rank) =>
    add(found.entry, rank, found.relevance, found.relevance >= STRONG_MATCH ? 1 : 0),
  );
  dense.forEach((found, rank) => add(found.entry, rank, found.similarity));
  return [...fused.values()]
    .toSorted(
      (a, b) =>
        Number(b.entry.note.status === "fresh") - Number(a.entry.note.status === "fresh") ||
        b.score - a.score ||
        b.entry.note.source.at.localeCompare(a.entry.note.source.at),
    )
    .slice(0, limit);
}

/** How much of the tutor's last reply a turn's recall reads, so "yes" and "the second one" resolve. */
const REPLY_TAIL_CHARS = 200;

/** A message with at most this many topical words may lean on the tutor's last reply. */
const FOLLOW_UP_WORDS = 2;

/**
 * The queries a turn recalls notes for, each ranked on its own: the learner's message, and for a
 * short follow-up ("the second one", "да, давай") the end of the tutor's last reply. Joining them
 * would dilute a message that names its topic. Empty when the message only acknowledges.
 */
export function recallQueries(message: string, lastReply?: string | undefined): string[] {
  const text = message.trim().slice(0, QUERY_CHARS);
  const topical = searchWords(text).filter((word) => word.length >= 3 && !FILLER.has(word));
  const tail = lastReply?.trim().slice(-REPLY_TAIL_CHARS);
  return [
    ...(searchWords(text).some((word) => word.length >= 3) ? [text] : []),
    ...(tail && topical.length <= FOLLOW_UP_WORDS ? [tail] : []),
  ];
}

/** The rankings of several recall queries as one, best first, each note at its best score. */
export function mergeRanked<T extends { readonly note: MemoryNote }>(
  lists: ReadonlyArray<ReadonlyArray<Ranked<T>>>,
): Array<Ranked<T>> {
  const best = new Map<string, Ranked<T>>();
  for (const found of lists.flat()) {
    const key = found.entry.note.id;
    if ((best.get(key)?.score ?? -1) < found.score) best.set(key, found);
  }
  return [...best.values()].toSorted((a, b) => b.score - a.score);
}

/** The recalled notes a turn shows: best first, skipping `exclude`, within the recall budget. */
export function pickRecalled<T extends { readonly note: MemoryNote }>(
  ranked: ReadonlyArray<Ranked<T>>,
  exclude: ReadonlySet<string>,
): T[] {
  const picked: T[] = [];
  let used = 0;
  for (const { entry } of ranked) {
    if (picked.length >= RECALL_NOTES) break;
    if (exclude.has(entry.note.id)) continue;
    const length = entry.note.text.length + 14;
    if (used + length > RECALL_CHARS) continue;
    picked.push(entry);
    used += length;
  }
  return picked;
}

/** A recalled note as the turn shows it, dated so the model can weigh its age. */
export const recalledLine = (note: MemoryNote) => `[${note.source.at.slice(0, 10)}] ${note.text}`;

/**
 * The relevance a note needs to be recalled into a turn unasked. Higher than memory_search's
 * `MIN_MATCH`: an unrelated note costs tokens and attention, a missed one is a search away.
 */
export const RECALL_MIN = 0.45;

/**
 * The cosine similarity (multilingual-e5-small) a note needs to come in through the query's
 * vector. memory_search fuses the nearest notes by rank alone; unasked recall needs 0.80, as an
 * unrelated note's similarity is often above 0.8 with this model; update_memory's look-alikes need
 * 0.88, where a note and the note it replaces meet. Calibrated on evals/learn-memory.
 */
export const DENSE_MIN = { recall: 0.8, search: 0, similar: 0.88 } as const;
