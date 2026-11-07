import { labDirectory } from "./labDirectory.ts";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  pendulumSim,
  visualApiTypes,
  assignmentVisual,
  physicsSimTypes,
  tutorInstructions,
  previousTutorTemplateSha256,
  previousVisualTemplateSha256,
} from "./templates/index.ts";

export class PhysicsWorkspaceError extends Schema.TaggedError<PhysicsWorkspaceError>()(
  "PhysicsWorkspaceError",
  {
    operation: Schema.Literals([
      "create-directory",
      "write-template",
      "inspect-git",
      "init-git",
      "allocate-id",
      "register-project",
    ]),
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not prepare Physics Lab during ${this.operation}.`;
  }
}

export class PhysicsWorkspaceService extends Context.Service<
  PhysicsWorkspaceService,
  {
    /** Refreshes managed instructions, preserves learner files and registers the Lab project. */
    readonly ensureLab: Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly created: boolean;
        readonly unmanagedInstructionFiles: readonly string[];
      },
      PhysicsWorkspaceError
    >;
  }
>()("t3/physics/PhysicsWorkspaceService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const locks = yield* KeyedLock.make<string>();
  const workspaceRoot = yield* labDirectory;

  const ensureLab = Effect.gen(function* () {
    for (const relative of ["", "sims", "boards", "visuals"]) {
      yield* fs
        .makeDirectory(path.join(workspaceRoot, relative), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PhysicsWorkspaceError({ operation: "create-directory", workspaceRoot, cause }),
          ),
        );
    }
    const files = [
      ["AGENTS.md", tutorInstructions],
      ["CLAUDE.md", tutorInstructions],
      ["sims/pendulum.sim.js", pendulumSim],
      ["sims/physics-sim.d.ts", physicsSimTypes],
      ["visuals/visual-api.d.ts", visualApiTypes],
      ["visuals/assignment.html", assignmentVisual],
    ] as const;
    const unmanagedInstructionFiles: string[] = [];
    for (const [relative, content] of files) {
      const target = path.join(workspaceRoot, relative);
      const instruction = relative === "AGENTS.md" || relative === "CLAUDE.md";
      const exists = yield* fs
        .exists(target)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PhysicsWorkspaceError({ operation: "write-template", workspaceRoot, cause }),
          ),
        );
      if (exists && (instruction || previousVisualTemplateSha256[relative])) {
        const previous = yield* fs
          .readFileString(target)
          .pipe(
            Effect.mapError(
              (cause) =>
                new PhysicsWorkspaceError({ operation: "write-template", workspaceRoot, cause }),
            ),
          );
        const bytes = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(previous))
          .pipe(
            Effect.mapError(
              (cause) =>
                new PhysicsWorkspaceError({ operation: "write-template", workspaceRoot, cause }),
            ),
          );
        const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (
          (instruction &&
            (previous.includes("<!-- lbgos-learn:managed") ||
              previousTutorTemplateSha256.includes(digest))) ||
          previousVisualTemplateSha256[relative]?.includes(digest)
        ) {
          if (previous !== content)
            yield* fs.writeFileString(target, content).pipe(
              Effect.mapError(
                (cause) =>
                  new PhysicsWorkspaceError({
                    operation: "write-template",
                    workspaceRoot,
                    cause,
                  }),
              ),
            );
        } else if (instruction) unmanagedInstructionFiles.push(relative);
        continue;
      }
      // Exclusive creation preserves learner sims and declaration files.
      yield* fs.writeFileString(target, content, { flag: "wx" }).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "AlreadyExists"
              ? Effect.void
              : Effect.fail(
                  new PhysicsWorkspaceError({ operation: "write-template", workspaceRoot, cause }),
                ),
        }),
      );
    }
    const hasGit = yield* fs
      .exists(path.join(workspaceRoot, ".git"))
      .pipe(
        Effect.mapError(
          (cause) => new PhysicsWorkspaceError({ operation: "inspect-git", workspaceRoot, cause }),
        ),
      );
    if (!hasGit) {
      const result = yield* processes
        .run({
          command: "git",
          args: ["init"],
          cwd: workspaceRoot,
          timeout: "15 seconds",
          maxOutputBytes: 16_384,
        })
        .pipe(
          Effect.mapError(
            (cause) => new PhysicsWorkspaceError({ operation: "init-git", workspaceRoot, cause }),
          ),
        );
      if (result.code !== 0 || result.timedOut) {
        return yield* new PhysicsWorkspaceError({
          operation: "init-git",
          workspaceRoot,
          cause: result,
        });
      }
    }
    const id = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(
          (cause) => new PhysicsWorkspaceError({ operation: "allocate-id", workspaceRoot, cause }),
        ),
      );
    const bootstrapped = yield* projects
      .bootstrap({
        commandId: CommandId.make(`physics-lab:${id}`),
        projectId: ProjectId.make(id),
        title: "Physics Lab",
        workspaceRoot,
      })
      .pipe(
        Effect.catchTags({
          ProjectConflictError: (conflict) =>
            Effect.succeed({ project: { id: conflict.conflictingProjectId }, created: false }),
        }),
        Effect.mapError(
          (cause) =>
            new PhysicsWorkspaceError({ operation: "register-project", workspaceRoot, cause }),
        ),
      );
    return {
      projectId: bootstrapped.project.id,
      workspaceRoot,
      created: bootstrapped.created,
      unmanagedInstructionFiles,
    };
  });

  return PhysicsWorkspaceService.of({ ensureLab: locks.withLock(workspaceRoot, ensureLab) });
});

export const layer = Layer.effect(PhysicsWorkspaceService, make);
