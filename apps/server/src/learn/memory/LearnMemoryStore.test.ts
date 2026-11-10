import { assert, it } from "@effect/vitest";
import { LEARN_MEMORY_NOTES_MAX, type MemoryNote, MessageId, noteId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Memory from "./LearnMemoryStore.ts";
import { forgetKey, MIN_MATCH } from "./memory.ts";
import { MemoryEmbedder } from "./MemoryEmbedder.ts";

const at = "2026-11-01T10:00:00.000Z";
const note = (text: string, id?: string): MemoryNote => ({
  id: id ?? noteId(text, at),
  text,
  status: "fresh",
  source: { by: "user", at },
});
const texts = (notes: ReadonlyArray<MemoryNote>) => notes.map((n) => n.text);
const layerMemory = Layer.effect(Memory.LearnMemoryStore, Memory.makeMemoryStore).pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

/** An embedder whose vector says which topics a text names, in any of its languages. */
const TOPICS = [
  ["sister", "сестр"],
  ["prague", "праг"],
  ["backup", "бэкап"],
  ["night", "ноч"],
];
const fakeEmbedder = () => {
  const state = {
    up: true,
    embedded: [] as string[],
    /** Holds the next call until `open`, after telling `started`. */
    gate: undefined as
      | { readonly started: Deferred.Deferred<void>; readonly open: Deferred.Deferred<void> }
      | undefined,
  };
  const layer = Layer.succeed(MemoryEmbedder, {
    embed: (texts) =>
      Effect.gen(function* () {
        const gate = state.gate;
        state.gate = undefined;
        if (gate) {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.open);
        }
        if (!state.up) return undefined;
        state.embedded.push(...texts);
        return {
          model: "fake",
          vectors: texts.map((text) =>
            Float32Array.from(
              TOPICS.map((words) => (words.some((w) => text.toLowerCase().includes(w)) ? 1 : 0)),
            ),
          ),
        };
      }),
  });
  return { state, layer };
};
const layerHybrid = (embedder: Layer.Layer<MemoryEmbedder>) =>
  Layer.effect(Memory.LearnMemoryStore, Memory.makeMemoryStore).pipe(
    Layer.provide(embedder),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

it.effect(
  "retires what a change leaves out, deletes what the learner forgets, and restores a note that comes back",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.LearnMemoryStore;
      const gamma = note("Gamma.", "c");
      const [a, b, c] = [
        note("Alpha.", "a"),
        note("Beta.", "b"),
        { ...gamma, source: { ...gamma.source, messageId: MessageId.make("m-c") } },
      ];
      yield* memory.edit(() => [a, b, c]);
      yield* memory.edit((notes) => notes.filter((n) => n.id !== "b"), {
        supersededBy: () => "c",
      });
      yield* memory.edit((notes) => notes.filter((n) => n.id !== "c"), {
        remove: "delete",
      });
      assert.deepEqual(texts(yield* memory.notes), ["Alpha."]);
      // A forgotten note leaves a hash of its words and its message id, never its text.
      const forgotten = yield* memory.forgotten;
      assert.deepEqual([...forgotten.hashes], [forgetKey("Gamma.")]);
      assert.deepEqual([...forgotten.messages], ["m-c"]);
      const retired = yield* memory.page({ retired: true, offset: 0, limit: 10 });
      assert.deepEqual(
        retired.notes.map((n) => [n.id, n.supersededBy]),
        [["b", "c"]],
      );
      // An undo hands the note back; it returns to its old place.
      yield* memory.edit((notes) => [...notes, b]);
      assert.deepEqual(texts(yield* memory.notes), ["Alpha.", "Beta."]);

      yield* memory.setNote("b", { pinned: true });
      const page = yield* memory.page({ offset: 0, limit: 10 });
      assert.deepEqual(
        page.notes.map((n) => [n.id, n.pinned ?? false]),
        [
          ["b", "user"],
          ["a", false],
        ],
      );
      yield* memory.setNote("b", { retired: true });
      assert.deepEqual(texts(yield* memory.notes), ["Alpha."]);
      yield* memory.setNote("b", { retired: false });
      assert.deepEqual(
        (yield* memory.notes).map((n) => [n.id, n.pinned ?? false]),
        [
          ["a", false],
          ["b", false],
        ],
      );
      assert.equal(
        (yield* Effect.flip(memory.setNote("zz", { pinned: true }))).operation,
        "missing",
      );
    }).pipe(Effect.provide(layerMemory)),
);

