import * as Schema from "effect/Schema";
import { compileExpression, plotExpressions } from "./expression.ts";
import { BoardImageSource } from "./imageSource.ts";
export { BoardImageSource, BOARD_IMAGE_MAX_BYTES } from "./imageSource.ts";

const finite = Schema.Number.check(Schema.isFinite());
const coordinate = finite.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }));
const positive = finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100_000));
const id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const text = Schema.String.check(Schema.isMaxLength(16_384));
const pressure = finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const points = Schema.Array(Schema.Tuple([coordinate, coordinate, pressure])).check(
  Schema.isMaxLength(100_000),
);
const expression = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2048));
const expr = Schema.Union([
  expression,
  Schema.Array(expression).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
]);

export const BoardAuthor = Schema.Literals(["user", "agent"]);
export type BoardAuthor = typeof BoardAuthor.Type;
export const BoardColor = Schema.Literals(["white", "red", "blue", "green", "yellow", "gray"]);
export type BoardColor = typeof BoardColor.Type;
const common = {
  id,
  author: BoardAuthor,
  x: coordinate,
  y: coordinate,
  color: Schema.optional(BoardColor),
};
const addCommon = {
  id: Schema.optional(id),
  x: Schema.optional(coordinate),
  y: Schema.optional(coordinate),
  color: Schema.optional(BoardColor),
};
const ink = { kind: Schema.Literal("ink"), points, width: positive };
const textItem = {
  kind: Schema.Literal("text"),
  text,
  fontSize: Schema.optional(positive),
  maxWidth: Schema.optional(positive),
};
const math = { kind: Schema.Literal("math"), latex: text, fontSize: Schema.optional(positive) };
const shape = {
  kind: Schema.Literal("shape"),
  shape: Schema.Literals(["rect", "ellipse", "line", "arrow"]),
  w: coordinate,
  h: coordinate,
};
const plot = {
  kind: Schema.Literal("plot"),
  expr,
  xMin: finite,
  xMax: finite,
  yMin: Schema.optional(finite),
  yMax: Schema.optional(finite),
  w: positive,
  h: positive,
  label: Schema.optional(text),
};
const image = { kind: Schema.Literal("image"), src: BoardImageSource, w: positive, h: positive };
const columns = Schema.Array(
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
).check(Schema.isMinLength(1), Schema.isMaxLength(12));
const rows = Schema.Array(Schema.Array(finite)).check(Schema.isMaxLength(1000));
const tableView = Schema.Literals(["table", "plot"]);
/** Measured data: numeric rows under named columns. The plot view draws columns 2..n against
 * column 1 as points, at w × h (default 480 × 240); the table view sizes itself. */
const table = {
  kind: Schema.Literal("table"),
  columns,
  rows,
  view: Schema.optional(tableView),
  w: Schema.optional(positive),
  h: Schema.optional(positive),
  label: Schema.optional(text),
};

export const BoardItem = Schema.Union([
  Schema.Struct({ ...common, ...ink }),
  Schema.Struct({ ...common, ...textItem }),
  Schema.Struct({ ...common, ...math }),
  Schema.Struct({ ...common, ...shape }),
  Schema.Struct({ ...common, ...plot }),
  Schema.Struct({ ...common, ...image }),
  Schema.Struct({ ...common, ...table }),
]);
export type BoardItem = typeof BoardItem.Type;
export const Board = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  items: Schema.Array(BoardItem).check(Schema.isMaxLength(10_000)),
});
export type Board = typeof Board.Type;
export const BoardDelta = Schema.Struct({
  revision: Schema.Int,
  changed: Schema.Array(BoardItem),
  removed: Schema.Array(id),
});
export type BoardDelta = typeof BoardDelta.Type;

export function applyBoardDelta(board: Board, delta: BoardDelta): Board {
  if (delta.revision <= board.revision) return board;
  if (delta.revision !== board.revision + 1) throw new Error("Board revision gap.");
  const changed = new Map(delta.changed.map((item) => [item.id, item]));
  const removed = new Set(delta.removed);
  const items = board.items
    .filter((item) => !removed.has(item.id))
    .map((item) => {
      const next = changed.get(item.id) ?? item;
      changed.delete(item.id);
      return next;
    });
  return { ...board, revision: delta.revision, items: [...items, ...changed.values()] };
}

export const BoardAddItem = Schema.Union([
  Schema.Struct({ ...addCommon, ...ink }),
  Schema.Struct({ ...addCommon, ...textItem }),
  Schema.Struct({ ...addCommon, ...math }),
  Schema.Struct({ ...addCommon, ...shape }),
  Schema.Struct({ ...addCommon, ...plot }),
  Schema.Struct({ ...addCommon, ...image }),
  Schema.Struct({ ...addCommon, ...table }),
]);
export type BoardAddItem = typeof BoardAddItem.Type;
/** Identity, kind and authorship are immutable. applyBoardOps also rejects fields
 * belonging to a different item kind instead of silently persisting stray properties.
 */
