import { describe, expect, it } from "vite-plus/test";

import { formatUnlistedModelName } from "./providerIconUtils";

describe("formatUnlistedModelName", () => {
  it("drops the provider route and spells the words", () => {
    expect(formatUnlistedModelName("opencode-go/deepseek-v4.1-flash")).toBe("DeepSeek V4.1 Flash");
    expect(formatUnlistedModelName("openrouter/z-ai/glm-5")).toBe("GLM 5");
  });

  it("keeps the known family formats", () => {
    expect(formatUnlistedModelName("openai/gpt-6.1-sol")).toBe("GPT-6.1-Sol");
    expect(formatUnlistedModelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
  });

  it("falls back to the slug when no name is left", () => {
    expect(formatUnlistedModelName("custom/")).toBe("custom/");
  });
});