it.effect("finds notes through the index with ё, й and endings folded", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.LearnMemoryStore;
    yield* memory.edit(() => [
      note("Ёжик живёт в Харькове."),
      note("Купить йогурт и сыр."),
      note("Backups run at night."),
    ]);
    const found = (query: string) =>
      memory
        .search(query, { limit: 5, min: MIN_MATCH, now: Date.parse(at), scan: false })
        .pipe(Effect.map((ranked) => ranked.map(({ entry }) => entry.note.text)));
    assert.deepEqual(yield* found("ежик"), ["Ёжик живёт в Харькове."]);
    assert.deepEqual(yield* found("харьков"), ["Ёжик живёт в Харькове."]);
    assert.deepEqual(yield* found("иогурт"), ["Купить йогурт и сыр."]);
    assert.deepEqual(yield* found("kubernetes"), []);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("refuses to hold more notes than the cap", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.LearnMemoryStore;
    const many = Array.from({ length: LEARN_MEMORY_NOTES_MAX + 1 }, (_, i) =>
      note(`Note ${i}.`, `n${i}`),
    );
    assert.equal((yield* Effect.flip(memory.edit(() => many))).operation, "cap");
    yield* memory.edit(() => many.slice(1));
    assert.lengthOf(yield* memory.notes, LEARN_MEMORY_NOTES_MAX);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect(
  "fuses the notes near the query's vector with the word ranking, words alone without it",
  () => {
    const embedder = fakeEmbedder();
    return Effect.gen(function* () {
      const memory = yield* Memory.LearnMemoryStore;
      yield* memory.edit(() => [
        note("Моя сестра живёт в Праге.", "n1"),
        note("Backups run at night.", "n2"),
      ]);
      const found = (query: string, dense?: number) =>
        memory
          .search(query, {
            limit: 5,
            min: MIN_MATCH,
            now: Date.parse(at),
            scan: false,
            dense,
          })
          .pipe(Effect.map((ranked) => ranked.map(({ entry }) => entry.note.id)));
      yield* memory.syncVectors;
      assert.deepEqual(yield* found("where does my sister live?", 0.5), ["n1"]);
      assert.deepEqual(yield* found("backups at night", 0.5), ["n2"]);
      assert.deepEqual(yield* found("where does my sister live?"), []);
      yield* memory.setNote("n1", { retired: true });
      assert.deepEqual(yield* found("where does my sister live?", 0.5), []);
      embedder.state.up = false;
      assert.deepEqual(yield* found("backups at night", 0.5), ["n2"]);
    }).pipe(Effect.provide(layerHybrid(embedder.layer)));
  },
);

it.effect("never keeps a vector for text that changed while it was embedded", () => {
  const embedder = fakeEmbedder();
  return Effect.gen(function* () {
    const memory = yield* Memory.LearnMemoryStore;
    const gate = { started: yield* Deferred.make<void>(), open: yield* Deferred.make<void>() };
    embedder.state.gate = gate;
    yield* memory.edit(() => [note("Sister in Prague.", "n1")]);
    yield* Deferred.await(gate.started);
    yield* memory.edit((notes) => notes.map((n) => ({ ...n, text: "Backups at night." })));
    yield* Deferred.succeed(gate.open, undefined);
    assert.deepEqual(yield* memory.syncVectors, { notes: 1, vectors: 1 });
    const nearest = (query: string) =>
      memory
        .search(query, { limit: 5, min: 2, now: Date.parse(at), scan: false, dense: 0.5 })
        .pipe(Effect.map((ranked) => ranked.map(({ entry }) => entry.note.id)));
    assert.deepEqual(yield* nearest("sister"), []);
    assert.deepEqual(yield* nearest("backups at night"), ["n1"]);
  }).pipe(Effect.provide(layerHybrid(embedder.layer)));
});

it.effect("keeps a vector per live note: backfilled, re-made on edit, dropped on forget", () => {
  const embedder = fakeEmbedder();
  return Effect.gen(function* () {
    const memory = yield* Memory.LearnMemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const stored = sql<{
      readonly id: string;
    }>`SELECT id FROM learn_memory_vectors ORDER BY id`.pipe(
      Effect.map((rows) => rows.map((row) => row.id)),
    );
    embedder.state.up = false;
    yield* memory.edit(() => [note("Sister in Prague.", "n1"), note("Backups.", "n2")]);
    assert.deepEqual(yield* memory.syncVectors, { notes: 2, vectors: 0 });
    embedder.state.up = true;
    assert.deepEqual(yield* memory.syncVectors, { notes: 2, vectors: 2 });

    yield* memory.edit((notes) =>
      notes.map((n) => (n.id === "n1" ? { ...n, text: "Sister moved to Brno." } : n)),
    );
    assert.deepEqual(yield* memory.syncVectors, { notes: 2, vectors: 2 });
    assert.include(embedder.state.embedded, "Sister moved to Brno.");

    yield* memory.edit((notes) => notes.filter((n) => n.id !== "n2"), {
      forget: () => true,
    });
    assert.deepEqual(yield* stored, ["n1"]);
    const embeds = embedder.state.embedded.length;
    assert.deepEqual(yield* memory.syncVectors, { notes: 1, vectors: 1 });
    assert.equal(embedder.state.embedded.length, embeds);

    yield* memory.edit(() => [], { remove: "delete" });
    assert.deepEqual(yield* stored, []);
  }).pipe(Effect.provide(layerHybrid(embedder.layer)));
});
