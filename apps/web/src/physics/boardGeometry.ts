/** Hit testing and item construction for the whiteboard. Coordinates are board units. */
import {
  boardItemBounds,
  type Board,
  type BoardBounds,
  type BoardColor,
  type BoardItem,
} from "@t3tools/physics/board";

export interface InkSample {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether (x, y) touches the item, within `tolerance` of its drawn outline or inside its box. */
export function itemHit(item: BoardItem, x: number, y: number, tolerance: number): boolean {
  switch (item.kind) {
    case "ink": {
      const reach = item.width / 2 + tolerance;
      const [first] = item.points;
      if (!first) return false;
      if (item.points.length === 1) {
        return Math.hypot(x - item.x - first[0], y - item.y - first[1]) <= reach;
      }
      for (let i = 1; i < item.points.length; i++) {
        const a = item.points[i - 1]!;
        const b = item.points[i]!;
        if (
          distanceToSegment(x, y, item.x + a[0], item.y + a[1], item.x + b[0], item.y + b[1]) <=
          reach
        ) {
          return true;
        }
      }
      return false;
    }
    case "shape": {
      const localX = x - item.x;
      const localY = y - item.y;
      const reach = tolerance + 1;
      if (item.shape === "line" || item.shape === "arrow") {
        return distanceToSegment(localX, localY, 0, 0, item.w, item.h) <= reach;
      }
      const left = Math.min(0, item.w);
      const top = Math.min(0, item.h);
      const w = Math.abs(item.w);
      const h = Math.abs(item.h);
      if (item.shape === "rect") {
        const inside =
          localX >= left - reach &&
          localX <= left + w + reach &&
          localY >= top - reach &&
          localY <= top + h + reach;
        const deep =
          localX > left + reach &&
          localX < left + w - reach &&
          localY > top + reach &&
          localY < top + h - reach;
        return inside && !deep;
      }
      const rx = Math.max(w / 2, 0.5);
      const ry = Math.max(h / 2, 0.5);
      const radial = Math.hypot((localX - (left + rx)) / rx, (localY - (top + ry)) / ry);
      return Math.abs(radial - 1) * Math.min(rx, ry) <= reach;
    }
    default: {
      const box = boardItemBounds(item);
      return (
        x >= box.x - tolerance &&
        x <= box.x + box.w + tolerance &&
        y >= box.y - tolerance &&
        y <= box.y + box.h + tolerance
      );
    }
  }
}

/** The topmost item under the point; later items draw over earlier ones. */
export function topItemAt(
  board: Board,
  x: number,
  y: number,
  tolerance: number,
): BoardItem | undefined {
  for (let i = board.items.length - 1; i >= 0; i--) {
    const item = board.items[i]!;
    if (itemHit(item, x, y, tolerance)) return item;
  }
  return undefined;
}

export function itemsInRect(board: Board, rect: BoardBounds): BoardItem[] {
  return board.items.filter((item) => {
    const box = boardItemBounds(item);
    return (
      box.x < rect.x + rect.w &&
      box.x + box.w > rect.x &&
      box.y < rect.y + rect.h &&
      box.y + box.h > rect.y
    );
  });
}

export interface InkAdd {
  readonly kind: "ink";
  readonly x: number;
  readonly y: number;
  readonly color: BoardColor;
  readonly width: number;
  readonly points: ReadonlyArray<readonly [number, number, number]>;
}
export interface ShapeAdd {
  readonly kind: "shape";
  readonly shape: Extract<BoardItem, { kind: "shape" }>["shape"];
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: BoardColor;
}

/** Points are stored local to the first one, with coordinates trimmed to a tenth of a unit. */
export function inkItem(
  samples: readonly InkSample[],
  color: BoardColor,
  width: number,
): InkAdd | undefined {
  const first = samples[0];
  if (!first) return undefined;
  const points = (samples.length === 1 ? [first, first] : samples).map(
    (sample) =>
      [
        round1(sample.x - first.x),
        round1(sample.y - first.y),
        Math.round(sample.pressure * 100) / 100,
      ] as const,
  );
  return { kind: "ink", x: round1(first.x), y: round1(first.y), color, width, points };
}

export function shapeItem(
  shape: Extract<BoardItem, { kind: "shape" }>["shape"],
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  color: BoardColor,
): ShapeAdd {
  return {
    kind: "shape",
    shape,
    x: round1(from.x),
    y: round1(from.y),
    w: round1(to.x - from.x),
    h: round1(to.y - from.y),
    color,
  };
}

let counter = 0;
/** Client-chosen ids keep optimistic items stable when the server confirms them. */
export function newItemId(): string {
  counter += 1;
  return `u${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
