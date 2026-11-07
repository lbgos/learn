import { LearnRole } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as LearnComposerDefault from "./LearnComposerDefault.ts";
import * as LearnModelRouter from "./LearnModelRouter.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

export class LearnStructuredError extends Schema.TaggedError<LearnStructuredError>()(
  "LearnStructuredError",
  {
    role: LearnRole,
    label: Schema.String,
    attempts: Schema.Int,
    problems: Schema.optionalKey(Schema.Array(Schema.String)),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Learning ${this.role} '${this.label}' failed after ${this.attempts} attempt(s)${this.problems?.length ? `: ${this.problems.join("; ")}` : "."}`;
  }
}

export interface StructuredRunInput<S extends Schema.Top> {
  readonly role: LearnRole;
  readonly label: string;
  readonly prompt: string;
  readonly schema: S;
  readonly validate?: (value: S["Type"]) => ReadonlyArray<string>;
  readonly maxAttempts?: number;
}

export class LearnStructuredGeneration extends Context.Service<
  LearnStructuredGeneration,
  {
    readonly run: <S extends Schema.Top>(
      input: StructuredRunInput<S>,
    ) => Effect.Effect<S["Type"], LearnStructuredError, S["DecodingServices"]>;
  }
>()("t3/learn/LearnStructuredGeneration") {}

// Deliberately shared across all layer instances: the budget belongs to the process.
const backgroundCalls = Semaphore.makeUnsafe(2);
const Attempts = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const make = Effect.gen(function* () {
  const router = yield* LearnModelRouter.LearnModelRouter;
  const composerDefault = yield* LearnComposerDefault.LearnComposerDefault;
  const generation = yield* TextGeneration.TextGeneration;
  const fs = yield* FileSystem.FileSystem;
  const run: LearnStructuredGeneration["Service"]["run"] = (input) =>
    Effect.suspend(() => {
      let attempts = 0;
      const execute = Effect.gen(function* () {
        const maxAttempts = yield* Schema.decodeEffect(Attempts)(input.maxAttempts ?? 2);
        // An unset chain lands on the composer default, as Settings → Learning shows it.
        const modelSelection = yield* router.resolve(input.role).pipe(
          Effect.catchTags({
            LearnRouteUnavailable: (error) =>
              error.reason === "unset"
                ? composerDefault.get.pipe(
                    Effect.filterOrFail(
                      (selection) => selection !== undefined,
                      () => error,
                    ),
                  )
                : Effect.fail(error),
          }),
        );
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "lbgos-learn-structured-" });
        return yield* backgroundCalls.withPermits(1)(
          Effect.gen(function* () {
            let problems: ReadonlyArray<string> = [];
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              attempts = attempt;
              yield* Effect.logInfo("Learning structured generation attempt", {
                role: input.role,
                label: input.label,
                attempt,
                instanceId: modelSelection.instanceId,
                model: modelSelection.model,
              });
              const prompt =
                problems.length === 0
                  ? input.prompt
                  : `${input.prompt}\n\nYour previous submission was rejected:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nSubmit a corrected result.`;
              const result = yield* generation
                .generateStructured({
                  modelSelection,
                  cwd,
                  prompt,
                  outputSchema: input.schema,
                  operation: input.label,
                })
                .pipe(Effect.result);
              if (result._tag === "Failure") {
                // A provider failure cannot be corrected by another prompt. Retry only validation.
                return yield* new LearnStructuredError({
                  role: input.role,
                  label: input.label,
                  attempts,
                  cause: result.failure,
                });
              }
              problems = yield* Effect.try(() => input.validate?.(result.success) ?? []);
              if (problems.length === 0) return result.success;
              if (attempt === maxAttempts)
                return yield* new LearnStructuredError({
                  role: input.role,
                  label: input.label,
                  attempts,
                  problems,
                });
            }
            return yield* new LearnStructuredError({
              role: input.role,
              label: input.label,
              attempts,
            });
          }),
        );
      }).pipe(Effect.scoped);
      return execute.pipe(
        Effect.mapError((cause) =>
          Schema.is(LearnStructuredError)(cause)
            ? cause
            : new LearnStructuredError({
                role: input.role,
                label: input.label,
                attempts,
                cause,
              }),
        ),
      );
    });
  return LearnStructuredGeneration.of({ run });
});

export const layer = Layer.effect(LearnStructuredGeneration, make);
