// Cases adapted from learnharness (AGPL-3.0-only) tests/content-recovery.test.ts and
// tests/fixtures/tool-rendering @ dc4c398.
import { describe, expect, it } from "vite-plus/test";
import { repairMathForDisplay, transformMathDelimiters } from "./mathDisplay";

const math = String.raw;

describe("repairMathForDisplay", () => {
  it("keeps native matrix rows, including rows that start with a letter", () => {
    for (const source of [
      math`For a $2\times2$ matrix, $\det\begin{bmatrix}a&b\\c&d\end{bmatrix}=ad-bc$.`,
      math`$J_F=\begin{pmatrix}2x&1\\y&x\end{pmatrix}$`,
      math`$\begin{cases}a&b\\beta&d\end{cases}$`,
      math`$\substack{a\\beta}$`,
    ]) {
      expect(repairMathForDisplay(source)).toBe(source);
    }
    const mixed = math`$\\lambda+\begin{pmatrix}a&b\\c&d\end{pmatrix}$`;
    expect(repairMathForDisplay(mixed)).toBe(mixed.replace(math`\\lambda`, math`\lambda`));
  });

  it("decodes consistently over-escaped environments by their factor", () => {
    for (const [source, expected] of [
      [
        math`$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$`,
        math`$\begin{pmatrix}a&b\\c&d\end{pmatrix}$`,
      ],
      [
        math`$\\begin{pmatrix}a&b\\\\\\nabla f&d\\end{pmatrix}$`,
        math`$\begin{pmatrix}a&b\\\nabla f&d\end{pmatrix}$`,
      ],
      [math`$\\substack{a\\\\beta}$`, math`$\substack{a\\beta}$`],
    ] as const) {
      expect(repairMathForDisplay(source)).toBe(expected);
      expect(repairMathForDisplay(expected)).toBe(expected);
    }
  });

  it("restores lost command prefixes only for known commands", () => {
    expect(repairMathForDisplay("$\nabla f$")).toBe(math`$\nabla f$`);
    expect(repairMathForDisplay("$a\to b$")).toBe(math`$a\to b$`);
    expect(repairMathForDisplay("$x+\ny$")).toBe("$x+\ny$");
    expect(repairMathForDisplay("$$\nx\t+\ty\n$$")).toBe("$$\nx\t+\ty\n$$");
    expect(repairMathForDisplay(math`$\nu+\neq$`)).toBe(math`$\nu+\neq$`);
  });

  it("recovers numeric percentages but keeps row breaks before comments", () => {
    expect(repairMathForDisplay(math`$50\\%+10\\%=60\\%$`)).toBe(math`$50\%+10\%=60\%$`);
    expect(repairMathForDisplay("$$\n" + math`p = 12.5\\%` + "\n$$")).toBe(
      "$$\n" + math`p = 12.5\%` + "\n$$",
    );
    const comment = "$60\\\\% explanation of this row\nx$";
    expect(repairMathForDisplay(comment)).toBe(comment);
  });

  it("decodes literal document escapes and frames display blocks", () => {
    const source = math`First.\n\nSecond: $\nabla f\neq0$.\n\n$$\n\frac{1}{2}\n$$`;
    expect(repairMathForDisplay(source)).toBe(
      "First.\n\nSecond: " + math`$\nabla f\neq0$.` + "\n\n$$\n" + math`\frac{1}{2}` + "\n$$",
    );
    const paths = math`Path C:\new\notes; symbols $\nu+\nabla f$.\n\nNext.`;
    expect(repairMathForDisplay(paths)).toBe(
      math`Path C:\new\notes; symbols $\nu+\nabla f$.` + "\n\nNext.",
    );
  });

  it("leaves code alone and never breaks parseable TeX", () => {
    const code = "```text\n\\(x\nabla\\)\n\\n\\n\n```\n`" + math`\n\n $60\\%$ \(x\)` + "`";
    expect(repairMathForDisplay(code)).toBe(code);
    expect(transformMathDelimiters(code)).toBe(code);
    expect(repairMathForDisplay(math`$x\\frac{a}$`)).toBe(math`$x\\frac{a}$`);
    for (const source of ["$\forall x,\theta+\to$", math`First.\n\n$$\nJ=\\frac{1}{2}+60\\%\n$$`]) {
      const once = repairMathForDisplay(source);
      expect(repairMathForDisplay(once)).toBe(once);
    }
  });
});
