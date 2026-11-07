import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { labDirectory } from "./labDirectory.ts";

it.effect.each([undefined, "", "   "])(
  "keeps the Lab inside the server base directory with override %s",
  (override) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "qa-lab-home-" });
      expect(
        yield* labDirectory.pipe(Effect.provide(ServerConfig.layerTest(baseDir, baseDir))),
      ).toBe(`${baseDir}/PhysicsLab`);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.HomeDirectory, "/real/home"),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown({ PHYSICS_LAB_DIR: override })),
        ),
      ),
    ),
);

it.effect("honors an explicit Lab directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "qa-lab-override-" });
    expect(yield* labDirectory.pipe(Effect.provide(ServerConfig.layerTest(baseDir, baseDir)))).toBe(
      "/explicit/lab",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ PHYSICS_LAB_DIR: "/explicit/lab" })),
      ),
    ),
  ),
);
