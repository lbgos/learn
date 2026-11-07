import {
  boardBounds,
  boardInkPath,
  boardItemBounds,
  type Board,
  type BoardColor,
  type BoardItem,
  type BoardOps,
} from "@t3tools/physics/board";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { BOARD_COLORS, boardMarkup, itemMarkup } from "~/physics/boardRender";
import {
  inkItem,
  itemHit,
  itemsInRect,
  newItemId,
  shapeItem,
  topItemAt,
  type InkSample,
} from "~/physics/boardGeometry";
import { BoardTextEditor, type TextEdit } from "./BoardTextEditor";

export type BoardTool =
  | "select"
  | "pen"
  | "eraser"
  | "text"
  | "math"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "pan";

interface View {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}
interface Point {
  readonly x: number;
  readonly y: number;
}

const PEN_WIDTH = 3;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
/** Screen pixels of slack when hitting thin strokes. */
const HIT_SLOP = 7;
/** Strokes closer together than this (board units) add no information. */
const MIN_POINT_GAP = 0.8;
const AGENT_ACCENT = "#6aaaff";

type Gesture =
  | { readonly type: "pan"; readonly from: Point; readonly origin: View }
  | { readonly type: "ink"; readonly samples: InkSample[] }
  | {
      readonly type: "shape";
      readonly tool: "line" | "arrow" | "rect" | "ellipse";
      readonly from: Point;
    }
  | { readonly type: "erase"; readonly ids: Set<string> }
  | { readonly type: "move"; readonly from: Point; readonly ids: readonly string[] }
  | { readonly type: "marquee"; readonly from: Point; readonly additive: boolean };

const round1 = (value: number) => Math.round(value * 10) / 10;
const cursorFor: Record<BoardTool, string> = {
  select: "cursor-default",
  pen: "cursor-crosshair",
  eraser: "cursor-cell",
  text: "cursor-text",
  math: "cursor-text",
  line: "cursor-crosshair",
  arrow: "cursor-crosshair",
  rect: "cursor-crosshair",
  ellipse: "cursor-crosshair",
  pan: "cursor-grab",
};

/** The board's committed items. Memoized on the markup string so pan, zoom and drafts skip it. */
const Layer = memo(function Layer({ markup }: { markup: string }) {
  return <g dangerouslySetInnerHTML={{ __html: markup }} />;
});

function fitView(board: Board, width: number, height: number): View {
  const bounds = boardBounds(board);
  const k = Math.min(1.5, width / bounds.w, height / bounds.h);
  return {
    k,
    x: (width - bounds.w * k) / 2 - bounds.x * k,
    y: board.items.length === 0 ? 0 : (height - bounds.h * k) / 2 - bounds.y * k,
  };
}

/**
 * Interactive board surface: renders `board` and turns pointer input into op batches handed to
 * `onCommit`, one per finished stroke or edit. Gestures never touch React state per event
 * except the draft preview, which is coalesced to one update per frame.
 */
