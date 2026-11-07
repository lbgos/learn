import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PhysicsWorkspaceService from "./PhysicsWorkspaceService.ts";

const layer = (home: string) =>
  PhysicsWorkspaceService.layer.pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(
      ProjectEnrichmentService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: () => Effect.succeed(null),
            }),
            Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
              resolvePath: () => Effect.succeed(null),
              invalidate: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(home, home)),
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
  );

it.effect("creates the lab once and preserves learner files on concurrent repeated calls", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "physics-workspace-" });
    yield* Effect.gen(function* () {
      const workspace = yield* PhysicsWorkspaceService.PhysicsWorkspaceService;
      const projects = yield* ProjectService.ProjectService;
      const first = yield* workspace.ensureLab;
      assert.isTrue(first.created);
      assert.equal(first.workspaceRoot, path.join(home, "PhysicsLab"));
      const root = first.workspaceRoot;
      assert.isTrue(yield* fs.exists(path.join(root, ".git")));
      assert.isTrue(yield* fs.exists(path.join(root, "boards")));
      assert.isTrue(yield* fs.exists(path.join(root, "sims", "physics-sim.d.ts")));
      assert.equal(
        yield* fs.readFileString(path.join(root, "AGENTS.md")),
        yield* fs.readFileString(path.join(root, "CLAUDE.md")),
      );
      yield* fs.writeFileString(path.join(root, "sims", "pendulum.sim.js"), "learner edits\n");
      const repeated = yield* Effect.all([workspace.ensureLab, workspace.ensureLab], {
        concurrency: "unbounded",
      });
      for (const result of repeated) {
        assert.equal(result.projectId, first.projectId);
        assert.isFalse(result.created);
      }
      assert.equal(
        yield* fs.readFileString(path.join(root, "sims", "pendulum.sim.js")),
        "learner edits\n",
      );
      const snapshot = yield* projects.snapshot;
      assert.equal(snapshot.projects.filter((project) => project.id === first.projectId).length, 1);
    }).pipe(Effect.provide(layer(home)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refreshes marked instructions and preserves unmarked learner instructions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "physics-workspace-refresh-" });
    yield* Effect.gen(function* () {
      const workspace = yield* PhysicsWorkspaceService.PhysicsWorkspaceService;
      const first = yield* workspace.ensureLab;
      const agents = path.join(first.workspaceRoot, "AGENTS.md");
      const claude = path.join(first.workspaceRoot, "CLAUDE.md");
      const managed = yield* fs.readFileString(agents);
      assert.include(managed, "Evidence, numbers, examples");
      assert.notInclude(managed, "# Teach sessions");
      assert.notInclude(managed, "# Practice sessions");
      yield* fs.writeFileString(agents, "<!-- lbgos-learn:managed v0 -->\nOld managed guide\n");
      yield* fs.writeFileString(claude, "My own tutoring instructions.\n");
      const refreshed = yield* workspace.ensureLab;
      assert.equal(yield* fs.readFileString(agents), managed);
      assert.equal(yield* fs.readFileString(claude), "My own tutoring instructions.\n");
      assert.deepEqual(refreshed.unmanagedInstructionFiles, ["CLAUDE.md"]);
      assert.deepEqual((yield* workspace.ensureLab).unmanagedInstructionFiles, ["CLAUDE.md"]);
    }).pipe(Effect.provide(layer(home)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refreshes a byte-exact historical template but preserves its edited copy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "physics-workspace-legacy-" });
    yield* Effect.gen(function* () {
      const workspace = yield* PhysicsWorkspaceService.PhysicsWorkspaceService;
      const first = yield* workspace.ensureLab;
      const processes = yield* ProcessRunner.ProcessRunner;
      const legacy = yield* processes.run({
        command: "git",
        args: ["show", "df8e01a885:apps/server/src/physics/templates/tutor.md"],
        cwd: path.resolve(
          path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
          "../../../..",
        ),
        timeout: "5 seconds",
        maxOutputBytes: 128_000,
      });
      assert.equal(legacy.code, 0);
      const agents = path.join(first.workspaceRoot, "AGENTS.md");
      const claude = path.join(first.workspaceRoot, "CLAUDE.md");
      const managed = yield* fs.readFileString(agents);
      yield* fs.writeFileString(agents, legacy.stdout);
      yield* fs.writeFileString(claude, `${legacy.stdout}\nMy edits\n`);
      const refreshed = yield* workspace.ensureLab;
      assert.equal(yield* fs.readFileString(agents), managed);
      assert.equal(yield* fs.readFileString(claude), `${legacy.stdout}\nMy edits\n`);
      assert.deepEqual(refreshed.unmanagedInstructionFiles, ["CLAUDE.md"]);
    }).pipe(Effect.provide(layer(home)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("upgrades stock pre-caption and pre-inline APIs and preserves learner visual edits", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "physics-visual-upgrade-" });
    yield* Effect.gen(function* () {
      const workspace = yield* PhysicsWorkspaceService.PhysicsWorkspaceService;
      const { workspaceRoot } = yield* workspace.ensureLab;
      const api = path.join(workspaceRoot, "visuals/visual-api.d.ts");
      const example = path.join(workspaceRoot, "visuals/assignment.html");
      const current = yield* fs.readFileString(api);
      const preInline = current.slice(current.indexOf("interface LbgosVisualStep"));
      const legacy = preInline.replace(
        /  \/\*\* One or two short sentences per step:[\s\S]*?  captions: string\[\];\n/,
        "",
      );
      assert.notEqual(current, legacy);
      yield* fs.writeFileString(example, "My own animation");
      for (const stock of [legacy, preInline]) {
        yield* fs.writeFileString(api, stock);
        yield* workspace.ensureLab;
        assert.equal(yield* fs.readFileString(api), current);
      }
      assert.equal(yield* fs.readFileString(example), "My own animation");
      yield* fs.writeFileString(api, legacy + "// learner edit\n");
      yield* workspace.ensureLab;
      assert.equal(yield* fs.readFileString(api), legacy + "// learner edit\n");
    }).pipe(Effect.provide(layer(home)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
