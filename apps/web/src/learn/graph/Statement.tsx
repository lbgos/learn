import ReactMarkdown, { type Components } from "react-markdown";
import { MATH_REMARK_PLUGINS } from "../../markdown-math";
import { MarkdownMath } from "../../components/MarkdownMath";

const components: Components = {
  code: ({ children: content, className }) =>
    className?.includes("language-math") ? (
      <MarkdownMath tex={String(content).trimEnd()} display={className.includes("math-display")} />
    ) : (
      <code>{content}</code>
    ),
};

export function Statement({ children }: { children: string }) {
  return (
    <div className="text-xs leading-relaxed text-muted-foreground break-words">
      <ReactMarkdown remarkPlugins={MATH_REMARK_PLUGINS} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