export function BoardCanvas(props: {
  readonly board: Board;
  readonly tool: BoardTool;
  readonly color: BoardColor;
  readonly selection: ReadonlySet<string>;
  readonly onSelectionChange: (ids: ReadonlySet<string>) => void;
  readonly onCommit: (ops: BoardOps) => void;
  /** Changes whenever the surrounding UI asks to fit the board in view. */
  readonly fitSignal: number;
}) {
  const { board, tool, color, selection, onSelectionChange, onCommit, fitSignal } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; view: View; center: Point } | null>(null);
  const space = useRef(false);
  const frame = useRef<number | undefined>(undefined);
  const [draft, setDraft] = useState<BoardItem | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const [erasing, setErasing] = useState<ReadonlySet<string>>(new Set());
  const [dragDelta, setDragDelta] = useState<Point | null>(null);
  const [editing, setEditing] = useState<TextEdit | null>(null);

  const applyView = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
  }, []);

  // Fit once the container has a size, then whenever asked.
  const fitted = useRef(false);
  const fit = useCallback(() => {
    const root = rootRef.current;
    if (root && root.clientWidth > 0)
      applyView(fitView(board, root.clientWidth, root.clientHeight));
  }, [applyView, board]);
  const latestFit = useRef(fit);
  latestFit.current = fit;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return observeResize(root, () => {
      if (!fitted.current && root.clientWidth > 0) {
        fitted.current = true;
        latestFit.current();
      }
    });
  }, []);
  useEffect(() => {
    if (fitSignal > 0) latestFit.current();
  }, [fitSignal]);

  const toBoard = useCallback((clientX: number, clientY: number): Point => {
    const rect = rootRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - rect.left - v.x) / v.k, y: (clientY - rect.top - v.y) / v.k };
  }, []);

  // Wheel zooms about the cursor; it needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const v = viewRef.current;
      const rect = root.getBoundingClientRect();
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey) {
        applyView({ ...v, x: v.x - event.deltaX });
        return;
      }
      const k = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, v.k * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))),
      );
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      applyView({ k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k });
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [applyView]);

  const slop = HIT_SLOP / view.k;
  const hidden = useMemo(() => {
    const ids = new Set(erasing);
    if (dragDelta) for (const id of selection) ids.add(id);
    if (editing?.id) ids.add(editing.id);
    return ids;
  }, [dragDelta, editing?.id, erasing, selection]);
  const markup = useMemo(() => boardMarkup(board, hidden), [board, hidden]);
  const movedMarkup = useMemo(
    () =>
      dragDelta
        ? board.items
            .filter((item) => selection.has(item.id))
            .map(itemMarkup)
            .join("")
        : "",
    [board, dragDelta, selection],
  );
  const agentItems = useMemo(() => board.items.filter((item) => item.author === "agent"), [board]);

  /** Coalesces draft updates to one per frame; strokes can deliver several events per frame. */
  const scheduleDraft = (build: () => BoardItem | null) => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      setDraft(build());
    });
  };
  const endDraft = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    setDraft(null);
  };

  const finishText = useCallback(
    (edit: TextEdit, value: string) => {
      setEditing(null);
      const content = value.trim();
      const body = edit.kind === "math" ? { latex: content } : { text: content };
      if (edit.id) {
        if (content === "") onCommit([{ type: "remove", ids: [edit.id] }]);
        else if (content !== edit.value) onCommit([{ type: "update", id: edit.id, patch: body }]);
      } else if (content !== "") {
        const common = { id: newItemId(), x: round1(edit.x), y: round1(edit.y), color };
        onCommit([
          {
            type: "add",
            items: [
              edit.kind === "math"
                ? { ...common, kind: "math", latex: content }
                : { ...common, kind: "text", text: content },
            ],
          },
        ]);
      }
    },
    [color, onCommit],
  );

  const draftInk = (samples: InkSample[]): BoardItem | null => {
    const item = inkItem(samples, color, PEN_WIDTH);
    return item ? { ...item, id: "draft", author: "user" } : null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = toBoard(event.clientX, event.clientY);
    const root = event.currentTarget;
    if (event.pointerType === "touch") {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size === 2) {
        // A second finger turns whatever was in progress into a pinch.
        gesture.current = null;
        endDraft();
        setMarquee(null);
        setErasing(new Set());
        setDragDelta(null);
        const [a, b] = [...touches.current.values()] as [Point, Point];
        pinch.current = {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          view: viewRef.current,
          center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        return;
      }
    }
    try {
      root.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already-gone pointers cannot be captured; the gesture still works without.
    }
    const activeTool: BoardTool =
      event.button === 1 || space.current
        ? "pan"
        : event.pointerType === "pen" && (event.buttons & 32) !== 0
          ? "eraser"
          : tool;
    if (activeTool !== "text" && activeTool !== "math") root.focus({ preventScroll: true });
    switch (activeTool) {
      case "pan":
        gesture.current = {
          type: "pan",
          from: { x: event.clientX, y: event.clientY },
          origin: viewRef.current,
        };
        break;
      case "pen": {
        const samples = [{ ...point, pressure: event.pressure > 0 ? event.pressure : 0.5 }];
        gesture.current = { type: "ink", samples };
        scheduleDraft(() => draftInk(samples));
        break;
      }
      case "line":
      case "arrow":
      case "rect":
      case "ellipse":
        gesture.current = { type: "shape", tool: activeTool, from: point };
        break;
      case "eraser": {
        const ids = new Set(
          board.items
            .filter((item) => itemHit(item, point.x, point.y, slop))
            .map((item) => item.id),
        );
        gesture.current = { type: "erase", ids };
        setErasing(ids);
        break;
      }
      case "text":
      case "math": {
        const existing = topItemAt(board, point.x, point.y, slop);
        if (existing?.kind === "text" || existing?.kind === "math") {
          setEditing({
            id: existing.id,
            kind: existing.kind,
            x: existing.x,
            y: existing.y,
            value: existing.kind === "math" ? existing.latex : existing.text,
            fontSize: existing.fontSize ?? (existing.kind === "math" ? 28 : 24),
          });
        } else {
          setEditing({
            kind: activeTool,
            x: point.x,
            y: point.y,
            value: "",
            fontSize: activeTool === "math" ? 28 : 24,
          });
        }
        break;
      }
      case "select": {
        const item = topItemAt(board, point.x, point.y, slop);
        if (item) {
          const ids = selection.has(item.id)
            ? selection
            : event.shiftKey
              ? new Set([...selection, item.id])
              : new Set([item.id]);
          onSelectionChange(ids);
          gesture.current = { type: "move", from: point, ids: [...ids] };
        } else {
          if (!event.shiftKey) onSelectionChange(new Set());
          gesture.current = { type: "marquee", from: point, additive: event.shiftKey };
        }
        break;
      }
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const start = pinch.current;
      if (start && touches.current.size >= 2) {
        const [a, b] = [...touches.current.values()] as [Point, Point];
        const rect = rootRef.current!.getBoundingClientRect();
        const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const k = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, (start.view.k * distance) / start.distance),
        );
        // Keep the board point under the starting centre under the current centre.
        const bx = (start.center.x - rect.left - start.view.x) / start.view.k;
        const by = (start.center.y - rect.top - start.view.y) / start.view.k;
        applyView({ k, x: center.x - rect.left - bx * k, y: center.y - rect.top - by * k });
        return;
      }
    }
    const active = gesture.current;
    if (!active) return;
    const point = toBoard(event.clientX, event.clientY);
    switch (active.type) {
      case "pan":
        applyView({
          ...active.origin,
          x: active.origin.x + event.clientX - active.from.x,
          y: active.origin.y + event.clientY - active.from.y,
        });
        break;
      case "ink": {
        const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
        for (const sample of events.length > 0 ? events : [event.nativeEvent]) {
          const p = toBoard(sample.clientX, sample.clientY);
          const last = active.samples.at(-1)!;
          if (Math.hypot(p.x - last.x, p.y - last.y) < MIN_POINT_GAP) continue;
          active.samples.push({ ...p, pressure: sample.pressure > 0 ? sample.pressure : 0.5 });
        }
        scheduleDraft(() => draftInk(active.samples));
        break;
      }
      case "shape":
        scheduleDraft(() => {
          const item = shapeItem(active.tool, active.from, point, color);
          return { ...item, id: "draft", author: "user" };
        });
        break;
      case "erase": {
        let grew = false;
        for (const item of board.items) {
          if (!active.ids.has(item.id) && itemHit(item, point.x, point.y, slop)) {
            active.ids.add(item.id);
            grew = true;
          }
        }
        if (grew) setErasing(new Set(active.ids));
        break;
      }
      case "move":
        setDragDelta({ x: point.x - active.from.x, y: point.y - active.from.y });
        break;
      case "marquee":
        setMarquee({
          x: Math.min(active.from.x, point.x),
          y: Math.min(active.from.y, point.y),
          w: Math.abs(point.x - active.from.x),
          h: Math.abs(point.y - active.from.y),
        });
        break;
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (touches.current.delete(event.pointerId) && touches.current.size < 2) pinch.current = null;
    const active = gesture.current;
    gesture.current = null;
    if (!active) return;
    const point = toBoard(event.clientX, event.clientY);
    switch (active.type) {
      case "ink": {
        endDraft();
        const item = inkItem(active.samples, color, PEN_WIDTH);
        if (item) onCommit([{ type: "add", items: [{ ...item, id: newItemId() }] }]);
        break;
      }
      case "shape": {
        endDraft();
        // A click without a drag draws nothing.
        if (Math.hypot(point.x - active.from.x, point.y - active.from.y) * viewRef.current.k < 4)
          break;
        onCommit([
          {
            type: "add",
            items: [{ ...shapeItem(active.tool, active.from, point, color), id: newItemId() }],
          },
        ]);
        break;
      }
      case "erase":
        setErasing(new Set());
        if (active.ids.size > 0) onCommit([{ type: "remove", ids: [...active.ids] }]);
        break;
      case "move": {
        setDragDelta(null);
        const dx = point.x - active.from.x;
        const dy = point.y - active.from.y;
        if (Math.hypot(dx, dy) * viewRef.current.k < 3) break;
        onCommit(
          board.items
            .filter((item) => active.ids.includes(item.id))
            .map((item) => ({
              type: "update" as const,
              id: item.id,
              patch: { x: round1(item.x + dx), y: round1(item.y + dy) },
            })),
        );
        break;
      }
      case "marquee": {
        setMarquee(null);
        const rect = {
          x: Math.min(active.from.x, point.x),
          y: Math.min(active.from.y, point.y),
          w: Math.abs(point.x - active.from.x),
          h: Math.abs(point.y - active.from.y),
        };
        if (rect.w * viewRef.current.k < 3 && rect.h * viewRef.current.k < 3) break;
        const ids = itemsInRect(board, rect).map((item) => item.id);
        onSelectionChange(new Set(active.additive ? [...selection, ...ids] : ids));
        break;
      }
      case "pan":
        break;
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") {
      space.current = true;
      event.preventDefault();
    } else if ((event.key === "Delete" || event.key === "Backspace") && selection.size > 0) {
      event.preventDefault();
      onCommit([{ type: "remove", ids: [...selection] }]);
      onSelectionChange(new Set());
    } else if (event.key === "Escape") {
      onSelectionChange(new Set());
    }
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (tool !== "select") return;
    const point = toBoard(event.clientX, event.clientY);
    const item = topItemAt(board, point.x, point.y, slop);
    if (item?.kind === "text" || item?.kind === "math") {
      setEditing({
        id: item.id,
        kind: item.kind,
        x: item.x,
        y: item.y,
        value: item.kind === "math" ? item.latex : item.text,
        fontSize: item.fontSize ?? (item.kind === "math" ? 28 : 24),
      });
    }
  };

  const draftColor = BOARD_COLORS[(draft && "color" in draft ? draft.color : undefined) ?? color];
  return (
    <div className="relative size-full overflow-hidden bg-black">
      <div
        ref={rootRef}
        tabIndex={0}
        role="application"
        aria-label="Whiteboard"
        className={`size-full touch-none select-none outline-none ${cursorFor[tool]}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (event.key === " ") space.current = false;
        }}
        onDoubleClick={onDoubleClick}
        onBlur={() => {
          space.current = false;
        }}
      >
        <svg className="pointer-events-none size-full text-white" aria-hidden>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <Layer markup={markup} />
            {dragDelta ? (
              <g
                transform={`translate(${dragDelta.x} ${dragDelta.y})`}
                dangerouslySetInnerHTML={{ __html: movedMarkup }}
              />
            ) : null}
            {agentItems.map((item) => {
              const box = boardItemBounds(item);
              return hidden.has(item.id) ? null : (
                <line
                  key={item.id}
                  x1={box.x - 5}
                  x2={box.x - 5}
                  y1={box.y}
                  y2={box.y + box.h}
                  stroke={AGENT_ACCENT}
                  strokeOpacity={0.55}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {board.items
              .filter((item) => selection.has(item.id))
              .map((item) => {
                const box = boardItemBounds(item);
                const offset = dragDelta ?? { x: 0, y: 0 };
                return (
                  <rect
                    key={item.id}
                    x={box.x + offset.x - 3}
                    y={box.y + offset.y - 3}
                    width={box.w + 6}
                    height={box.h + 6}
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity={0.5}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            {draft?.kind === "ink" ? (
              <g transform={`translate(${draft.x} ${draft.y})`}>
                <path d={boardInkPath(draft)} fill={draftColor} />
              </g>
            ) : draft ? (
              <g dangerouslySetInnerHTML={{ __html: itemMarkup(draft) }} />
            ) : null}
            {marquee ? (
              <rect
                {...marquee}
                fill="currentColor"
                fillOpacity={0.05}
                stroke="currentColor"
                strokeOpacity={0.4}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </g>
        </svg>
      </div>
      {editing ? (
        <BoardTextEditor
          // A different target is a fresh editor, not an edit of the last one.
          key={`${editing.id ?? "new"}:${editing.x}:${editing.y}`}
          edit={editing}
          view={view}
          color={BOARD_COLORS[color]}
          onDone={finishText}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
