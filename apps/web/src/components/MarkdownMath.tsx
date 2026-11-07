import KatexMath from "./KatexMath";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

/** A formula from chat markdown. Renders synchronously; keeps the source only as an error fallback. */
export function MarkdownMath({ tex, display }: { tex: string; display: boolean }) {
  const source = display ? <pre className="my-2 overflow-x-auto">{tex}</pre> : <code>{tex}</code>;
  return (
    <RenderErrorBoundary resetKeys={[tex, display]} fallback={source}>
      <KatexMath tex={tex} display={display} />
    </RenderErrorBoundary>
  );
}
