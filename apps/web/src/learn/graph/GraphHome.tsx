// Ported from learnharness (AGPL-3.0-only) components/graph-view.tsx @ c549494.
import { useEffect, useLayoutEffect, useRef } from "react";
import { observeResize } from "../../lib/observeResize";
import { GraphView } from "./graph-view.tsx";
import { useGraphSelectionStore } from "./selection";

/** Full-bleed graph above the home page's native overlaid composer. */
export function GraphHome({ kind = "teach" }: { readonly kind?: "teach" | "practice" }) {
  const rootRef = useRef<HTMLElement>(null);
  const clearSelection = useGraphSelectionStore((state) => state.clear);
  useEffect(() => clearSelection, [clearSelection]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let parent = root.parentElement;
    let composer: HTMLElement | null = null;
    while (parent && !composer) {
      composer = parent.querySelector<HTMLElement>('[data-chat-composer-overlay="true"]');
      parent = parent.parentElement;
    }
    if (!composer) return;
    const overlay = composer;
    const reserveComposer = () => {
      root.style.paddingBottom = `${Math.max(0, root.getBoundingClientRect().bottom - overlay.getBoundingClientRect().top)}px`;
    };
    reserveComposer();
    return observeResize([root, overlay], reserveComposer);
  }, []);
  return (
    <main
      ref={rootRef}
      aria-label="Learning graph"
      className="relative flex h-full min-h-0 w-full flex-1 flex-col bg-background text-foreground"
    >
      <div className="relative min-h-0 flex-1">
        <GraphView key={kind} />
      </div>
    </main>
  );
}
