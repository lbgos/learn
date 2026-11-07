import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { LearnSessionMeta } from "@t3tools/learn/session";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Store from "./LearnSessionStore.ts";
import { tutor } from "./testkit.ts";

const decodeMeta = Schema.decodeEffect(Schema.fromJsonString(LearnSessionMeta));

it.effect("round-trips unsafe and long ids atomically, retaining decodable core metadata", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "learn-session-store-" });
    yield* Effect.gen(function* () {
      const store = yield* Store.LearnSessionStore;
      assert.deepEqual(yield* store.list, []);
      const id = ThreadId.make(`../unsafe/київ%?${"x".repeat(300)}`);
      assert.isNull(yield* store.get(id));
      const meta = {
        threadId: id,
        kind: "practice",
        mechanic: "choice",
        createdAt: "2026-10-24",
        lastRoutedModel: tutor,
      } as const;
      yield* store.put(meta);
      yield* store.put({ ...meta, manuallyOverridden: true });
      assert.equal(yield* Store.kindOf(id), "practice");
      assert.isUndefined(yield* Store.kindOf(ThreadId.make("unknown")));
      const filename = Store.sessionMetaFileName(id);
      assert.match(filename, /^[a-f0-9]{64}\.json$/);
      assert.notEqual(filename, Store.sessionMetaFileName(`${id}/other`));
      assert.deepEqual(yield* fs.readDirectory(path.join(root, "learn", "sessions")), [filename]);
      const raw = yield* fs.readFileString(path.join(root, "learn", "sessions", filename));
      const core = yield* decodeMeta(raw);
      assert.equal(core.kind, "practice");
      assert.isTrue((yield* store.list)[0]?.manuallyOverridden);
      assert.deepEqual(yield* store.get(id), { ...meta, manuallyOverridden: true });
      yield* Effect.all(
        [
          store.update(
            id,
            (current) => current && { ...current, pausedAt: "2026-11-04T00:00:00Z" },
          ),
          store.update(
            id,
            (current) =>
              current && { ...current, lastRoutedModel: { ...tutor, model: "planning" } },
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal((yield* store.get(id))?.pausedAt, "2026-11-04T00:00:00Z");
      assert.equal((yield* store.get(id))?.lastRoutedModel?.model, "planning");
    }).pipe(Effect.provide(Store.layerAt(root).pipe(Layer.provide(NodeServices.layer))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
