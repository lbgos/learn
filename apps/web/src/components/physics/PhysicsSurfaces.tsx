import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense } from "react";

import { cn } from "~/lib/utils";
import type { RightPanelSurface } from "~/rightPanelStore";

const WhiteboardPanel = lazy(() =>
  import("./WhiteboardPanel").then((module) => ({ default: module.WhiteboardPanel })),
);
const VisualPanel = lazy(() =>
  import("~/learn/visual/VisualPanel").then((module) => ({ default: module.VisualPanel })),
);
const SimulationPanel = lazy(() =>
  import("./SimulationPanel").then((module) => ({ default: module.SimulationPanel })),
);

/**
 * Every open whiteboard and simulation surface, mounted for as long as the surface is open. Only
 * the active one is shown, so switching tabs keeps a sim's time, parameters and plots and a
 * board's undo history; closing the surface unmounts it. Hidden surfaces keep their size
 * (`visibility: hidden`, not `display: none`, which would resize the sim iframe to nothing and
 * back) and hidden sims pause, so nothing draws. Must sit in a `relative` box the size of the
 * panel body.
 */
export function PhysicsSurfaces(props: {
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  /** False while the whole right panel is collapsed. */
  readonly panelOpen: boolean;
  readonly threadRef: ScopedThreadRef;
  /** False for a draft thread: the server resolves the workspace from the project alone. */
  readonly threadStarted: boolean;
  readonly projectId: ProjectId;
}) {
  const { surfaces, activeSurfaceId, panelOpen, threadRef, threadStarted, projectId } = props;
  const panels = surfaces.map((surface) => {
    if (surface.kind !== "whiteboard" && surface.kind !== "simulation") return null;
    const active = surface.id === activeSurfaceId;
    return (
      <div
        key={surface.id}
        className={cn("absolute inset-0", active ? "pointer-events-auto" : "invisible")}
      >
        <Suspense fallback={null}>
          {surface.kind === "whiteboard" ? (
            <WhiteboardPanel
              threadRef={threadRef}
              threadStarted={threadStarted}
              projectId={projectId}
              board={surface.name}
            />
          ) : surface.path.startsWith("visuals/") ? (
            <VisualPanel
              threadRef={threadRef}
              threadStarted={threadStarted}
              projectId={projectId}
              path={surface.path}
              active={active && panelOpen}
            />
          ) : (
            <SimulationPanel
              threadRef={threadRef}
              threadStarted={threadStarted}
              projectId={projectId}
              path={surface.path}
              active={active && panelOpen}
            />
          )}
        </Suspense>
      </div>
    );
  });
  return <div className="pointer-events-none absolute inset-0">{panels}</div>;
}