export const BoardItemPatch = Schema.Struct({
  x: Schema.optional(coordinate),
  y: Schema.optional(coordinate),
  color: Schema.optional(Schema.NullOr(BoardColor)),
  points: Schema.optional(points),
  width: Schema.optional(positive),
  text: Schema.optional(text),
  fontSize: Schema.optional(Schema.NullOr(positive)),
  maxWidth: Schema.optional(Schema.NullOr(positive)),
  latex: Schema.optional(text),
  shape: Schema.optional(shape.shape),
  w: Schema.optional(Schema.NullOr(coordinate)),
  h: Schema.optional(Schema.NullOr(coordinate)),
  expr: Schema.optional(expr),
  xMin: Schema.optional(finite),
  xMax: Schema.optional(finite),
  yMin: Schema.optional(Schema.NullOr(finite)),
  yMax: Schema.optional(Schema.NullOr(finite)),
  label: Schema.optional(Schema.NullOr(text)),
  src: Schema.optional(BoardImageSource),
  columns: Schema.optional(columns),
  rows: Schema.optional(rows),
  view: Schema.optional(Schema.NullOr(tableView)),
});
export type BoardItemPatch = typeof BoardItemPatch.Type;
export const BoardOp = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("add"),
    items: Schema.Array(BoardAddItem).check(Schema.isMaxLength(1000)),
  }),
  Schema.Struct({ type: Schema.Literal("update"), id, patch: BoardItemPatch }),
  Schema.Struct({
    type: Schema.Literal("remove"),
    ids: Schema.Array(id).check(Schema.isMaxLength(10_000)),
  }),
  Schema.Struct({ type: Schema.Literal("clear") }),
]);
export type BoardOp = typeof BoardOp.Type;
export const BoardOps = Schema.Array(BoardOp).check(Schema.isMaxLength(1000));
export type BoardOps = typeof BoardOps.Type;
export const TABLE_FONT_SIZE = 14;
export const TABLE_ROW_HEIGHT = 20;
/** Monospace advance per character, as a fraction of the font size. */
export const TABLE_CHAR_WIDTH = 0.62;
/** Characters per column: a 4-significant-digit number like -1.234e-10 fits in 10. */
export const tableColumnChars = (name: string) => Math.max(10, name.length) + 2;
/** Four significant digits without trailing zeros, as the table view and summaries show cells. */
export const formatTableCell = (value: number) => String(Number(value.toPrecision(4)));
export interface BoardBounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Ink points are local offsets from item x/y, as are all other item geometries.
 * Text/math bounds are deterministic estimates; they never depend on browser fonts.
 */
export function boardItemBounds(item: BoardItem): BoardBounds {
  switch (item.kind) {
    case "ink": {
      if (item.points.length === 0) return { x: item.x, y: item.y, w: item.width, h: item.width };
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const [x, y] of item.points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      return {
        x: item.x + minX - item.width,
        y: item.y + minY - item.width,
        w: maxX - minX + item.width * 2,
        h: maxY - minY + item.width * 2,
      };
    }
    case "shape":
      return {
        x: item.x + Math.min(0, item.w) - 3,
        y: item.y + Math.min(0, item.h) - 3,
        w: Math.abs(item.w) + 6,
        h: Math.abs(item.h) + 6,
      };
    case "table": {
      const label = item.label ? 28 : 0;
      if (item.view === "plot")
        return { x: item.x, y: item.y, w: item.w ?? 480, h: (item.h ?? 240) + label };
      const chars = item.columns.reduce((sum, name) => sum + tableColumnChars(name), 0);
      return {
        x: item.x,
        y: item.y,
        w: chars * TABLE_FONT_SIZE * TABLE_CHAR_WIDTH,
        h: (item.rows.length + 1) * TABLE_ROW_HEIGHT + 6 + label,
      };
    }
    case "image":
    case "plot":
      return {
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h + (item.kind === "plot" && item.label ? 28 : 0),
      };
    case "text": {
      const size = item.fontSize ?? 24;
      const longest = Math.max(1, ...item.text.split("\n").map((line) => line.length));
      const w = Math.min(item.maxWidth ?? Infinity, longest * size * 0.65);
      const rows = item.text
        .split("\n")
        .reduce((n, line) => n + Math.max(1, Math.ceil((line.length * size * 0.65) / w)), 0);
      return { x: item.x, y: item.y, w, h: rows * size * 1.4 };
    }
    case "math": {
      const size = item.fontSize ?? 28;
      return {
        x: item.x,
        y: item.y,
        w: Math.max(80, item.latex.length * size * 0.7),
        h: size * 3.5,
      };
    }
  }
}
const allowedPatchFields = {
  ink: Object.keys(ink),
  text: Object.keys(textItem),
  math: Object.keys(math),
  shape: Object.keys(shape),
  plot: Object.keys(plot),
  image: Object.keys(image),
  table: Object.keys(table),
} satisfies Record<BoardItem["kind"], readonly string[]>;
const decodeBoard = Schema.decodeSync(Board, { onExcessProperty: "error" });
const decodeOps = Schema.decodeSync(BoardOps, { onExcessProperty: "error" });
const decodeAuthor = Schema.decodeSync(BoardAuthor);
const decodeItem = Schema.decodeUnknownSync(BoardItem, { onExcessProperty: "error" });
function validateItem(item: BoardItem): void {
  if (item.kind === "plot") {
    if (
      item.xMin >= item.xMax ||
      (item.yMin !== undefined && item.yMax !== undefined && item.yMin >= item.yMax)
    )
      throw new Error("Plot ranges must increase.");
    for (const expression of plotExpressions(item.expr)) compileExpression(expression);
  }
  if (item.kind === "table") {
    if (item.rows.some((row) => row.length !== item.columns.length))
      throw new Error("Every table row needs one value per column.");
    if (item.view === "plot" && item.columns.length < 2)
      throw new Error("A table plot needs an x column and at least one y column.");
  }
}

