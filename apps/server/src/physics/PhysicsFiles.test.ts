import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import type { PhysicsSimEvent } from "@t3tools/contracts";
import * as PhysicsFiles from "./PhysicsFiles.ts";

it.live("streams edits and atomic replacements, then recovers after deletion and restoration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "physics-subscribe-" });
    yield* fs.makeDirectory(path.join(root, "sims"));
    const file = path.join(root, "sims/test.sim.js");
    yield* fs.writeFileString(file, "v1");
    const files = yield* PhysicsFiles.PhysicsFiles;
    const initial = yield* Deferred.make<Extract<PhysicsSimEvent, { type: "file" }>>();
    const edited = yield* Deferred.make<Extract<PhysicsSimEvent, { type: "file" }>>();
    const replaced = yield* Deferred.make<Extract<PhysicsSimEvent, { type: "file" }>>();
    const missing = yield* Deferred.make<PhysicsSimEvent>();
    const restored = yield* Deferred.make<PhysicsSimEvent>();
    const events: PhysicsSimEvent[] = [];
    const subscription = yield* files.subscribeSim(root, "sims/test.sim.js").pipe(
      Stream.runForEach((event) => {
        events.push(event);
        if (event.type !== "file") return Deferred.succeed(missing, event);
        if (event.code === "v1") return Deferred.succeed(initial, event);
        if (event.code === "v2") return Deferred.succeed(edited, event);
        if (events.some((value) => value.type === "missing"))
          return Deferred.succeed(restored, event);
        return Deferred.succeed(replaced, event);
      }),
      Effect.forkScoped,
    );
    const first = yield* Deferred.await(initial);
    expect(first.code).toBe("v1");
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    yield* fs.writeFileString(file, "v2");
    const second = yield* Deferred.await(edited);
    expect(second.hash).not.toBe(first.hash);
    yield* fs.writeFileString(file + ".tmp", "v3");
    yield* fs.rename(file + ".tmp", file);
    const third = yield* Deferred.await(replaced);
    expect(third.code).toBe("v3");
    expect(third.hash).not.toBe(second.hash);
    yield* fs.remove(file);
    expect(yield* Deferred.await(missing)).toEqual({ type: "missing" });
    // Restoring identical contents must still clear the missing state.
    yield* fs.writeFileString(file, "v3");
    expect(yield* Deferred.await(restored)).toEqual(third);
    expect(events.map((event) => event.type)).toEqual(["file", "file", "file", "missing", "file"]);
    yield* Fiber.interrupt(subscription);
  }).pipe(Effect.provide(PhysicsFiles.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.live("reports an escaping replacement symlink as an error and recovers without reading it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "physics-subscribe-safe-" });
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "physics-subscribe-outside-" });
    yield* fs.makeDirectory(path.join(root, "sims"));
    const file = path.join(root, "sims/test.sim.js");
    yield* fs.writeFileString(file, "v1");
    yield* fs.writeFileString(path.join(outside, "outside.sim.js"), "outside");
    const files = yield* PhysicsFiles.PhysicsFiles;
    const ready = yield* Deferred.make<void>();
    const rejected = yield* Deferred.make<PhysicsSimEvent>();
    const restored = yield* Deferred.make<PhysicsSimEvent>();
    const subscription = yield* files.subscribeSim(root, "sims/test.sim.js").pipe(
      Stream.runForEach((event) => {
        if (event.type !== "file") return Deferred.succeed(rejected, event);
        if (event.code === "v2") return Deferred.succeed(restored, event);
        return Deferred.succeed(ready, undefined);
      }),
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    yield* fs.symlink(path.join(outside, "outside.sim.js"), file + ".tmp");
    yield* fs.rename(file + ".tmp", file);
    expect(yield* Deferred.await(rejected)).toEqual({
      type: "error",
      message:
        "Physics file resolve failed at sims/test.sim.js. Paths must stay inside the project.",
    });
    yield* fs.writeFileString(file + ".tmp", "v2");
    yield* fs.rename(file + ".tmp", file);
    expect(yield* Deferred.await(restored)).toMatchObject({ type: "file", code: "v2" });
    yield* Fiber.interrupt(subscription);
  }).pipe(Effect.provide(PhysicsFiles.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.live("rejects invalid and escaping paths before emitting any events", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "physics-subscribe-invalid-" });
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "physics-subscribe-outside-" });
    yield* fs.makeDirectory(path.join(root, "sims"));
    yield* fs.symlink(outside, path.join(root, "sims/escape"));
    const files = yield* PhysicsFiles.PhysicsFiles;
    for (const relative of [
      "not-a-sim.js",
      "sims/../../outside.sim.js",
      "sims/escape/test.sim.js",
    ]) {
      const result = yield* files.subscribeSim(root, relative).pipe(Stream.runHead, Effect.result);
      expect(result._tag).toBe("Failure");
    }
  }).pipe(Effect.provide(PhysicsFiles.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.live("subscribes to a missing sim and emits its contents when created", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "physics-subscribe-missing-" });
    yield* fs.makeDirectory(path.join(root, "sims"));
    const files = yield* PhysicsFiles.PhysicsFiles;
    const missing = yield* Deferred.make<PhysicsSimEvent>();
    const created = yield* Deferred.make<PhysicsSimEvent>();
    yield* files.subscribeSim(root, "sims/test.sim.js").pipe(
      Stream.runForEach((event) =>
        Deferred.succeed(event.type === "file" ? created : missing, event),
      ),
      Effect.forkScoped,
    );
    expect(yield* Deferred.await(missing)).toEqual({ type: "missing" });
    yield* fs.writeFileString(path.join(root, "sims/test.sim.js"), "v1");
    expect(yield* Deferred.await(created)).toMatchObject({ type: "file", code: "v1" });
  }).pipe(Effect.provide(PhysicsFiles.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.live(
  "recovers from transient reads and suppresses repeated missing, error and unchanged file events",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "physics-subscribe-error-" });
      yield* fs.makeDirectory(path.join(root, "sims"));
      const file = path.join(root, "sims/test.sim.js");
      yield* fs.writeFileString(file, "v1");
      let readFailure: "NotFound" | "PermissionDenied" | undefined;
      const reads = yield* Queue.unbounded<void>();
      const filesystem = {
        ...fs,
        readFileString: (target, encoding) =>
          Effect.gen(function* () {
            const failure = target === file ? readFailure : undefined;
            yield* Queue.offer(reads, undefined);
            if (failure)
              return yield* PlatformError.systemError({
                _tag: failure,
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: target,
              });
            return yield* fs.readFileString(target, encoding);
          }),
      } satisfies FileSystem.FileSystem;
      const files = yield* PhysicsFiles.PhysicsFiles.pipe(
        Effect.provide(
          PhysicsFiles.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, filesystem))),
        ),
      );
      const ready = yield* Deferred.make<void>();
      const restored = yield* Deferred.make<PhysicsSimEvent>();
      const events: PhysicsSimEvent[] = [];
      yield* files.subscribeSim(root, "sims/test.sim.js").pipe(
        Stream.runForEach((event) => {
          events.push(event);
          if (event.type !== "file") return Effect.void;
          if (event.code === "v3") return Deferred.succeed(restored, event);
          return Deferred.succeed(ready, undefined);
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      yield* Queue.take(reads);
      for (const failure of [
        "NotFound",
        "NotFound",
        "PermissionDenied",
        "PermissionDenied",
        undefined,
        undefined,
      ] as const) {
        readFailure = failure;
        yield* fs.writeFileString(file, "v1");
        yield* Queue.take(reads);
      }
      yield* fs.writeFileString(file, "v3");
      expect(yield* Deferred.await(restored)).toMatchObject({ type: "file", code: "v3" });
      expect(events.map((event) => event.type)).toEqual([
        "file",
        "missing",
        "error",
        "file",
        "file",
      ]);
      expect(events[2]).toMatchObject({ type: "error", message: expect.any(String) });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reads and streams visual HTML while keeping sim reads and escaping paths restricted", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "visual-files-" });
    yield* fs.makeDirectory(path.join(root, "visuals"));
    yield* fs.writeFileString(path.join(root, "visuals/example.html"), "<body>visual</body>");
    const files = yield* PhysicsFiles.PhysicsFiles;
    const read = yield* files.readVisual(root, "visuals/example.html");
    expect(read.code).toBe("<body>visual</body>");
    expect(read.hash).toMatch(/^[a-f0-9]{64}$/);
    const event = yield* files.subscribeSim(root, "visuals/example.html").pipe(Stream.runHead);
    expect(event).toMatchObject({ value: { type: "file", code: read.code, hash: read.hash } });
    expect(yield* files.readSim(root, "visuals/example.html").pipe(Effect.flip)).toMatchObject({
      _tag: "PhysicsFileError",
    });
    expect(
      yield* files.readVisual(root, "visuals/../example.html").pipe(Effect.flip),
    ).toMatchObject({ _tag: "PhysicsFileError" });
  }).pipe(Effect.provide(PhysicsFiles.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
