import { CHAT_MARKDOWN_REHYPE_PLUGINS } from "@t3tools/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { createIncrementalMarkdownPlugin } from "./markdown-incremental";
import { MATH_REMARK_PLUGINS } from "./markdown-math";

/** `code.language-math` is what the chat renderer turns into KaTeX; `pre` wraps display math. */
function render(source: string, incremental = false) {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        ...MATH_REMARK_PLUGINS,
        ...(incremental ? [createIncrementalMarkdownPlugin()] : []),
      ]}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {source}
    </ReactMarkdown>,
  );
}

const math = (html: string) =>
  [...html.matchAll(/<code class="language-math[^"]*">([^<]*)<\/code>/g)].map((match) => match[1]);

describe("chat math", () => {
  it("parses inline and display math", () => {
    expect(math(render("Energy is $E = mc^2$ here."))).toEqual(["E = mc^2"]);
    const display = render("Before\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter");
    expect(display).toContain("<pre><code");
    expect(math(display)).toEqual(["\\int_0^1 x\\,dx"]);
  });

  it("keeps underscores and asterisks inside math out of emphasis", () => {
    const html = render("Take $a_1 * b_2$ and $x_i$.");
    expect(math(html)).toEqual(["a_1 * b_2", "x_i"]);
    expect(html).not.toContain("<em>");
    // A word joiner keeps the period on the formula's line.
    expect(html).toContain("</code>\u2060.");
  });

  it("treats a paragraph of only $$...$$ as display math", () => {
    expect(render("$$E = mc^2$$")).toContain("<pre><code");
  });

  it("leaves dollar amounts alone", () => {
    for (const text of [
      "It costs $5 and $10 in total.",
      "Pay $5, then $ 10.",
      "From $20 to $30.",
      "A single $ sign.",
    ]) {
      const html = render(text);
      expect(math(html), text).toEqual([]);
      expect(html).toContain(text.replaceAll("&", "&amp;"));
    }
  });

  it("does not parse math inside code", () => {
    const html = render("Run `echo $x$` or:\n\n```sh\necho $a$ $b$\n```");
    expect(math(html)).toEqual([]);
    expect(html).toContain("echo $x$");
    expect(html).toContain("echo $a$ $b$");
  });

  it("keeps partial streaming text as text until the closer arrives", () => {
    expect(math(render("The energy is $E = m"))).toEqual([]);
    expect(render("The energy is $E = m")).toContain("$E = m");
    expect(math(render("The energy is $E = mc^2$"))).toEqual(["E = mc^2"]);
    // An unclosed display block is plain text, not an error or a swallowed document.
    const open = render("Intro\n\n$$\n\\frac{a}{b");
    expect(math(open)).toEqual([]);
    expect(open).toContain("\\frac{a}{b");
    expect(math(render("Intro\n\n$$\n\\frac{a}{b}\n$$"))).toEqual(["\\frac{a}{b}"]);
  });

  it("renders the same through the incremental parser", () => {
    const source =
      "# Title\n\n```ts\nconst a = 1;\n```\n\nThen $x^2$ and\n\n$$\ny_1\n$$\n\ncost $5 and $10";
    expect(render(source, true)).toEqual(render(source));
    expect(math(render(source, true))).toEqual(["x^2", "y_1"]);
  });
});