/** Applies a batch atomically and never mutates its arguments. Empty batches preserve
 * revision; every accepted nonempty batch increments it once. Missing updates fail;
 * missing removes are idempotent. Explicit duplicate IDs fail the whole batch.
 * Generated IDs are deterministic `item-N`, skipping all IDs present in this batch.
 * Missing x defaults to 24; missing y places the item's bounding box 24px below
 * existing content. Existing authorship survives updates; new items use `author`.
 */
export function applyBoardOps(
  board: Board,
  ops: BoardOps,
  author: BoardAuthor,
): { readonly board: Board; readonly createdIds: readonly string[] } {
  const initial = decodeBoard(board);
  const decodedOps = decodeOps(ops);
  decodeAuthor(author);
  const usedIds = new Set(initial.items.map((item) => item.id));
  if (usedIds.size !== initial.items.length) throw new Error("Board has duplicate item IDs.");
  const reservedIds = new Set(
    decodedOps.flatMap((op) =>
      op.type === "add" ? op.items.flatMap((item) => (item.id === undefined ? [] : [item.id])) : [],
    ),
  );
  let items = [...initial.items];
  let nextId = 1;
  const createdIds: string[] = [];
  for (const op of decodedOps) {
    switch (op.type) {
      case "add":
        for (const input of op.items) {
          while (usedIds.has(`item-${nextId}`) || reservedIds.has(`item-${nextId}`)) nextId++;
          const id = input.id ?? `item-${nextId++}`;
          if (usedIds.has(id)) throw new Error(`Board item ID '${id}' already exists.`);
          const bottom = items.reduce((max, item) => {
            const bounds = boardItemBounds(item);
            return Math.max(max, bounds.y + bounds.h);
          }, 0);
          let item = decodeItem({
            ...input,
            id,
            author,
            x: input.x ?? 24,
            y: input.y ?? bottom + 24,
          });
          if (input.y === undefined) {
            const bounds = boardItemBounds(item);
            item = { ...item, y: item.y + bottom + 24 - bounds.y };
          }
          validateItem(item);
          items.push(item);
          usedIds.add(id);
          createdIds.push(id);
        }
        break;
      case "update": {
        const index = items.findIndex((item) => item.id === op.id);
        const existing = items[index];
        if (existing === undefined) throw new Error(`Board item '${op.id}' does not exist.`);
        const allowed = new Set(["x", "y", "color", ...allowedPatchFields[existing.kind]]);
        if (Object.keys(op.patch).some((field) => !allowed.has(field)))
          throw new Error(`Patch contains a field invalid for '${existing.kind}'.`);
        const updated = decodeItem(
          Object.fromEntries(
            Object.entries({ ...existing, ...op.patch }).filter(([, value]) => value !== null),
          ),
        );
        validateItem(updated);
        items[index] = updated;
        break;
      }
      case "remove": {
        const removed = new Set(op.ids);
        items = items.filter((item) => !removed.has(item.id));
        break;
      }
      case "clear":
        items = [];
        break;
    }
  }
  const result = decodeBoard({
    version: 1,
    revision: initial.revision + (decodedOps.length > 0 ? 1 : 0),
    items,
  });
  return { board: result, createdIds };
}
