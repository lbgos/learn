import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";

/** Resolve the configured Lab without creating files or registering a project. */
export const labDirectory = Effect.gen(function* () {
  const { baseDir } = yield* ServerConfig;
  const path = yield* Path.Path;
  const labOverride = yield* Config.String("PHYSICS_LAB_DIR").pipe(Config.option);
  return Option.match(
    Option.filter(labOverride, (dir) => dir.trim() !== ""),
    {
      onNone: () => path.join(baseDir, "PhysicsLab"),
      onSome: (dir) => path.resolve(dir),
    },
  );
});
