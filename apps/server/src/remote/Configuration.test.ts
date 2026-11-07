import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Config from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Configuration from "./Configuration.ts";
const services = Configuration.layer.pipe(
  Layer.provide(Secrets.layer),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "t3-remote-config-" })),
  Layer.provideMerge(NodeServices.layer),
);
it.effect("keeps tokens in 0600 secrets, reloads config, and rotates credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const configuration = yield* Configuration.Configuration;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      expect(yield* configuration.list).toEqual([]);
      yield* configuration.set({
        name: "remote",
        baseUrl: "https://remote.example",
        token: Redacted.make("fake-first"),
      });
      expect(yield* configuration.list).toEqual([
        { name: "remote", baseUrl: "https://remote.example" },
      ]);
      const stored = yield* fs.readFileString(`${config.stateDir}/remote-envs.json`);
      expect(stored).not.toContain("fake-first");
      expect(stored).toContain('"tokenRef":"remote-env-remote"');
      expect((yield* fs.stat(`${config.secretsDir}/remote-env-remote.bin`)).mode & 0o777).toBe(
        0o600,
      );
      yield* configuration.set({
        name: "remote",
        baseUrl: "https://remote.example",
        token: Redacted.make("fake-second"),
      });
      expect(Redacted.value((yield* configuration.resolve("remote")).token)).toBe("fake-second");
      yield* fs.writeFileString(`${config.stateDir}/remote-envs.json`, "[]");
      expect(yield* configuration.resolve("remote").pipe(Effect.flip)).toMatchObject({
        reason: "missing",
      });
    }).pipe(Effect.provide(services)),
  ),
);
it.effect("refuses unsafe URLs, names, duplicate entries and invalid token input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const configuration = yield* Configuration.Configuration;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      for (const [name, baseUrl, token] of [
        ["../escape", "https://remote.example", "fake"],
        ["remote", "ftp://remote.example", "fake"],
        ["remote", "https://user:@remote.example", "fake"],
        ["remote", `https://remote.example?${new URLSearchParams({ token: "fixture" })}`, "fake"],
        ["remote", "https://remote.example", "a\nb"],
        ["remote", "https://remote.example", ""],
      ] as const) {
        expect(
          (yield* configuration
            .set({ name, baseUrl, token: Redacted.make(token) })
            .pipe(Effect.flip))._tag,
        ).toBe("RemoteConfigurationError");
      }
      yield* fs.writeFileString(
        `${config.stateDir}/remote-envs.json`,
        '[{"name":"remote","baseUrl":"https://remote.example","tokenRef":"remote-env-remote"},{"name":"remote","baseUrl":"https://remote.example","tokenRef":"remote-env-remote"}]',
      );
      expect((yield* configuration.list.pipe(Effect.flip)).reason).toBe("config");
    }).pipe(Effect.provide(services)),
  ),
);
