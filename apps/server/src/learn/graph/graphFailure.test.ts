import { LearnGraphError, TextGenerationError } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { LearnStructuredError } from "../LearnStructuredGeneration.ts";
import { graphFailure } from "./graphFailure.ts";

it("reports a typed provider failure without exposing provider diagnostics", () => {
  const cause = new LearnStructuredError({
    role: "extraction",
    label: "graph:test",
    attempts: 1,
    cause: new TextGenerationError({ operation: "test", detail: "private provider diagnostics" }),
  });
  expect(
    graphFailure(new LearnGraphError({ operation: "extract", reason: "generation", cause })),
  ).toEqual({
    status: 502,
    message:
      "Graph extraction could not complete the model request. Check the extraction model in Settings > Learning, then try again.",
  });
});
it("reports validation exhaustion and leaves unrelated failures alone", () => {
  const cause = new LearnStructuredError({
    role: "audit",
    label: "graph:test",
    attempts: 2,
    problems: ["Unknown id"],
  });
  expect(
    graphFailure(new LearnGraphError({ operation: "audit", reason: "generation", cause }))?.message,
  ).toContain("after 2 attempts");
  expect(graphFailure(new LearnGraphError({ operation: "read", reason: "io" }))).toBeUndefined();
});

it("identifies a model timeout without suggesting a settings change", () => {
  const cause = new LearnStructuredError({
    role: "extraction",
    label: "graph:test",
    attempts: 1,
    cause: new TextGenerationError({
      operation: "extract",
      detail: "Codex CLI request timed out.",
    }),
  });
  expect(
    graphFailure(new LearnGraphError({ operation: "extract", reason: "generation", cause })),
  ).toEqual({
    status: 504,
    message: "Graph extraction timed out waiting for the model. Try again.",
  });
});
