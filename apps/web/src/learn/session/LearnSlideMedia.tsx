// What a tutor run showed (an HTML explainer, a sim, a step animation, board items) on the reader
// slide the learner uses it from. Sims and animations pause off-screen and behind Settings.
// Their notes to the tutor use a `#reader` key, so the side panel's copy keeps its own.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PanelRightOpenIcon } from "lucide-react";
import { lazy, Suspense, use, useEffect, useRef, useState, type RefObject } from "react";
import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
import { HtmlRenderFrame } from "~/components/chat/HtmlRenderFrame";
import { BoardItemsImage, PhysicsTimelineCard } from "~/components/physics/PhysicsTimelineCards";
import { Button } from "~/components/ui/button";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { simContextKey, visualContextKey } from "~/physics/modelContext";
import type { LearnSlideMedia } from "./slides";

const SimulationPanel = lazy(() =>
  import("~/components/physics/SimulationPanel").then((module) => ({
    default: module.SimulationPanel,
  })),
);
const VisualPanel = lazy(() =>
  import("~/learn/visual/VisualPanel").then((module) => ({ default: module.VisualPanel })),
);

// Tall enough for a sim's view, transport and parameters; short enough to leave the question in
// sight on a phone.
const LIVE_BOX = "h-[min(32rem,65svh)] min-h-72 w-full";

export function LearnSlideMediaList({
  media,
  threadRef,
}: {
  readonly media: readonly LearnSlideMedia[];
  readonly threadRef: ScopedThreadRef | null;
}) {
  if (media.length === 0 || threadRef === null) return null;
  return (
    <div className="space-y-6">
      {media.map((entry) =>
        entry.kind === "html-render" ? (
          <HtmlRenderFrame
            key={entry.id}
            environmentId={threadRef.environmentId}
            threadRef={threadRef}
            htmlRender={entry.htmlRender}
          />
        ) : (
          <SlideMediaItem key={entry.id} entry={entry} threadRef={threadRef} />
        ),
      )}
    </div>
  );
}

function SlideMediaItem({
  entry,
  threadRef,
}: {
  readonly entry: Extract<LearnSlideMedia, { readonly kind: "physics" }>;
  readonly threadRef: ScopedThreadRef;
}) {
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box);
  const backgroundThread = use(BackgroundThreadContext);
  const projectId = useThreadShell(threadRef)?.projectId;
  const { physics } = entry;
  const active = inView && !backgroundThread;

  if (physics.kind === "board") {
    if (physics.board.createdIds.length === 0)
      return <PhysicsTimelineCard result={physics} threadRef={threadRef} />;
    return (
      <div className="space-y-2">
        <BoardItemsImage
          board={physics.board}
          threadRef={threadRef}
          className="w-full [&>svg]:h-auto [&>svg]:max-h-[60svh] [&>svg]:w-full"
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            useRightPanelStore.getState().openWhiteboard(threadRef, physics.board.board)
          }
        >
          <PanelRightOpenIcon aria-hidden />
          Open board
        </Button>
      </div>
    );
  }
  if ((physics.kind === "sim" && !physics.sim.ok) || projectId === undefined)
    return <PhysicsTimelineCard result={physics} threadRef={threadRef} />;
  return (
    <div ref={box} className={LIVE_BOX}>
      <Suspense fallback={null}>
        {physics.kind === "sim" ? (
          <SimulationPanel
            threadRef={threadRef}
            threadStarted
            projectId={projectId}
            path={physics.sim.path}
            active={active}
            contextKey={`${simContextKey(physics.sim.path)}#reader`}
          />
        ) : (
          <VisualPanel
            threadRef={threadRef}
            threadStarted
            projectId={projectId}
            path={physics.visual.path}
            initialStep={physics.visual.step}
            active={active}
            contextKey={`${visualContextKey(physics.visual.path)}#reader`}
          />
        )}
      </Suspense>
    </div>
  );
}

function useInView(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the viewport so a sim scrolled out of view pauses
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) =>
      setInView(entry?.isIntersecting ?? false),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}
