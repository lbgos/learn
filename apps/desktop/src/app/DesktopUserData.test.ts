import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["physics-code-legacy", "Physics Code (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "physics-code");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "Physics Code (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([true, false])(
  "ignores installed T3 Code profiles in development=%s",
  (isDevelopment) =>
    Effect.gen(function* () {
      const result = yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment,
        platform: "win32",
      });
      assert.equal(result, `/profiles/${isDevelopment ? "physics-code-dev" : "physics-code"}`);
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (path) => Effect.succeed(path.includes("T3 Code") || path.includes("t3code")),
          readFileString: () => Effect.die("lbgos learn must not read T3 Code state"),
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
);
