import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Config from "../config.ts";

export const EnvironmentName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/),
);
const BaseUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    } catch {
      return false;
    }
  }),
);
const Entry = Schema.Struct({
  name: EnvironmentName,
  baseUrl: BaseUrl,
  tokenRef: Schema.String.check(Schema.isPattern(/^remote-env-[a-zA-Z0-9_-]+$/)),
});
const Entries = Schema.Array(Entry);
const decodeEntries = Schema.decodeUnknownEffect(Schema.fromJsonString(Entries));
const decodeEntry = Schema.decodeEffect(Entry);
const encodeEntries = Schema.encodeEffect(Schema.fromJsonString(Entries));
export class RemoteConfigurationError extends Schema.TaggedError<RemoteConfigurationError>()(
  "RemoteConfigurationError",
  { reason: Schema.Literals(["config", "missing", "credential"]) },
) {
  override get message() {
    return `Remote environment configuration failed: ${this.reason}.`;
  }
}
export class Configuration extends Context.Service<
  Configuration,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly baseUrl: string }>,
      RemoteConfigurationError
    >;
    readonly resolve: (
      name: string,
    ) => Effect.Effect<
      { readonly baseUrl: string; readonly token: Redacted.Redacted<string> },
      RemoteConfigurationError
    >;
    readonly set: (input: {
      readonly name: string;
      readonly baseUrl: string;
      readonly token: Redacted.Redacted<string>;
    }) => Effect.Effect<void, RemoteConfigurationError>;
  }
>()("t3/remote/Configuration") {}
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const secrets = yield* Secrets.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const file = path.join(config.stateDir, "remote-envs.json");
  const read = fs.readFileString(file).pipe(
    Effect.flatMap(decodeEntries),
    Effect.filterOrFail(
      (entries) => new Set(entries.map((entry) => entry.name)).size === entries.length,
      () => new RemoteConfigurationError({ reason: "config" }),
    ),
    Effect.catchTags({
      PlatformError: (e) => (e.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(e)),
    }),
    Effect.mapError(() => new RemoteConfigurationError({ reason: "config" })),
  );
  return Configuration.of({
    list: read.pipe(
      Effect.map((entries) => entries.map(({ name, baseUrl }) => ({ name, baseUrl }))),
    ),
    resolve: Effect.fn("Configuration.resolve")(function* (name) {
      const entry = (yield* read).find((entry) => entry.name === name);
      if (!entry) return yield* new RemoteConfigurationError({ reason: "missing" });
      const bytes = yield* secrets
        .get(entry.tokenRef)
        .pipe(Effect.mapError(() => new RemoteConfigurationError({ reason: "credential" })));
      if (Option.isNone(bytes))
        return yield* new RemoteConfigurationError({ reason: "credential" });
      const token = new TextDecoder().decode(bytes.value).trim();
      if (!token || /[\r\n]/.test(token))
        return yield* new RemoteConfigurationError({ reason: "credential" });
      return { baseUrl: entry.baseUrl, token: Redacted.make(token) };
    }),
    set: Effect.fn("Configuration.set")((input) =>
      lock.withPermit(
        Effect.gen(function* () {
          const entry = yield* decodeEntry({
            name: input.name,
            baseUrl: input.baseUrl,
            tokenRef: `remote-env-${input.name}`,
          });
          const token = Redacted.value(input.token).trim();
          if (!token || /[\r\n]/.test(token))
            return yield* new RemoteConfigurationError({ reason: "credential" });
          const entries = yield* read;
          yield* secrets.set(entry.tokenRef, new TextEncoder().encode(token));
          const contents = yield* encodeEntries([
            ...entries.filter((e) => e.name !== entry.name),
            entry,
          ]);
          yield* writeFileStringAtomically({ filePath: file, contents }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
        }).pipe(Effect.mapError(() => new RemoteConfigurationError({ reason: "config" }))),
      ),
    ),
  });
});
export const layer = Layer.effect(Configuration, make);
