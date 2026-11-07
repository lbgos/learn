import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SessionProse } from "./SessionProse";

const tex = String.raw`\nabla f(x) \in \mathbb{R}^{m \times n}`;

describe("session math display", () => {
  it("repairs doubled commands in questions, options and answers without changing the source", () => {
    const source = `$${tex.replaceAll("\\", "\\\\")}$`;
    for (const inline of [false, true]) {
      const markup = renderToStaticMarkup(<SessionProse text={source} inline={inline} />);
      expect(markup).toContain(`encoding="application/x-tex">${tex}</annotation>`);
      expect(markup).not.toContain("katex-error");
      expect(source).toContain(String.raw`\\nabla`);
    }
  });

  it("renders the saved pendulum problem as paragraphs and inline units in the panel and rows", () => {
    const source =
      "A pendulum has a string of length $L = 1.00\\\\ \\\\text{m}$ and a $0.50\\\\ \\\\text{kg}$ bob. It is pulled $8^\\\\circ$ to the side and released from rest, with $g = 9.81\\\\ \\\\text{m/s}^2$.\\n\\n**(a)** How long after release does the bob first get back to the point it was released from?\\n\\n**(b)** The bob is swapped for a $2.0\\\\ \\\\text{kg}$ one and released from $4^\\\\circ$. Does your answer to (a) change? If it does, by how much?";
    for (const inline of [false, true]) {
      const markup = renderToStaticMarkup(<SessionProse text={source} inline={inline} />);
      expect(markup).toContain("<strong>(a)</strong>");
      expect(markup).toContain("<strong>(b)</strong>");
      expect(markup).toContain('encoding="application/x-tex">L = 1.00\\ \\text{m}</annotation>');
      expect(markup).not.toContain("katex-error");
      expect(markup).not.toContain('class="mspace newline"');
      expect(markup).not.toContain(String.raw`\n`);
      if (!inline) expect(markup.match(/<p>/g)).toHaveLength(3);
    }
    const units = renderToStaticMarkup(
      <SessionProse text={String.raw`$1.00\,\mathrm{m}$ and $0.50\,\mathrm{kg}$`} />,
    );
    expect(units).toContain('encoding="application/x-tex">1.00\\,\\mathrm{m}</annotation>');
    expect(units).not.toContain('class="mspace newline"');
    expect(
      renderToStaticMarkup(<SessionProse text={String.raw`Code: ` + "`" + String.raw`\n` + "`"} />),
    ).toContain(String.raw`<code>\n</code>`);
  });

  it("keeps a grouped number on one line outside code", () => {
    const grouped = renderToStaticMarkup(
      <SessionProse text={"About 10 000 values, `1 000` in code"} />,
    );
    expect(grouped).toContain("10\u00A0000");
    expect(grouped).toContain("<code>1 000</code>");
  });

  it("renders a tutor's GFM table with math cells, approximate tildes and escaped pipes", () => {
    const source = [
      "**The actual difference:**",
      "",
      "| | sign | exponent | mantissa | largest number | accuracy |",
      "|---|---|---|---|---|---|",
      "| FP16 | 1 | 5 | 10 | $65{,}504$ | ~3 digits |",
      String.raw`| BF16 | 1 | 8 | 7 | $\approx 3.4 \times 10^{38}$ | ~2–3 digits |`,
      String.raw`| FP32 | 1 | 8 | 23 | $\approx 3.4 \times 10^{38}$ | ~7 digits |`,
      String.raw`| FP8 (E4M3 \| E5M2) | 1 | 4 \| 5 | 3 \| 2 | 448 \| 57,344 | ~1 digit |`,
      "",
      'BF stands for **"Brain Float."** FP16 keeps ~3 digits, BF16 only ~2.',
    ].join("\n");
    const markup = renderToStaticMarkup(<SessionProse text={source} />);
    // A math cell reads as its TeX source.
    const cells = (tag: "th" | "td") =>
      [...markup.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, "g"))].map(([, cell]) => {
        const tex = /encoding="application\/x-tex">(.*?)<\/annotation>/.exec(cell!)?.[1];
        return tex === undefined ? cell : `$${tex}$`;
      });
    expect(cells("th")).toEqual(["", "sign", "exponent", "mantissa", "largest number", "accuracy"]);
    expect(cells("td")).toHaveLength(24);
    expect(cells("td").slice(6, 12)).toEqual([
      "BF16",
      "1",
      "8",
      "7",
      String.raw`$\approx 3.4 \times 10^{38}$`,
      "~2–3 digits",
    ]);
    expect(cells("td").slice(18)).toEqual([
      "FP8 (E4M3 | E5M2)",
      "1",
      "4 | 5",
      "3 | 2",
      "448 | 57,344",
      "~1 digit",
    ]);
    expect(markup).toContain(
      "<p>BF stands for <strong>&quot;Brain Float.&quot;</strong> FP16 keeps ~3 digits, BF16 only ~2.</p>",
    );
    expect(markup).not.toContain("<del>");
    expect(markup).not.toContain("|---");
    expect(markup).not.toContain("katex-error");
  });

  it("preserves code and matrix row breaks, and reads legacy delimiters", () => {
    const matrix = String.raw`\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}`;
    const markup = renderToStaticMarkup(<SessionProse text={`$$\n${matrix}\n$$`} />);
    expect(markup).toContain(matrix.replaceAll("&", "&amp;"));
    expect(markup).not.toContain("katex-error");
    const code = renderToStaticMarkup(<SessionProse text={"`$" + tex + "$`"} />);
    expect(code).not.toContain("katex-mathml");
    expect(renderToStaticMarkup(<SessionProse text={"```\na\n\nb\n```"} />)).toContain(
      '<span class="learn-prose-code-line">a</span><span class="learn-prose-code-line"> </span><span class="learn-prose-code-line">b</span>',
    );
    const legacy = renderToStaticMarkup(<SessionProse text={String.raw`Value \(\pi\)`} />);
    expect(legacy).toContain('encoding="application/x-tex">\\pi</annotation>');
  });
});
