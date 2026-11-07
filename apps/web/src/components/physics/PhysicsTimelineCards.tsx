import type { ScopedThreadRef } from "@t3tools/contracts";
import { PanelRightOpenIcon } from "lucide-react";
import { use, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { useVisualSelection } from "~/learn/visual/selection";
import { claimInlineSim, releaseInlineSim } from "~/physics/inlineSimGate";
import {
  type PhysicsBoardResult,
  type PhysicsSimResult,
  type PhysicsToolResult,
} from "~/physics/payloads";
import { SimHost } from "~/physics/simHost";
import { physicsEnvironment } from "~/physics/state";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";
import { SimParams, SimTransport } from "./SimControls";
import { Tip } from "./Tip";
import { SimView } from "./SimView";

/** A physics tool result rendered where the agent called it. */
export function PhysicsTimelineCard(props: {
  readonly result: PhysicsToolResult;
  readonly threadRef: ScopedThreadRef;
}) {
  const { result, threadRef } = props;
  switch (result.kind) {
    case "visual":
      return (
        <button
          type="button"
          className="border-white/20 border-l bg-black px-3 py-2 text-left text-white text-xs"
          onClick={() => {
            useVisualSelection
              .getState()
              .select(
                threadRef,
                result.visual.path,
                result.visual.step,
                `${result.visual.hash}:${result.visual.step}:${Date.now()}`,
              );
            useRightPanelStore.getState().openSimulation(threadRef, result.visual.path);
          }}
        >
          {result.visual.path} · Step {result.visual.step + 1}: {result.visual.label}
        </button>
      );
    case "sim":
      return <InlineSim sim={result.sim} threadRef={threadRef} />;
    case "board":
      return <BoardWriteLine board={result.board} threadRef={threadRef} />;
  }
}

const OPEN_LABEL = "Open in panel";

function InlineSim({ sim, threadRef }: { sim: PhysicsSimResult; threadRef: ScopedThreadRef }) {
  if (!sim.ok) {
    return (
      <div className="flex flex-col gap-1 border-white/10 border-l-2 bg-black px-3 py-2 font-mono text-destructive text-xs">
        <span className="text-white/80">{sim.title}</span>
        {sim.errors.map((error) => (
          <span key={error} className="whitespace-pre-wrap">
            {error}
          </span>
        ))}
      </div>
    );
  }
  return <LiveInlineSim sim={sim} threadRef={threadRef} />;
}

/**
 * Mounts when first scrolled into view and pauses whenever it leaves it. The box keeps one size
 * before and after mounting, so the transcript row never changes height.
 */
function LiveInlineSim({ sim, threadRef }: { sim: PhysicsSimResult; threadRef: ScopedThreadRef }) {
  const background = use(BackgroundThreadContext);
  const [host] = useState(() => new SimHost());
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const { playing, meta } = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const paramCount = meta ? Object.keys(meta.params).length : 0;

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      if (entry.isIntersecting) setMounted(true);
      else host.pause();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [host]);

  useEffect(() => {
    if (background) host.pause();
    else if (playing) claimInlineSim(id, host.pause);
  }, [background, host, id, playing]);
  useEffect(() => () => releaseInlineSim(id), [id]);

  return (
    <div ref={box} className="overflow-hidden bg-black text-white">
      <div className="h-64">
        {mounted ? <InlineSimSource host={host} sim={sim} threadRef={threadRef} /> : null}
      </div>
      <SimTransport host={host}>
        {paramCount > 0 ? (
          <Button
            size="sm"
            variant="ghost-muted"
            aria-expanded={showParams}
            onClick={() => setShowParams((value) => !value)}
          >
            Params
          </Button>
        ) : null}
        <Tip label={OPEN_LABEL}>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={OPEN_LABEL}
            onClick={() => useRightPanelStore.getState().openSimulation(threadRef, sim.path)}
          >
            <PanelRightOpenIcon />
          </Button>
        </Tip>
      </SimTransport>
      {showParams ? <SimParams host={host} /> : null}
    </div>
  );
}

function InlineSimSource({
  host,
  sim,
  threadRef,
}: {
  host: SimHost;
  sim: PhysicsSimResult;
  threadRef: ScopedThreadRef;
}) {
  const shell = useThreadShell(threadRef);
  const source = useEnvironmentQuery(
    shell === null
      ? null
      : physicsEnvironment.readSim({
          environmentId: threadRef.environmentId,
          input: { projectId: shell.projectId, threadId: threadRef.threadId, path: sim.path },
        }),
  );
  if (!source.data)
    return (
      <p className="p-3 text-xs">
        {source.error ? "Simulation unavailable" : "Loading simulation"}
      </p>
    );
  if (source.data.hash !== sim.hash)
    return <p className="p-3 text-xs">Simulation has changed. Open in panel.</p>;
  return <SimView host={host} code={source.data.code} threadRef={threadRef} />;
}

function BoardWriteLine({
  board,
  threadRef,
}: {
  board: PhysicsBoardResult;
  threadRef: ScopedThreadRef;
}) {
  const count = board.createdCount ?? board.createdIds.length;
  const label =
    count > 0
      ? `Board ${board.board}: +${count} ${count === 1 ? "item" : "items"}`
      : `Board ${board.board}: edited`;
  return (
    <div className="flex items-center gap-3 bg-black px-3 py-1.5 text-sm text-white">
      {count > 0 ? (
        <BoardItemsImage
          board={board}
          threadRef={threadRef}
          render={THUMBNAIL}
          className="h-10 w-28 shrink-0"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-white/80">{label}</span>
      <Tip label="Open board">
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Open board"
          onClick={() => useRightPanelStore.getState().openWhiteboard(threadRef, board.board)}
        >
          <PanelRightOpenIcon />
        </Button>
      </Tip>
    </div>
  );
}

const THUMBNAIL = { width: 112, height: 40, padding: 8 };

/** The items this write created, as the board draws them now; empty if they were since erased. */
export function BoardItemsImage({
  board,
  threadRef,
  render,
  className,
}: {
  board: PhysicsBoardResult;
  threadRef: ScopedThreadRef;
  /** Size and padding, a stable object; without a size the drawing keeps the items' proportions. */
  render?: { readonly width?: number; readonly height?: number; readonly padding?: number };
  className: string;
}) {
  const shell = useThreadShell(threadRef);
  const file = useEnvironmentQuery(
    shell === null
      ? null
      : physicsEnvironment.readBoard({
          environmentId: threadRef.environmentId,
          input: { projectId: shell.projectId, threadId: threadRef.threadId, board: board.board },
        }),
  );
  const [svg, setSvg] = useState<string>();
  const boardData = file.data?.board;
  const createdIds = board.createdIds;
  useEffect(() => {
    if (!boardData) return;
    let live = true;
    void import("@t3tools/physics/board").then(({ renderBoardSvg }) => {
      const items = boardData.items.filter((item) => createdIds.includes(item.id));
      if (!live || items.length === 0) return;
      try {
        setSvg(
          renderBoardSvg(
            { version: 1, revision: boardData.revision, items },
            { ...render, background: "transparent" },
          ),
        );
      } catch {
        /* A thumbnail is optional; an item the renderer rejects just has none. */
      }
    });
    return () => {
      live = false;
    };
  }, [boardData, createdIds, render]);
  if (svg === undefined) return null;
  return <div className={className} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
}
