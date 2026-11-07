import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import type { PhysicsSimEvent } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.watch does not expose watcher acquisition; subscribe must acquire before its initial read.
import * as NodeFS from "node:fs";

export class PhysicsFileError extends Schema.TaggedError<PhysicsFileError>()("PhysicsFileError", {
  operation: Schema.Literals(["resolve", "read", "list", "write", "decode", "subscribe"]),
  path: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Physics file ${this.operation} failed at ${this.path}. Paths must stay inside the project.`;
  }
}

export class PhysicsFiles extends Context.Service<
  PhysicsFiles,
  {
    /** Resolves existing symlinks, including ancestors of files not yet created. */
    readonly resolve: (root: string, relative: string) => Effect.Effect<string, PhysicsFileError>;
    readonly readSim: (
      root: string,
      relative: string,
    ) => Effect.Effect<{ path: string; code: string; hash: string }, PhysicsFileError>;
    readonly readVisual: (
      root: string,
      relative: string,
    ) => Effect.Effect<{ path: string; code: string; hash: string }, PhysicsFileError>;
    readonly subscribeSim: (
      root: string,
      relative: string,
    ) => Stream.Stream<PhysicsSimEvent, PhysicsFileError>;
    readonly list: (
      root: string,
    ) => Effect.Effect<{ sims: { path: string }[]; boards: string[] }, PhysicsFileError>;
  }
>()("t3/physics/PhysicsFiles") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const resolve = Effect.fn("PhysicsFiles.resolve")(function* (root: string, relative: string) {
    const fail = (cause?: unknown) =>
      new PhysicsFileError({
        operation: "resolve",
        path: relative,
        ...(cause === undefined ? {} : { cause }),
      });
    const realRoot = yield* fs.realPath(root).pipe(Effect.mapError(fail));
    const target = path.resolve(realRoot, relative);
    const inside = (candidate: string) => {
      const rel = path.relative(realRoot, candidate);
      return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
    };
    if (!inside(target)) return yield* fail();
    let ancestor = target;
    const tail: string[] = [];
    while (!(yield* fs.exists(ancestor).pipe(Effect.mapError(fail)))) {
      // A dangling symlink exists as a directory entry but not as a resolved target.
      // realPath must fail closed rather than following it when it later becomes valid.
      const info = yield* fs.readLink(ancestor).pipe(Effect.option);
      if (info._tag === "Some") return yield* fail();
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return yield* fail();
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    const canonical = path.join(yield* fs.realPath(ancestor).pipe(Effect.mapError(fail)), ...tail);
    if (!inside(canonical)) return yield* fail();
    return canonical;
  });
  const readSource = Effect.fn("PhysicsFiles.readSource")(function* (
    root: string,
    relative: string,
  ) {
    if (!/^(?:sims\/[^\0]+\.sim\.js|visuals\/[a-z0-9][a-z0-9-]*\.html)$/.test(relative))
      return yield* new PhysicsFileError({ operation: "read", path: relative });
    const resolved = yield* resolve(root, relative);
    const info = yield* fs
      .stat(resolved)
      .pipe(
        Effect.mapError(
          (cause) => new PhysicsFileError({ operation: "read", path: relative, cause }),
        ),
      );
    if (info.type !== "File" || info.size > 512_000n)
      return yield* new PhysicsFileError({ operation: "read", path: relative });
    const code = yield* fs
      .readFileString(resolved)
      .pipe(
        Effect.mapError(
          (cause) => new PhysicsFileError({ operation: "read", path: relative, cause }),
        ),
      );
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(code))
      .pipe(
        Effect.mapError(
          (cause) => new PhysicsFileError({ operation: "read", path: relative, cause }),
        ),
      );
    return { path: relative, code, hash: Buffer.from(digest).toString("hex") };
  });
  const readSim = (root: string, relative: string) =>
    /^sims\/[^\0]+\.sim\.js$/.test(relative)
      ? readSource(root, relative)
      : Effect.fail(new PhysicsFileError({ operation: "read", path: relative }));
  const readVisual = (root: string, relative: string) =>
    /^visuals\/[a-z0-9][a-z0-9-]*\.html$/.test(relative)
      ? readSource(root, relative)
      : Effect.fail(new PhysicsFileError({ operation: "read", path: relative }));
  const subscribeSim = (root: string, relative: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (!/^(?:sims\/[^\0]+\.sim\.js|visuals\/[a-z0-9][a-z0-9-]*\.html)$/.test(relative))
          return yield* new PhysicsFileError({ operation: "read", path: relative });
        // Watch the directory rather than an inode: editors commonly replace the file.
        yield* resolve(root, relative);
        // Watch the path entry, including a symlink that an editor may replace.
        const directory = yield* resolve(root, path.dirname(relative));
        const watchedFile = path.join(directory, path.basename(relative));
        const changes = Stream.callback<void, PhysicsFileError>((queue) =>
          Effect.gen(function* () {
            // Acquire the watcher before the first read, so an edit made as soon as
            // the initial event arrives cannot fall between reading and watching.
            yield* Effect.acquireRelease(
              Effect.try({
                try: () => {
                  const watcher = NodeFS.watch(directory, (_event, name) => {
                    if (name === null || path.resolve(directory, name.toString()) === watchedFile)
                      Queue.offerUnsafe(queue, undefined);
                  });
                  watcher.on("error", (cause) =>
                    Queue.failCauseUnsafe(
                      queue,
                      Cause.fail(
                        new PhysicsFileError({ operation: "subscribe", path: relative, cause }),
                      ),
                    ),
                  );
                  return watcher;
                },
                catch: (cause) =>
                  new PhysicsFileError({ operation: "subscribe", path: relative, cause }),
              }),
              (watcher) => Effect.sync(() => watcher.close()),
            );
            yield* Queue.offer(queue, undefined);
          }),
        );
        return changes.pipe(
          Stream.debounce("75 millis"),
          Stream.mapEffect(() =>
            readSource(root, relative).pipe(
              Effect.map(({ code, hash }): PhysicsSimEvent => ({ type: "file", code, hash })),
              Effect.catch((error) =>
                Effect.succeed<PhysicsSimEvent>(
                  PlatformError.isPlatformError(error.cause) &&
                    error.cause.reason._tag === "NotFound"
                    ? { type: "missing" }
                    : { type: "error", message: error.message },
                ),
              ),
            ),
          ),
          Stream.changesWith((a, b) => {
            switch (a.type) {
              case "file":
                return b.type === "file" && a.hash === b.hash;
              case "missing":
                return b.type === "missing";
              case "error":
                return b.type === "error" && a.message === b.message;
            }
          }),
        );
      }),
    );
  const list = Effect.fn("PhysicsFiles.list")(function* (root: string) {
    const entries = (folder: string) =>
      resolve(root, folder).pipe(
        Effect.flatMap((resolved) => fs.readDirectory(resolved)),
        Effect.catchIf(
          (e) => e._tag === "PlatformError" && e.reason._tag === "NotFound",
          () => Effect.succeed([] as string[]),
        ),
        Effect.mapError((cause) =>
          cause._tag === "PhysicsFileError"
            ? cause
            : new PhysicsFileError({ operation: "list", path: folder, cause }),
        ),
      );
    const sims = (yield* entries("sims"))
      .filter((name) => name.endsWith(".sim.js"))
      .sort()
      .map((name) => ({ path: `sims/${name}` }));
    const boards = (yield* entries("boards"))
      .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.board\.json$/.test(name))
      .sort()
      .map((name) => name.slice(0, -11));
    return { sims, boards };
  });
  return PhysicsFiles.of({ resolve, readSim, readVisual, subscribeSim, list });
});
export const layer = Layer.effect(PhysicsFiles, make);
