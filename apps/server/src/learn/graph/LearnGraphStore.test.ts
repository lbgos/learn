import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Graph from "@t3tools/learn/graph";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Store from "./LearnGraphStore.ts";

const node = (id: string): Graph.GraphNode => ({
  id,
  name: id,
  statement: id,
  aliases: [],
  createdAt: "now",
  provenance: [{ chatId: "teach", messageId: "m1" }],
});
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.layer(NodeServices.layer)("LearnGraphStore", (it) => {
  it.effect("serializes concurrent read-modify-write plans without losing nodes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const store = yield* Store.LearnGraphStore.pipe(Effect.provide(Store.layerAt(root)));
      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, i) => i),
        (i) =>
          store.transact((current) => ({
            append: {},
            rewrite: { nodes: [...current.nodes, node(`n_${i}`)] },
            result: undefined,
          })),
        { concurrency: 20 },
      );
      assert.equal((yield* store.read).nodes.length, 20);
      assert.equal(yield* store.revision, 20);
      const names = yield* fs.readDirectory(`${root}/learn/graph`);
      assert.isFalse(names.some((name) => name.endsWith(".tmp") || name === "transaction.json"));
    }).pipe(Effect.scoped),
  );

  it.effect("drops corrupt ledger lines and malformed positions independently", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const directory = `${root}/learn/graph`;
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/nodes.jsonl`,
        `${json(node("n_a"))}\ntruncated{\n{}\n${json(node("n_b"))}\n`,
      );
      yield* fs.writeFileString(
        `${directory}/positions.json`,
        json({ positions: { n_a: { x: 1, y: 2 }, n_bad: { x: "bad", y: 1 } } }),
      );
      yield* fs.writeFileString(
        `${directory}/sources.json`,
        json({ "notes:a": { id: "notes:a", filePath: "a.md", importedAt: "now" }, bad: {} }),
      );
      const store = yield* Store.LearnGraphStore.pipe(Effect.provide(Store.layerAt(root)));
      const ledgers = yield* store.read;
      assert.equal(ledgers.nodes.length, 2);
      assert.equal(ledgers.sources.length, 1);
      assert.deepEqual(ledgers.positions, { n_a: { x: 1, y: 2 } });
    }).pipe(Effect.scoped),
  );

  it.effect("renames complete temporary files and recovers a failed multi-ledger commit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let fail = true;
      let renames = 0;
      const tracked = {
        ...fs,
        rename: (from: string, to: string) =>
          Effect.gen(function* () {
            assert.isTrue(from.endsWith(".tmp"));
            const raw = yield* fs.readFileString(from);
            assert.isTrue(raw.length > 0 || to.endsWith(".jsonl"));
            renames++;
            if (to.endsWith("chains.jsonl") && fail) {
              fail = false;
              return yield* fs.readFileString(`${root}/missing`).pipe(Effect.asVoid);
            }
            yield* fs.rename(from, to);
          }),
      };
      const store = yield* Store.LearnGraphStore.pipe(
        Effect.provide(Store.layerAt(root)),
        Effect.provideService(FileSystem.FileSystem, tracked),
      );
      const outcome = yield* store
        .transact(() => ({ append: { nodes: [node("n_a")] }, rewrite: {}, result: undefined }))
        .pipe(Effect.result);
      assert.equal(outcome._tag, "Failure");
      assert.isTrue(yield* fs.exists(`${root}/learn/graph/transaction.json`));
      assert.deepEqual((yield* store.read).nodes, [node("n_a")]);
      assert.equal(yield* store.revision, 1);
      assert.isFalse(yield* fs.exists(`${root}/learn/graph/transaction.json`));
      assert.isAbove(renames, 7);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a newer format before rewriting data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${root}/learn/graph`, { recursive: true });
      yield* fs.writeFileString(`${root}/learn/graph/format.json`, json({ version: 999 }));
      const store = yield* Store.LearnGraphStore.pipe(Effect.provide(Store.layerAt(root)));
      assert.equal((yield* store.read.pipe(Effect.result))._tag, "Failure");
      assert.equal(
        (yield* store
          .transact(() => ({ append: {}, rewrite: {}, result: undefined }))
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        yield* fs.readFileString(`${root}/learn/graph/format.json`),
        json({ version: 999 }),
      );
    }).pipe(Effect.scoped),
  );
});
