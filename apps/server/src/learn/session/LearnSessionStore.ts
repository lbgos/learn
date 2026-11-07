import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { labDirectory } from "../../physics/labDirectory.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous filenames are also used by the graph metadata lookup.
import * as NodeCrypto from "node:crypto";
import { ModelSelection, ThreadId } from "@t3tools/contracts";
import { LearnSessionMeta } from "@t3tools/learn/session";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const StoredLearnSession = Schema.Struct({
  ...LearnSessionMeta.fields,
  threadId: ThreadId,
  lastRoutedModel: Schema.optional(ModelSelection),
  manuallyOverridden: Schema.optional(Schema.Boolean),
  /** Set by a pause; the next requested run ends it (`learnSessionPaused`). */
  pausedAt: Schema.optional(Schema.String),
  warmUpDue: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String, statement: Schema.String }),
    ),
  ),
});
export type StoredLearnSession = typeof StoredLearnSession.Type;

/** UTF-8 thread id -> lowercase SHA-256 hex + .json. The record retains the original id. */
export function sessionMetaFileName(threadId: string): string {
  return `${NodeCrypto.createHash("sha256").update(threadId, "utf8").digest("hex")}.json`;
}

export class LearnSessionStoreError extends Schema.TaggedError<LearnSessionStoreError>()(
  "LearnSessionStoreError",
  { operation: Schema.Literals(["read", "write", "list"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} learning session metadata.`;
  }
}
export class LearnSessionStore extends Context.Service<
  LearnSessionStore,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<StoredLearnSession | null, LearnSessionStoreError>;
    readonly update: (
      threadId: ThreadId,
      change: (current: StoredLearnSession | null) => StoredLearnSession | null,
    ) => Effect.Effect<StoredLearnSession | null, LearnSessionStoreError>;
    readonly put: (record: StoredLearnSession) => Effect.Effect<void, LearnSessionStoreError>;
    readonly list: Effect.Effect<readonly StoredLearnSession[], LearnSessionStoreError>;
  }
>()("t3/learn/session/LearnSessionStore") {}

export const layerAt = (workspaceRoot: string) =>
  Layer.effect(
    LearnSessionStore,
    Effect.gen(function* () {
      const locks = yield* KeyedLock.make<ThreadId>();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(workspaceRoot, "learn", "sessions");
      const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredLearnSession));
      const encode = Schema.encodeEffect(Schema.fromJsonString(StoredLearnSession));
      const read = (file: string) =>
        fs.readFileString(path.join(directory, file)).pipe(Effect.flatMap(decode));
      const service: LearnSessionStore["Service"] = LearnSessionStore.of({
        update: Effect.fn("LearnSessionStore.update")((id, change) =>
          locks.withLock(
            id,
            Effect.gen(function* () {
              const next = change(yield* service.get(id));
              if (next) yield* service.put(next);
              return next;
            }),
          ),
        ),
        get: Effect.fn("LearnSessionStore.get")((threadId) =>
          read(sessionMetaFileName(threadId)).pipe(
            Effect.filterOrFail(
              (record) => record.threadId === threadId,
              () =>
                new LearnSessionStoreError({
                  operation: "read",
                  cause: "Session metadata identity mismatch",
                }),
            ),
            Effect.catchTags({
              PlatformError: (error) =>
                error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
            }),
            Effect.mapError((cause) => new LearnSessionStoreError({ operation: "read", cause })),
          ),
        ),
        put: Effect.fn("LearnSessionStore.put")((record) =>
          Effect.scoped(
            Effect.gen(function* () {
              const content = yield* encode(record);
              yield* fs.makeDirectory(directory, { recursive: true });
              const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".session-" });
              yield* fs.writeFileString(temporary, `${content}\n`);
              yield* fs.rename(
                temporary,
                path.join(directory, sessionMetaFileName(record.threadId)),
              );
            }),
          ).pipe(
            Effect.mapError((cause) => new LearnSessionStoreError({ operation: "write", cause })),
          ),
        ),
        list: fs.readDirectory(directory).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
          }),
          Effect.flatMap((files) =>
            Effect.forEach(files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).sort(), read),
          ),
          Effect.mapError((cause) => new LearnSessionStoreError({ operation: "list", cause })),
        ),
      });
      return service;
    }),
  );

/** Open the configured store without preparing the Lab on ordinary turns. */
export const layer = Layer.unwrap(Effect.map(labDirectory, layerAt));

/** Bind this lookup to LearnSessionKinds at the application composition root. */
export const kindOf = (threadId: ThreadId) =>
  LearnSessionStore.pipe(
    Effect.flatMap((store) => store.get(threadId)),
    Effect.map((meta) => meta?.kind),
  );
