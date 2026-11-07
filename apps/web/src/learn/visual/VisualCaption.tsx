import { memo, type ReactNode } from "react";
import { MarkdownMath } from "~/components/MarkdownMath";

/** Captions are plain voiceover text with inline LaTeX, never executable visual markup. */
export const VisualCaption = memo(function VisualCaption({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(/\$([^$]+)\$|\\\(([\s\S]*?)\\\)/g)) {
    parts.push(text.slice(end, match.index));
    parts.push(<MarkdownMath key={match.index} tex={match[1] ?? match[2] ?? ""} display={false} />);
    end = match.index + match[0].length;
  }
  parts.push(text.slice(end));
  return parts;
});
