import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { applyBoardOps, Board, BoardImageSource, boardItemBounds, type BoardOps } from "./model.ts";
import { renderBoardSvg } from "./render.ts";

const decodeBoard = Schema.decodeSync(Board);
const decodeImageSource = Schema.decodeSync(BoardImageSource);
const empty: Board = { version: 1, revision: 0, items: [] };
const addText = (text: string): BoardOps => [{ type: "add", items: [{ kind: "text", text }] }];

describe("applyBoardOps", () => {
  it("assigns deterministic IDs and places each new item's bounds below existing content", () => {
    const { board, createdIds } = applyBoardOps(
      empty,
      [
        {
          type: "add",
          items: [
            { kind: "text", text: "Position (m)", id: "item-1" },
            {
              kind: "ink",
              points: [
                [0, -20, 0.5],
                [10, 10, 1],
              ],
              width: 4,
            },
            { kind: "text", text: "Velocity (m/s)" },
          ],
        },
      ],
      "agent",
    );
    expect(
      applyBoardOps(
        empty,
        [
          {
            type: "add",
            items: [
              { kind: "text", text: "generated" },
              { kind: "text", text: "explicit", id: "item-1" },
            ],
          },
        ],
        "user",
      ).createdIds,
    ).toEqual(["item-2", "item-1"]);
    expect(createdIds).toEqual(["item-1", "item-2", "item-3"]);
    expect(board.revision).toBe(1);
    expect(board.items.every((item) => item.author === "agent")).toBe(true);
    const boxes = board.items.map(boardItemBounds);
    expect(boxes[0]?.y).toBe(24);
    expect(boxes[1]?.y).toBeCloseTo((boxes[0]?.y ?? 0) + (boxes[0]?.h ?? 0) + 24);
    expect(boxes[2]?.y).toBeCloseTo((boxes[1]?.y ?? 0) + (boxes[1]?.h ?? 0) + 24);
    expect(empty.items).toEqual([]);
  });

  it("preserves explicit placement and existing authorship through update, remove and clear", () => {
    const original = applyBoardOps(
      empty,
      [
        {
          type: "add",
          items: [
            { kind: "text", text: "Before", id: "a", x: 50, y: 60 },
            { kind: "shape", shape: "arrow", w: -40, h: 80, id: "b" },
          ],
        },
      ],
      "user",
    ).board;
    const { board, createdIds } = applyBoardOps(
      original,
      [
        { type: "update", id: "a", patch: { text: "After", color: "red" } },
        { type: "remove", ids: ["b", "missing"] },
      ],
      "agent",
    );
    expect(board.revision).toBe(2);
    expect(createdIds).toEqual([]);
    expect(board.items).toEqual([
      { id: "a", kind: "text", text: "After", x: 50, y: 60, author: "user", color: "red" },
    ]);
    expect(original.items[0]).toMatchObject({ text: "Before" });
    expect(applyBoardOps(board, [{ type: "clear" }], "agent").board).toEqual({
      version: 1,
      revision: 3,
      items: [],
    });
    expect(applyBoardOps(board, [], "agent").board.revision).toBe(2);
  });

  it("rejects collisions and invalid updates without mutating the input board", () => {
    const board = applyBoardOps(empty, addText("Immutable"), "user").board;
    expect(() =>
      applyBoardOps(
        board,
        [{ type: "add", items: [{ kind: "text", text: "Collision", id: "item-1" }] }],
        "agent",
      ),
    ).toThrow("already exists");
    expect(() =>
      applyBoardOps(board, [{ type: "update", id: "missing", patch: { x: 10 } }], "agent"),
    ).toThrow("does not exist");
    expect(() =>
      applyBoardOps(board, [{ type: "update", id: "item-1", patch: { latex: "x" } }], "agent"),
    ).toThrow("invalid");
    expect(board.items[0]).toMatchObject({ text: "Immutable", author: "user" });
  });

  it("validates numeric state, strict fields, image sources and plot grammar at the boundary", () => {
    expect(() => decodeBoard({ ...empty, revision: -1 })).toThrow();
    expect(() =>
      applyBoardOps(
        empty,
        [{ type: "add", items: [{ kind: "text", text: "bad", x: NaN }] }],
        "user",
      ),
    ).toThrow();
    expect(() => decodeImageSource("data:image/svg+xml;base64,PHN2Zz4=")).toThrow();
    expect(() => decodeImageSource("https://example.com/a.png")).toThrow();
    expect(() =>
      applyBoardOps(
        empty,
        [
          {
            type: "add",
            items: [{ kind: "plot", expr: "window.alert(1)", xMin: 0, xMax: 1, w: 200, h: 100 }],
          },
        ],
        "agent",
      ),
    ).toThrow();
    expect(() =>
      applyBoardOps(
        empty,
        [
          {
            type: "add",
            items: [{ kind: "plot", expr: "sin(x)", xMin: 2, xMax: 1, w: 200, h: 100 }],
          },
        ],
        "agent",
      ),
    ).toThrow("ranges must increase");
  });
});

