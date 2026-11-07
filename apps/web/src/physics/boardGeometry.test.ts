import { applyBoardOps, type Board, type BoardAddItem } from "@t3tools/physics/board";
import { describe, expect, it } from "vite-plus/test";

import { inkItem, itemsInRect, shapeItem, topItemAt } from "./boardGeometry";

function boardWith(...items: BoardAddItem[]): Board {
  return applyBoardOps(
    { version: 1, revision: 0, items: [] },
    [{ type: "add", items: items.map((item, i) => ({ ...item, id: `i${i}` })) }],
    "user",
  ).board;
}

describe("board geometry", () => {
  it("stores ink points local to the first sample and doubles a lone tap", () => {
    expect(inkItem([{ x: 10.04, y: 20, pressure: 0.5 }], "white", 3)).toMatchObject({
      x: 10,
      y: 20,
      points: [
        [0, 0, 0.5],
        [0, 0, 0.5],
      ],
    });
  });

  it("hits a stroke near its path and misses away from it", () => {
    const board = boardWith(
      inkItem(
        [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 100, y: 0, pressure: 0.5 },
        ],
        "white",
        3,
      )!,
    );
    expect(topItemAt(board, 50, 4, 3)?.id).toBe("i0");
    expect(topItemAt(board, 50, 30, 3)).toBeUndefined();
  });

  it("hits a rectangle on its outline, not its middle", () => {
    const board = boardWith(shapeItem("rect", { x: 0, y: 0 }, { x: 100, y: 60 }, "white"));
    expect(topItemAt(board, 0, 30, 3)?.id).toBe("i0");
    expect(topItemAt(board, 50, 30, 3)).toBeUndefined();
  });

  it("selects items whose boxes touch the marquee", () => {
    const board = boardWith(
      inkItem(
        [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 10, y: 10, pressure: 0.5 },
        ],
        "white",
        3,
      )!,
      inkItem(
        [
          { x: 500, y: 500, pressure: 0.5 },
          { x: 510, y: 510, pressure: 0.5 },
        ],
        "white",
        3,
      )!,
    );
    expect(itemsInRect(board, { x: -5, y: -5, w: 30, h: 30 }).map((item) => item.id)).toEqual([
      "i0",
    ]);
  });
});
