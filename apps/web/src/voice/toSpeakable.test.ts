import { describe, expect, it } from "vite-plus/test";
import { isLikelyEnglish, toSpeakable } from "./toSpeakable";

describe("toSpeakable", () => {
  it("keeps sentences and link text while removing markdown", () => {
    expect(
      toSpeakable(
        "## The **pendulum**\n\n- Read [the guide](https://example.com).\n> It is *simple*.",
      ),
    ).toBe("The pendulum Read the guide. It is simple.");
    expect(
      toSpeakable(
        "| | sign | largest number |\n|---|:-:|---:|\n| BF16 | 1 | $\\approx 3.4 \\times 10^{38}$ |\n| FP8 | 1 | 448 \\| 57,344 |",
      ),
    ).toBe("sign, largest number. BF16, 1. FP8, 1, 448 | 57,344.");
  });
  it("removes fenced and indented code while keeping inline prose", () => {
    expect(
      toSpeakable("Before.\n```ts\nconst period = 2;\n```\nAfter `this`.\n    secretCode();"),
    ).toBe("Before. After this.");
    expect(toSpeakable("Before.\n~~~python\nx = 1\n~~~\nAfter.")).toBe("Before. After.");
    expect(toSpeakable("Before.\n```js\nunfinished")).toBe("Before.");
  });
  it("replaces inline and display LaTeX with short pauses", () => {
    expect(toSpeakable("Period $T=2\\pi$ depends on $$L/g$$ and \\(x^2\\) then \\[y=1\\].")).toBe(
      "Period , depends on , and , then , .",
    );
  });
  it("decodes common entities and strips reference syntax and task marks", () => {
    expect(
      toSpeakable("- [x] Read [this][guide] &amp; listen.\n[guide]: https://example.com"),
    ).toBe("Read this & listen.");
  });
  it("preserves escaped dollar amounts", () => {
    expect(toSpeakable("It costs \\$5.")).toBe("It costs $5.");
  });
});

describe("isLikelyEnglish", () => {
  it.each(["A pendulum depends on its length.", "It takes 2π seconds.", "", "Café."])(
    "allows %s",
    (text) => expect(isLikelyEnglish(text)).toBe(true),
  );
  it.each(["Привіт", "Русский", "中文", "日本語", "こんにちは", "한국어", "English and Україна"])(
    "refuses %s",
    (text) => expect(isLikelyEnglish(text)).toBe(false),
  );
});