describe("renderBoardSvg", () => {
  it("renders escaped text, pressure-smoothed ink, safe plots and offline MathML", () => {
    const board = applyBoardOps(
      empty,
      [
        {
          type: "add",
          items: [
            { kind: "text", text: '<script>alert("x")</script>' },
            {
              kind: "ink",
              width: 4,
              points: [
                [0, 0, 0.2],
                [10, 10, 0.8],
                [20, 0, 0.5],
              ],
            },
            { kind: "math", latex: "\\frac{1}{2}mv^2" },
            { kind: "plot", expr: ["sin(x)", "cos(x)"], xMin: -3, xMax: 3, w: 200, h: 100 },
          ],
        },
      ],
      "agent",
    ).board;
    const svg = renderBoardSvg(board);
    expect(svg).toContain('fill="#000"');
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("<math");
    expect(svg).toContain("<mfrac>");
    expect(svg).toContain("<foreignObject");
    expect(svg).toContain("clipPath");
    expect(svg).toBe(renderBoardSvg(board));
  });
});

describe("table items", () => {
  const laps = {
    kind: "table",
    columns: ["lap", "T (s)"],
    rows: [
      [1, 2.0071],
      [2, 2.0069],
    ],
    label: "Pendulum period",
  } as const;

  it("accepts rows with one value per column and patches rows in place", () => {
    const added = applyBoardOps(empty, [{ type: "add", items: [{ ...laps, id: "t" }] }], "user");
    const { board } = applyBoardOps(
      added.board,
      [{ type: "update", id: "t", patch: { rows: [[1, 2]], view: "plot" } }],
      "agent",
    );
    expect(board.items[0]).toMatchObject({
      kind: "table",
      rows: [[1, 2]],
      view: "plot",
      author: "user",
    });
  });

  it("rejects ragged rows, a one-column plot, non-finite cells and foreign patch fields", () => {
    const add = (item: object) => () =>
      applyBoardOps(empty, [{ type: "add", items: [item] }] as unknown as BoardOps, "agent");
    expect(add({ ...laps, rows: [[1, 2, 3]] })).toThrow("one value per column");
    expect(add({ ...laps, columns: ["t (s)"], rows: [[1]], view: "plot" })).toThrow("x column");
    expect(add({ ...laps, rows: [[1, Number.NaN]] })).toThrow();
    const text = applyBoardOps(
      empty,
      [{ type: "add", items: [{ kind: "text", text: "a", id: "a" }] }],
      "agent",
    ).board;
    expect(() =>
      applyBoardOps(text, [{ type: "update", id: "a", patch: { rows: [] } }], "agent"),
    ).toThrow("invalid for 'text'");
  });

  it("renders escaped column names and labels with four significant digits", () => {
    const board = applyBoardOps(
      empty,
      [
        {
          type: "add",
          items: [
            { ...laps, columns: ["<b>lap</b>", "T & (s)"], label: '"T" <script>' },
            { ...laps, view: "plot", columns: ["<x>", "y"] },
            {
              ...laps,
              rows: [
                [3, 2.02],
                [4, 2.0071],
              ],
            },
            {
              ...laps,
              rows: [
                [5, 1234],
                [6, 0.0001234],
              ],
            },
          ],
        },
      ],
      "agent",
    ).board;
    const svg = renderBoardSvg(board);
    expect(svg).toContain("&lt;b&gt;lap&lt;/b&gt;");
    expect(svg).toContain("T &amp; (s)");
    expect(svg).toContain("&quot;T&quot; &lt;script&gt;");
    expect(svg).toContain("&lt;x&gt;: 1…2<"); // data extent, not the padded axis
    expect(svg).not.toMatch(/<(?:b|x|script)>/);
    expect(svg).toContain(">2.007<");
    expect(svg).toContain(">1<"); // integer column stays bare
    expect(svg).toContain(">2.020<"); // padded to the column's longest fraction that fits
    expect(svg).toContain(">1234<"); // 1234.0000000 would not fit
    expect(svg).toContain("<circle");
  });
});
