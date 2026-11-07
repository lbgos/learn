import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  teachInstructions,
  practiceInstructions,
} from "../../../../../packages/learn/src/tutor/instructions.ts";
import { tutorInstructions } from "./index.ts";

const words = (text: string) => text.trim().split(/\s+/).length;

it.effect("ships a generated shared core within the per-kind prompt budgets", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* path.fromFileUrl(new URL("./tutor.md", import.meta.url));
    expect(tutorInstructions).toBe(yield* fs.readFileString(source));
    expect(tutorInstructions).toContain("lbgos-learn:managed v1");
    // Pacing is the first section every provider reads.
    expect(tutorInstructions.match(/^## .+$/m)?.[0]).toBe("## Turn rules");
    expect(tutorInstructions).toContain("AGPL-3.0-only");
    expect(tutorInstructions).toContain("Evidence, numbers, examples");
    expect(tutorInstructions).toContain("## Visuals, sims and the board");
    expect(tutorInstructions).toContain("call `transcribe_youtube` with the URL");
    expect(tutorInstructions).toContain("citing timestamps");
    expect(tutorInstructions).not.toContain("youtube_captions");
    expect(tutorInstructions).not.toContain("# Teach sessions");
    expect(tutorInstructions).not.toContain("# Practice sessions");
    expect(words(tutorInstructions)).toBeLessThanOrEqual(1135);
    expect(words(tutorInstructions + teachInstructions)).toBeLessThanOrEqual(2200);
    expect(words(tutorInstructions + practiceInstructions)).toBeLessThanOrEqual(1900);
  }).pipe(Effect.provide(NodeServices.layer)),
);
