import { assert, describe, it } from "@effect/vitest";
import { type MemoryNote, noteId, ThreadId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import {
  changeMemory,
  coreNotes,
  fuseRanked,
  memorySearchResult,
  memorySource,
  MIN_MATCH,
  quotes,
  looksSecret,
  RECALL_MIN,
  rankNotes,
  recallQueries,
} from "./memory.ts";

const at = "2026-11-07T10:00:00.000Z";
const source = { by: "tutor", at };
const userNote = (text: string, when = at): MemoryNote => ({
  id: noteId(text, when),
  text,
  status: "fresh",
  source: { by: "user", at: when },
});
const memory = [userNote("Exam on 12 June."), userNote("Prefers SI units over cgs.")];
const texts = (notes: ReadonlyArray<MemoryNote>) => notes.map((note) => note.text);

describe("changeMemory", () => {
  it.each([
    {
      name: "appends one note per entry and skips repeats",
      change: { add: ["Wants  derivations\nfirst.", "prefers si units over cgs."] },
      expected: [...texts(memory), "Wants derivations first."],
    },
    {
      name: "removes the note containing a fragment",
      change: { remove: ["cgs"], add: ["Prefers natural units."] },
      expected: ["Exam on 12 June.", "Prefers natural units."],
    },
    {
      name: "removes a note by id",
      change: { remove: [memory[0]!.id] },
      expected: ["Prefers SI units over cgs."],
    },
    { name: "refuses a fragment that matches nothing", change: { remove: ["zfs"] }, error: "zfs" },
    { name: "refuses an ambiguous fragment", change: { remove: ["e"] }, error: "matches 2" },
    {
      name: "refuses to grow past the limit",
      change: { add: Array.from({ length: 99 }, (_, i) => `note ${i}`) },
      error: "at most 100",
    },
    { name: "refuses an overlong note", change: { add: ["x".repeat(301)] }, error: "300" },
    {
      name: "refuses a card number",
      change: { add: ["Card 4111 1111 1111 1111 for the shop."] },
      error: "card numbers",
    },
    {
      name: "refuses a labelled password",
      change: { add: ["Router password: hunter22"] },
      error: "passwords",
    },
    {
      name: "refuses a key-like token",
      change: { add: ["Use sk-proj-9fA3kLmN0pQrStUvWxYz1234567890abcd for it."] },
      error: "keys",
    },
    { name: "refuses an end date that is not a date", change: { until: "soon" }, error: "until" },
  ])("$name", ({ change, expected, error }) => {
    const result = changeMemory(memory, change, source, 100);
    if (error) assert.include(Result.isFailure(result) ? result.failure : "", error);
    else
      assert.deepEqual(
        Result.isSuccess(result) ? texts(result.success.notes) : undefined,
        expected,
      );
  });

  it("gives new notes the change's source and end date", () => {
    const result = changeMemory(
      [],
      { add: ["Revising mechanics until the exam."], until: "2026-11-14" },
      source,
      100,
    );
    const added = Result.isSuccess(result) ? result.success.added[0] : undefined;
    assert.deepEqual(added?.source, source);
    assert.equal(added?.until, "2026-11-14");
  });
});

describe("quotes", () => {
  it.each([
    ["exact words", "Use metric units please", "metric units", true],
    ["case, quote marks and spacing", "Call me “Lev”,  ok?", 'call me "lev", ok', true],
    [
      "parts around an ellipsis, in order",
      "I like tea. Also: never call after 9pm.",
      "I like tea … after 9pm",
      true,
    ],
    [
      "parts out of order",
      "I like tea. Also: never call after 9pm.",
      "after 9pm … I like tea",
      false,
    ],
    ["words the learner never wrote", "Use metric units please", "imperial units", false],
    ["an empty quote", "Use metric units please", " … ", false],
  ])("%s", (_name, text, quote, expected) => {
    assert.equal(quotes(text, quote), expected);
  });
});

describe("memorySource", () => {
  const threadId = ThreadId.make("session-1");
  const userMessages = [{ id: "m1", text: "My exam is on 12 June, please pace it.", at }];
  it("keeps the learner message a quote comes from, and refuses words they never wrote", () => {
    const quoted = memorySource({ threadId, quote: "exam is on 12 June", at, userMessages });
    assert.equal(Result.isSuccess(quoted) ? quoted.success.messageId : undefined, "m1");
    const invented = memorySource({ threadId, quote: "exam is on 1 May", at, userMessages });
    assert.include(Result.isFailure(invented) ? invented.failure : "", "not in the learner");
    const observed = memorySource({ threadId, quote: undefined, at, userMessages });
    assert.deepEqual(Result.isSuccess(observed) ? observed.success : undefined, {
      by: "tutor",
      threadId,
      at,
    });
  });
});

describe("core notes", () => {
  const today = "2026-11-08T00:00:00.000Z";
  const note = (text: string, extra: Partial<MemoryNote> = {}): MemoryNote => ({
    ...userNote(text, extra.source?.at ?? at),
    ...extra,
  });

  it("puts pinned notes first, then the most used and newest, skipping what does not fit", () => {
    const long = "x".repeat(299);
    const notes = [
      note("Old and unused.", { source: { by: "user", at: "2026-01-01T00:00:00.000Z" } }),
      note("Pinned rule.", { pinned: "user" }),
      note(long, { useCount: 9 }),
      note("Used a lot.", { useCount: 5 }),
      note("Recent.", { source: { by: "user", at: "2026-11-06T00:00:00.000Z" } }),
      note("Ended trip.", { until: "2026-11-01" }),
      note("Gone.", { retiredAt: at }),
    ];
    assert.deepEqual(texts(coreNotes(notes, today)), [
      "Pinned rule.",
      long,
      "Used a lot.",
      "Recent.",
      "Old and unused.",
    ]);
    // Past the budget the long note is skipped and the short ones still fit.
    const crowded = [
      ...Array.from({ length: 3 }, (_, i) => note(`${i}${long.slice(1)}`, { useCount: 9 })),
      ...notes,
    ];
    const shown = texts(coreNotes(crowded, today));
    assert.equal(shown.filter((text) => text.length > 250).length, 3);
    assert.deepEqual(
      shown.filter((text) => text.length < 250),
      ["Pinned rule.", "Used a lot.", "Recent.", "Old and unused."],
    );
  });
});

describe("rankNotes", () => {
  const now = Date.parse("2026-11-08T00:00:00.000Z");
  const entries = [
    { note: { ...userNote("Old exam date: 3 June."), status: "stale" as const } },
    { note: userNote("Exam date moved to 12 June, oral part.") },
    { note: userNote("Prefers short answers.") },
    { note: userNote("Плутає знаки в проекціях сил на похилій площині.") },
  ];
  it.each([
    [
      "ranks fresh matches before stale ones",
      "exam date",
      ["Exam date moved to 12 June, oral part.", "Old exam date: 3 June."],
    ],
    [
      "finds a typo",
      "oarl exam",
      ["Exam date moved to 12 June, oral part.", "Old exam date: 3 June."],
    ],
    [
      "finds another ending",
      "знак проекції похила площина",
      ["Плутає знаки в проекціях сил на похилій площині."],
    ],
    ["finds nothing for unrelated words", "kubernetes cluster", []],
  ])("%s", (_name, query, expected) => {
    const ranked = rankNotes(entries, query, { limit: 5, min: MIN_MATCH, now });
    assert.deepEqual(
      memorySearchResult(ranked).notes.map((note) => note.text),
      expected,
    );
  });

  it("lifts a recent, often-used note among equal matches", () => {
    const old = userNote("Lab on Monday.", "2026-01-01T00:00:00.000Z");
    const used = { ...userNote("Lab on Thursday.", "2026-01-01T00:00:00.000Z"), useCount: 10 };
    const ranked = rankNotes([{ note: old }, { note: used }], "lab", {
      limit: 2,
      min: MIN_MATCH,
      now,
    });
    assert.deepEqual(
      ranked.map(({ entry }) => entry.note.text),
      ["Lab on Thursday.", "Lab on Monday."],
    );
  });
});

describe("fuseRanked", () => {
  it("puts notes both rankings found first, fresh notes before the others", () => {
    const entry = (id: string, status: MemoryNote["status"] = "fresh") => ({
      note: { ...userNote(id), id, status },
    });
    const [a, b, c, d] = [entry("a"), entry("b"), entry("c"), entry("d", "stale")];
    const fused = fuseRanked(
      [a, b, d].map((found) => ({ entry: found, relevance: 0.5, score: 1 })),
      [d, b, c].map((found) => ({ entry: found, similarity: 0.9 })),
      3,
    );
    assert.deepEqual(
      fused.map(({ entry, relevance }) => [entry.note.id, relevance]),
      [
        ["b", 0.5],
        ["a", 0.5],
        ["c", 0.9],
      ],
    );
  });

  it("keeps a note that matches nearly every query word ahead of what the vectors add", () => {
    const entry = (id: string) => ({ note: { ...userNote(id), id } });
    const [exact, weak, near] = [entry("exact"), entry("weak"), entry("near")];
    const fused = fuseRanked(
      [
        { entry: exact, relevance: 0.95, score: 1 },
        { entry: weak, relevance: 0.5, score: 0.6 },
      ],
      [near, weak].map((found) => ({ entry: found, similarity: 0.85 })),
      3,
    );
    assert.deepEqual(
      fused.map(({ entry }) => entry.note.id),
      ["exact", "weak", "near"],
    );
  });
});

describe("looksSecret", () => {
  it.each([
    ["password: hunter2", true],
    ["пароль: hunter2", true],
    ["Пароль = abc123", true],
    ["токен: ghp_abcdefg1234", true],
    ["пин-код: 1234", true],
    ["пін-код: 1234", true],
    ["Пароль від роутера: qwerty12", true],
    ["Пароль від роутера лежить у Vaultwarden.", false],
    ["Mapping pin 4 to GPIO.", false],
  ])("%s", (text, secret) => {
    assert.equal(looksSecret(text), secret);
  });
});

describe("recallQueries", () => {
  it.each([
    ["a follow-up leans on the reply's end", "the second one", "Pick: 1) torque 2) energy", 2],
    [
      "a message that names its topic stands alone",
      "Почему ускорение на наклонной плоскости меньше g?",
      "Done.",
      1,
    ],
    ["only short words", "ok, at 9", undefined, 0],
  ])("%s", (_name, message, reply, count) => {
    const queries = recallQueries(message, reply);
    assert.lengthOf(queries, count);
    if (count === 2) assert.deepEqual(queries, [message, reply]);
  });
});

describe("recall relevance", () => {
  const now = Date.parse("2026-11-08T00:00:00.000Z");
  const exam = { note: userNote("Экзамен по механике в июне, устная часть.") };
  const reply =
    "Верно: проекция силы тяжести на ось вдоль плоскости равна mg sin α, а нормальная сила уравновешивает mg cos α. Дальше посмотрим, как трение меняет ускорение, и проверим на симуляции.";
  const best = (queries: ReadonlyArray<string>) =>
    Math.max(
      0,
      ...queries.map(
        (query) => rankNotes([exam], query, { limit: 5, min: 0, now })[0]?.relevance ?? 0,
      ),
    );

  it("scores the message on its own when the tutor's last reply is long", () => {
    assert.isAtLeast(best(recallQueries("Когда экзамен по механике?", reply)), RECALL_MIN);
  });

  it("bounds a pasted wall of text to a few hundred characters of query", () => {
    const pasted = Array.from({ length: 20_000 }, (_, i) => `слово${i}`).join(" ");
    assert.isAtMost(recallQueries(pasted)[0]!.length, 400);
  });
});
