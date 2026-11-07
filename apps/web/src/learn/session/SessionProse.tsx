import type { Root } from "mdast";
import type { Plugin } from "unified";
import { repairMathForDisplay, transformMathDelimiters } from "./mathDisplay";
import { Children } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import KatexMath from "~/components/KatexMath";
import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import { cn } from "~/lib/utils";
import { MATH_REMARK_PLUGINS } from "~/markdown-math";

function markdownComponents(inline: boolean): Components {
  return {
    p({ children }) {
      return inline ? <span>{children}</span> : <p>{children}</p>;
    },
    code({ className, children }) {
      if (className?.includes("math-inline") || className?.includes("math-display")) {
        const tex = Children.toArray(children).join("");
        const display = !inline && className.includes("math-display");
        return (
          <RenderErrorBoundary resetKeys={[tex, display]} fallback={<code>{tex}</code>}>
            <KatexMath tex={tex} display={display} />
          </RenderErrorBoundary>
        );
      }
      const text = Children.toArray(children).join("");
      // Block code ends in a newline. One block per line lets a wrapped line hang under its start.
      if (!inline && text.endsWith("\n")) {
        let offset = 0;
        const lines = text
          .slice(0, -1)
          .split("\n")
          .map((line) => {
            const start = offset;
            offset += line.length + 1;
            return (
              <span key={start} className="learn-prose-code-line">
                {line || " "}
              </span>
            );
          });
        return <code className={className}>{lines}</code>;
      }
      return <code className={className}>{children}</code>;
    },
    pre({ children }) {
      return inline ? (
        <span className="font-mono">{children}</span>
      ) : (
        // Wrapped, so a long line never hides past the column edge.
        <div className="learn-prose-code font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
          {children}
        </div>
      );
    },
    table({ children }) {
      return (
        <div className="learn-prose-table overflow-x-auto">
          <table>{children}</table>
        </div>
      );
    },
  };
}
const INLINE_COMPONENTS = markdownComponents(true);
const BLOCK_COMPONENTS = markdownComponents(false);
type TextNode = { readonly type: string; value?: string; readonly children?: TextNode[] };
const GROUP_SPACE = /(?<=\d) (?=\d{3}(?!\d))/g;
function joinDigitGroups(node: TextNode) {
  if (node.type === "text" && node.value) node.value = node.value.replace(GROUP_SPACE, "\u00A0");
  node.children?.forEach(joinDigitGroups);
}
/** Holds a grouped number such as "10 000" on one line; code and math keep their text. */
const remarkDigitGroups: Plugin<[], Root> = () => (tree) => joinDigitGroups(tree as TextNode);

// Tutors write `~3 digits` for "about"; only `~~text~~` strikes through.
const REMARK_PLUGINS = [
  [remarkGfm, { singleTilde: false }],
  ...MATH_REMARK_PLUGINS,
  remarkDigitGroups,
] satisfies Options["remarkPlugins"];

/** Load T3's math renderer directly so session cards skip its raw-TeX loading fallback. */
export function SessionProse({
  text,
  inline = false,
  className,
  streaming = false,
}: {
  readonly text: string;
  readonly inline?: boolean;
  readonly className?: string;
  /** New blocks fade in once as they arrive; see .learn-prose in index.css. */
  readonly streaming?: boolean;
}) {
  const Wrapper = inline ? "span" : "div";
  return (
    <Wrapper
      data-streaming={streaming || undefined}
      className={cn(
        inline
          ? "min-w-0 font-sans [overflow-wrap:anywhere]"
          : "learn-prose min-w-0 font-sans text-sm leading-6 [overflow-wrap:anywhere] [&_p+p]:mt-2 [&_pre]:overflow-x-auto",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={inline ? INLINE_COMPONENTS : BLOCK_COMPONENTS}
      >
        {transformMathDelimiters(repairMathForDisplay(text))}
      </ReactMarkdown>
    </Wrapper>
  );
}
