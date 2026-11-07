/**
 * Board markup for the inline SVG canvas. Each item is rendered once by the shared renderer
 * (`renderBoardSvg`, the same code agents' screenshots use) and cached, so a stroke or a pan
 * never re-renders the rest of the board.
 */
import { renderBoardSvg, type Board, type BoardItem } from "@t3tools/physics/board";

export const BOARD_COLORS = {
  white: "#fff",
  red: "#ff6464",
  blue: "#6aaaff",
  green: "#69df98",
  yellow: "#ffdf65",
  gray: "#aaa",
} as const;

interface Entry {
  readonly signature: string;
  readonly imageSource: string | undefined;
  readonly markup: string;
}
let cache = new Map<string, Entry>();
let uid = 0;

/** Geometry signatures stay small; boardMarkup compares image sources separately. */
function signature(item: BoardItem): string {
  switch (item.kind) {
    case "ink": {
      const last = item.points.at(-1);
      return `${item.x}|${item.y}|${item.color}|${item.width}|${item.points.length}|${last?.[0]}|${last?.[1]}`;
    }
    case "image":
      return `${item.x}|${item.y}|${item.w}|${item.h}`;
    default:
      return JSON.stringify(item);
  }
}

/** One item's markup, positioned in board coordinates. */
export function itemMarkup(item: BoardItem): string {
  const svg = renderBoardSvg(
    { version: 1, revision: 0, items: [item] },
    { width: 1, height: 1, background: "transparent" },
  );
  const inner = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
  // Marker and clip ids are numbered per rendered board, so every item would claim id 0.
  const id = ++uid;
  return inner.replace(/physics-(arrow|plot)-0/g, `physics-$1-${id}`);
}

/** Markup for every item not in `hidden`, in draw order. */
export function boardMarkup(board: Board, hidden: ReadonlySet<string>): string {
  const next = new Map<string, Entry>();
  let markup = "";
  for (const item of board.items) {
    const sig = signature(item);
    const imageSource = item.kind === "image" ? item.src : undefined;
    const entry = cache.get(item.id);
    const current =
      entry?.signature === sig && entry.imageSource === imageSource
        ? entry
        : { signature: sig, imageSource, markup: itemMarkup(item) };
    next.set(item.id, current);
    if (!hidden.has(item.id)) markup += current.markup;
  }
  cache = next;
  return markup;
}
