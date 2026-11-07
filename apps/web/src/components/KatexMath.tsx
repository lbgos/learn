import katex from "katex";
import "katex/dist/katex.min.css";
import { memo } from "react";

const CACHE_LIMIT = 200;
const rendered = new Map<string, string>();

/** A streaming message re-renders every formula on every token, so results are memoized. */
function renderTex(tex: string, display: boolean): string {
  const key = `${display ? "d" : "i"}:${tex}`;
  const cached = rendered.get(key);
  if (cached !== undefined) return cached;
  const html = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    strict: "ignore",
    trust: false,
  });
  if (rendered.size >= CACHE_LIMIT) rendered.delete(rendered.keys().next().value!);
  rendered.set(key, html);
  return html;
}

/** Shared synchronous renderer for chat formulas and session prose. */
function KatexMath({ tex, display }: { tex: string; display: boolean }) {
  const html = renderTex(tex, display);
  return display ? (
    <div
      className="my-2 overflow-x-auto overflow-y-hidden"
      data-math="display"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <span data-math="inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

export default memo(KatexMath);
