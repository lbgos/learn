import { Board, BoardAuthor, BoardOps, applyBoardOps } from "@t3tools/physics/board";
import { PhysicsBoardName, type PhysicsBoardEvent } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as PhysicsFiles from "./PhysicsFiles.ts";

const decodeBoardName = Schema.decodeUnknownEffect(PhysicsBoardName);
const boardJson = Schema.fromJsonString(Board);
const decodeBoard = Schema.decodeUnknownEffect(boardJson);
const encodeBoard = Schema.encodeEffect(boardJson);

type BoardEvent = PhysicsBoardEvent;
export class PhysicsBoardService extends Context.Service<
  PhysicsBoardService,
  {
    readonly read: (
      project: string,
      board?: string,
    ) => Effect.Effect<Board, PhysicsFiles.PhysicsFileError>;
    readonly applyOps: (
      project: string,
      board: string,
      ops: BoardOps,
      author: BoardAuthor,
    ) => Effect.Effect<
      {
        board: Board;
        revision: number;
        changed: readonly import("@t3tools/physics/board").BoardItem[];
        removed: readonly string[];
        createdIds: readonly string[];
      },
      PhysicsFiles.PhysicsFileError
    >;
    /** Starts with a snapshot, then emits only newer revisions; cancellation releases the subscription. */
    readonly subscribe: (
      project: string,
      board?: string,
    ) => Stream.Stream<BoardEvent, PhysicsFiles.PhysicsFileError>;
  }
>()("t3/physics/PhysicsBoardService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* PhysicsFiles.PhysicsFiles;
  const locks = yield* KeyedLock.make<string>();
  const changes = yield* PubSub.unbounded<{ path: string; event: BoardEvent }>();
  const boardPath = Effect.fn("PhysicsBoardService.path")(function* (
    project: string,
    name: string,
  ) {
    yield* decodeBoardName(name).pipe(
      Effect.mapError(
        (cause) => new PhysicsFiles.PhysicsFileError({ operation: "resolve", path: name, cause }),
      ),
    );
    return yield* files.resolve(project, `boards/${name}.board.json`);
  });
  const readPath = Effect.fn("PhysicsBoardService.readPath")(function* (file: string) {
    const content = yield* fs.readFileString(file).pipe(
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
      Effect.mapError(
        (cause) => new PhysicsFiles.PhysicsFileError({ operation: "read", path: file, cause }),
      ),
    );
    if (content === undefined) return { version: 1, revision: 0, items: [] } satisfies Board;
    if (content.length > 8_000_000)
      return yield* new PhysicsFiles.PhysicsFileError({ operation: "decode", path: file });
    return yield* decodeBoard(content).pipe(
      Effect.mapError(
        (cause) => new PhysicsFiles.PhysicsFileError({ operation: "decode", path: file, cause }),
      ),
    );
  });
  const read = (project: string, name = "main") =>
    boardPath(project, name).pipe(Effect.flatMap((file) => locks.withLock(file, readPath(file))));
  const applyOps = Effect.fn("PhysicsBoardService.applyOps")(function* (
    project: string,
    name: string,
    ops: BoardOps,
    author: BoardAuthor,
  ) {
    const file = yield* boardPath(project, name);
    return yield* locks.withLock(
      file,
      Effect.gen(function* () {
        const previous = yield* readPath(file);
        const result = yield* Effect.try({
          try: () => applyBoardOps(previous, ops, author),
          catch: (cause) =>
            new PhysicsFiles.PhysicsFileError({ operation: "decode", path: file, cause }),
        });
        const encoded = yield* encodeBoard(result.board).pipe(
          Effect.mapError(
            (cause) =>
              new PhysicsFiles.PhysicsFileError({ operation: "decode", path: file, cause }),
          ),
        );
        if (encoded.length > 8_000_000)
          return yield* new PhysicsFiles.PhysicsFileError({ operation: "write", path: file });
        const write = Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory: path.dirname(file),
            prefix: ".board-",
          });
          const pending = path.join(temporary, "board.json");
          yield* fs.writeFileString(pending, encoded);
          yield* fs.rename(pending, file);
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            (cause) => new PhysicsFiles.PhysicsFileError({ operation: "write", path: file, cause }),
          ),
        );
        yield* write;
        const touched = new Set([
          ...result.createdIds,
          ...ops.flatMap((op) => (op.type === "update" ? [op.id] : [])),
        ]);
        const remaining = new Set(result.board.items.map((item) => item.id));
        const event = {
          revision: result.board.revision,
          changed: result.board.items.filter((item) => touched.has(item.id)),
          removed: previous.items.filter((item) => !remaining.has(item.id)).map((item) => item.id),
        };
        yield* PubSub.publish(changes, { path: file, event });
        return { ...result, ...event };
      }),
    );
  });
  const subscribe = (project: string, name = "main") =>
    Stream.unwrap(
      Effect.gen(function* () {
        const file = yield* boardPath(project, name);
        const subscription = yield* PubSub.subscribe(changes);
        const board = yield* locks.withLock(file, readPath(file));
        return Stream.concat(
          Stream.succeed({ revision: board.revision, board }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (change) => change.path === file && change.event.revision > board.revision,
            ),
            Stream.map((change) => change.event),
          ),
        );
      }),
    );
  return PhysicsBoardService.of({ read, applyOps, subscribe });
});
export const layer = Layer.effect(PhysicsBoardService, make);
