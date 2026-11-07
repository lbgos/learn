// Ported from learnharness (AGPL-3.0-only) tests/fuzzy.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import { fuzzyScore } from "./search.ts";

describe("fuzzyScore", () => {
  const fields = (id: string, name: string) => ["openrouter", id, name];

  it("matches across fields case-insensitively", () => {
    expect(
      fuzzyScore("GLM", ...fields("z-ai/glm-5.3-flash", "ZAI: GLM 5.3 Flash")) !== null,
    ).toBeTruthy();
    expect(
      fuzzyScore("flash", ...fields("z-ai/glm-5.3-flash", "ZAI: GLM 5.3 Flash")) !== null,
    ).toBeTruthy();
  });

  it("multi-token queries need every token to match somewhere", () => {
    expect(
      fuzzyScore("glm flash", ...fields("z-ai/glm-5.3-flash", "ZAI: GLM 5.3 Flash")) !== null,
    ).toBeTruthy();
    expect(fuzzyScore("glm qwen", ...fields("z-ai/glm-5.3-flash", "ZAI: GLM 5.3 Flash"))).toBe(
      null,
    );
  });

  it("ranks exact field equality above prefix above buried substring", () => {
    const exact = fuzzyScore("flash", "openrouter", "flash", "other"); // field === token
    const prefix = fuzzyScore("flash", "openrouter", "flash-2", "other"); // field startsWith
    const buried = fuzzyScore("flash", "openrouter", "z-ai/glm-5.3-flash", "other");
    expect(exact !== null && prefix !== null && buried !== null).toBeTruthy();
    expect(exact! > prefix! && prefix! > buried!, `${exact} > ${prefix} > ${buried}`).toBeTruthy();
  });

  it("rewards whole-query contiguity in a single field", () => {
    const split = fuzzyScore("glm flash", ...fields("z-ai/glm-5.3-flash", "x")); // two fields, no contiguity
    const joined = fuzzyScore("glm 5.3", ...fields("z-ai/glm-5.3-flash", "x")); // contiguous in the id
    expect(split !== null && joined !== null).toBeTruthy();
    expect(joined! > split!, `${joined} > ${split}`).toBeTruthy();
  });

  it("empty query matches everything at score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });
});
