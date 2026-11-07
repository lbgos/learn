import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { applyBoardDelta, type Board } from "@t3tools/physics/board";
import * as PhysicsBoardService from "./PhysicsBoardService.ts";
import * as PhysicsFiles from "./PhysicsFiles.ts";

const testLayer = PhysicsBoardService.layer.pipe(
  Layer.provide(PhysicsFiles.layer),
  Layer.provideMerge(NodeServices.layer),
);
describe("PhysicsBoardService", () => {
  it.effect("serializes concurrent user and agent writes and persists every item", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "physics-board-" });
      const service = yield* PhysicsBoardService.PhysicsBoardService;
      const outcomes = yield* Effect.forEach(
        Array.from({ length: 30 }, (_, i) => i),
        (i) =>
          service.applyOps(
            project,
            "main",
            [{ type: "add", items: [{ kind: "text", text: String(i) }] }],
            i % 2 ? "agent" : "user",
          ),
        { concurrency: "unbounded" },
      );
      expect(new Set(outcomes.flatMap((result) => result.createdIds)).size).toBe(30);
      const persisted = yield* service.read(project);
      expect(persisted.revision).toBe(30);
      expect(persisted.items).toHaveLength(30);
      expect(persisted.items.filter((item) => item.author === "agent")).toHaveLength(15);
      expect(yield* fs.readDirectory(project + "/boards")).toEqual(["main.board.json"]);
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("subscriptions start with a snapshot and publish the next committed revision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "physics-board-stream-" });
      const service = yield* PhysicsBoardService.PhysicsBoardService;
      const image = "data:image/png;base64," + "A".repeat(200_000);
      yield* service.applyOps(
        project,
        "main",
        [{ type: "add", items: [{ kind: "image", src: image, w: 100, h: 100 }] }],
        "user",
      );
      let reconstructed: Board = { version: 1, revision: 0, items: [] };
      const observed = yield* service.subscribe(project).pipe(
        Stream.take(2),
        Stream.runFoldEffect(
          () => [] as number[],
          (seen, event) => {
            if (seen.length > 0) {
              expect(event).not.toHaveProperty("board");
              expect(JSON.stringify(event)).not.toContain(image);
              expect(event).toMatchObject({
                revision: 2,
                changed: [{ kind: "text", text: "hello", author: "agent" }],
                removed: [],
              });
            }
            reconstructed = "board" in event ? event.board : applyBoardDelta(reconstructed, event);
            const next = [...seen, event.revision];
            return seen.length === 0
              ? service
                  .applyOps(
                    project,
                    "main",
                    [{ type: "add", items: [{ kind: "text", text: "hello" }] }],
                    "agent",
                  )
                  .pipe(Effect.as(next))
              : Effect.succeed(next);
          },
        ),
      );
      expect(observed).toEqual([1, 2]);
      expect(reconstructed).toEqual(yield* service.read(project));
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("rejects escaped paths and symlinks before writing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "physics-board-path-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "physics-outside-" });
      const service = yield* PhysicsBoardService.PhysicsBoardService;
      expect((yield* service.read(project, "../outside").pipe(Effect.result))._tag).toBe("Failure");
      yield* fs.symlink(outside, path.join(project, "boards"));
      expect(
        (yield* service.applyOps(project, "main", [{ type: "clear" }], "user").pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(yield* fs.readDirectory(outside)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});
