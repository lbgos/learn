/**
 * TeX in chat markdown: `$...$` inline and `$$...$$` display, parsed by remark-math and drawn by
 * KaTeX (see `components/MarkdownMath.tsx`). remark-math parses by token, so math never starts
 * inside code spans or fenced blocks. It also happily pairs the dollar signs of "$5 and $10", so
 * `guardMath` takes such pairs back and leaves them as the text the author wrote.
 */
import type { Root } from "mdast";
import type { Plugin } from "unified";
import remarkMath from "remark-math";

interface Node {
  type: string;
  value?: string;
  data?: unknown;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** The source text of `node`, or undefined when its position does not point at it. */
function sourceOf(node: Node, source: string | undefined): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (source === undefined || start === undefined || end === undefined) return undefined;
  return source.slice(start, end);
}

/**
 * Single-dollar math follows the pandoc rule: no space just inside either `$`, and the closing
 * `$` is not followed by a digit. `$$...$$` is always math.
 */
function isProseDollars(node: Node, raw: string | undefined, source: string | undefined): boolean {
  if (raw?.startsWith("$$")) return false;
  const value = node.value ?? "";
  if (value.length === 0 || /^\s|\s$/.test(value)) return true;
  const end = node.position?.end.offset;
  return end !== undefined && /\d/.test(source?.[end] ?? "");
}

/** An unclosed `$$` block is still streaming; it stays text until its closing fence arrives. */
function isClosedDisplay(raw: string): boolean {
  const lines = raw.split("\n");
  const opening = /^\s*(\${2,})/.exec(lines[0] ?? "")?.[1];
  const closing = /^\s*(\${2,})\s*$/.exec(lines.at(-1) ?? "")?.[1];
  return (
    lines.length > 1 &&
    opening !== undefined &&
    closing !== undefined &&
    closing.length >= opening.length
  );
}

/** What remark-math attaches to a `$$` block, so remark-rehype renders it as `pre > code`. */
function displayMath(value: string): Node {
  return {
    type: "math",
    value,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value }],
        },
      ],
    },
  };
}

function rewrite(node: Node, source: string | undefined): Node {
  switch (node.type) {
    case "inlineMath": {
      const raw = sourceOf(node, source);
      return isProseDollars(node, raw, source)
        ? { type: "text", value: raw ?? `$${node.value ?? ""}$` }
        : node;
    }
    case "math": {
      const raw = sourceOf(node, source);
      if (raw === undefined || isClosedDisplay(raw)) return node;
      // Some parsers open a display block on a one-line `$$...$$`; it is complete as written.
      const oneLine = /^\s*\$\$([^$\n]+)\$\$\s*$/.exec(raw)?.[1];
      return oneLine === undefined
        ? { type: "paragraph", children: [{ type: "text", value: raw }] }
        : displayMath(oneLine.trim());
    }
    case "code":
    case "inlineCode":
      return node;
  }
  if (!node.children) return node;
  const children = node.children.map((child) => rewrite(child, source));
  node.children = children;
  // A word joiner holds punctuation after a formula on the formula's line.
  children.forEach((child, index) => {
    const next = children[index + 1];
    if (
      child.type === "inlineMath" &&
      next?.type === "text" &&
      /^[.,;:!?)\]]/.test(next.value ?? "")
    )
      next.value = `\u2060${next.value}`;
  });
  const only = children[0];
  // A paragraph holding just `$$...$$` is a display equation, not a line of prose.
  if (
    node.type === "paragraph" &&
    node.children.length === 1 &&
    only?.type === "inlineMath" &&
    sourceOf(only, source)?.startsWith("$$")
  ) {
    return displayMath(only.value ?? "");
  }
  return node;
}

const guardMath: Plugin<[], Root> = () => (tree, file) => {
  rewrite(tree as Node, typeof file.value === "string" ? file.value : undefined);
};

/** Remark plugins for math; add them only to text that contains a `$`. */
export const MATH_REMARK_PLUGINS = [remarkMath, guardMath];
