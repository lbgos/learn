import katex from "katex";
import { getStroke } from "perfect-freehand";
import { compileExpression, plotExpressions } from "./expression.ts";
import {
  boardItemBounds,
  formatTableCell,
  TABLE_CHAR_WIDTH,
  TABLE_FONT_SIZE,
  TABLE_ROW_HEIGHT,
  tableColumnChars,
  type Board,
  type BoardBounds,
  type BoardColor,
  type BoardItem,
} from "./model.ts";

export interface RenderBoardSvgOptions {
  readonly padding?: number;
  readonly width?: number;
  readonly height?: number;
  readonly background?: "black" | "transparent";
}
const colors: Record<BoardColor, string> = {
  white: "#fff",
  red: "#ff6464",
  blue: "#6aaaff",
  green: "#69df98",
  yellow: "#ffdf65",
  gray: "#aaa",
};
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const number = (value: number) => String(Math.round(value * 1000) / 1000);

/** Same deterministic bounds used by auto-placement, hit testing and screenshot framing. */
export function boardBounds(board: Board, padding = 24): BoardBounds {
  if (board.items.length === 0) return { x: 0, y: 0, w: 960, h: 640 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const item of board.items) {
    const bounds = boardItemBounds(item);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.w);
    maxY = Math.max(maxY, bounds.y + bounds.h);
  }
  return {
    x: minX - padding,
    y: minY - padding,
    w: Math.max(1, maxX - minX + padding * 2),
    h: Math.max(1, maxY - minY + padding * 2),
  };
}

/** Outline for ink display and hit-testing. Points are local to the item, including pressure. */
export function boardInkPath(item: Extract<BoardItem, { readonly kind: "ink" }>): string {
  const stroke = getStroke(
    item.points.map(([x, y, pressure]) => [x, y, pressure]),
    {
      size: item.width,
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: false,
    },
  );
  const first = stroke[0];
  if (first === undefined) return "";
  let path = `M${number(first[0] ?? 0)} ${number(first[1] ?? 0)}`;
  for (let i = 0; i < stroke.length; i++) {
    const point = stroke[i];
    const next = stroke[(i + 1) % stroke.length];
    if (point === undefined || next === undefined) continue;
    const x = point[0] ?? 0,
      y = point[1] ?? 0;
    path += `Q${number(x)} ${number(y)} ${number((x + (next[0] ?? 0)) / 2)} ${number((y + (next[1] ?? 0)) / 2)}`;
  }
  return `${path}Z`;
}

function renderText(item: Extract<BoardItem, { readonly kind: "text" }>, color: string): string {
  const size = item.fontSize ?? 24;
  const length = Math.max(1, Math.floor((item.maxWidth ?? Infinity) / (size * 0.65)));
  const lines: string[] = [];
  for (const line of item.text.split("\n")) {
    if (line.length === 0) lines.push("");
    for (let start = 0; start < line.length; start += length)
      lines.push(line.slice(start, start + length));
  }
  return `<text fill="${color}" font-family="sans-serif" font-size="${number(size)}" xml:space="preserve">${lines.map((line, i) => `<tspan x="0" y="${number(size + i * size * 1.4)}">${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function renderPlot(
  item: Extract<BoardItem, { readonly kind: "plot" }>,
  color: string,
  index: number,
): string {
  const count = Math.max(64, Math.min(800, Math.ceil(item.w)));
  const curves = plotExpressions(item.expr).map((expression) => {
    const fn = compileExpression(expression);
    return Array.from({ length: count + 1 }, (_, i) => {
      const x = item.xMin + ((item.xMax - item.xMin) * i) / count;
      return { x, y: fn(x) };
    });
  });
  let sampledMin = Infinity,
    sampledMax = -Infinity;
  for (const curve of curves)
    for (const point of curve) {
      if (!Number.isFinite(point.y)) continue;
      sampledMin = Math.min(sampledMin, point.y);
      sampledMax = Math.max(sampledMax, point.y);
    }
  if (!Number.isFinite(sampledMin)) {
    sampledMin = -1;
    sampledMax = 1;
  }
  const margin =
    sampledMax === sampledMin
      ? Math.max(1, Math.abs(sampledMin) * 0.1)
      : (sampledMax - sampledMin) * 0.08;
  const yMin = item.yMin ?? Math.min(sampledMin - margin, (item.yMax ?? Infinity) - margin);
  const yMax = item.yMax ?? Math.max(sampledMax + margin, yMin + margin);
  const px = (x: number) => ((x - item.xMin) / (item.xMax - item.xMin)) * item.w;
  const py = (y: number) => item.h - ((y - yMin) / (yMax - yMin)) * item.h;
  const clipId = `physics-plot-${index}`;
  let result = `<defs><clipPath id="${clipId}"><rect width="${number(item.w)}" height="${number(item.h)}"/></clipPath></defs><rect width="${number(item.w)}" height="${number(item.h)}" fill="none" stroke="#777"/>`;
  if (item.xMin <= 0 && item.xMax >= 0)
    result += `<path d="M${number(px(0))} 0V${number(item.h)}" stroke="#777"/>`;
  if (yMin <= 0 && yMax >= 0)
    result += `<path d="M0 ${number(py(0))}H${number(item.w)}" stroke="#777"/>`;
  const palette = [color, colors.blue, colors.red, colors.green, colors.yellow, colors.gray];
  curves.forEach((curve, curveIndex) => {
    let path = "";
    let previousY: number | undefined;
    for (const point of curve) {
      const y = py(point.y);
      if (!Number.isFinite(y) || Math.abs(y) > item.h * 1000) {
        previousY = undefined;
        continue;
      }
      const command = previousY === undefined || Math.abs(y - previousY) > item.h * 2 ? "M" : "L";
      path += `${command}${number(px(point.x))} ${number(y)}`;
      previousY = y;
    }
    result += `<path d="${path}" fill="none" stroke="${palette[curveIndex % palette.length]}" stroke-width="2" clip-path="url(#${clipId})"/>`;
  });
  result += `<g fill="${color}" font-family="sans-serif" font-size="12"><text x="4" y="14">${number(yMax)}</text><text x="4" y="${number(item.h - 4)}">${number(yMin)}</text><text x="${number(item.w - 4)}" y="${number(item.h - 4)}" text-anchor="end">x: ${number(item.xMin)}…${number(item.xMax)}</text></g>`;
  if (item.label)
    result += `<text y="${number(item.h + 22)}" fill="${color}" font-family="sans-serif" font-size="18">${escapeXml(item.label)}</text>`;
  return result;
}

type TableItem = Extract<BoardItem, { readonly kind: "table" }>;
const mono = `font-family="ui-monospace, Menlo, Consolas, monospace"`;

/** Right-aligned numeric columns under a header rule; geometry matches `boardItemBounds`. */
function renderTable(item: TableItem, color: string): string {
  const charWidth = TABLE_FONT_SIZE * TABLE_CHAR_WIDTH;
  let right = 0;
  const edges = item.columns.map((name) => (right += tableColumnChars(name) * charWidth));
  const width = right;
  const baseline = (row: number) => (row + 1) * TABLE_ROW_HEIGHT - 6 + (row > 0 ? 6 : 0);
  const cell = (text: string, column: number, row: number) =>
    `<text x="${number(edges[column]! - charWidth)}" y="${number(baseline(row))}">${escapeXml(text)}</text>`;
  let result = `<g fill="${color}" ${mono} font-size="${TABLE_FONT_SIZE}" text-anchor="end">`;
  result += `<g fill="${colors.gray}">${item.columns.map((name, c) => cell(name, c, 0)).join("")}</g>`;
  const texts = item.rows.map((values) => values.map(formatTableCell));
  // Pad each column to its longest fraction so decimals line up, unless a cell would outgrow
  // the 10-character budget of `tableColumnChars` (e.g. 1234 next to 0.0001234).
  const decimals = item.columns.map((_, c) =>
    Math.max(0, ...texts.map((row) => /^-?\d+\.(\d+)$/.exec(row[c]!)?.[1]?.length ?? 0)),
  );
  const pad = (text: string, places: number) => {
    if (places === 0 || !/^-?\d+(\.\d+)?$/.test(text)) return text;
    const [whole, fraction = ""] = text.split(".");
    const padded = `${whole}.${fraction.padEnd(places, "0")}`;
    return padded.length <= 10 ? padded : text;
  };
  texts.forEach((values, r) => {
    result += values.map((text, c) => cell(pad(text, decimals[c]!), c, r + 1)).join("");
  });
  result += `</g><path d="M0 ${TABLE_ROW_HEIGHT + 0.5}H${number(width)}" stroke="#777"/>`;
  const height = (item.rows.length + 1) * TABLE_ROW_HEIGHT + 6;
  if (item.label)
    result += `<text y="${number(height + 22)}" fill="${color}" font-family="sans-serif" font-size="18">${escapeXml(item.label)}</text>`;
  return result;
}

/** Columns 2..n against column 1, as points joined in row order, with a legend. */
function renderTablePlot(item: TableItem, color: string, index: number): string {
  const w = item.w ?? 480;
  const h = item.h ?? 240;
  // `lo`/`hi` are the data extent for the labels; `min`/`max` add a margin for the mapping.
  const range = (values: number[]) => {
    const lo = values.length ? Math.min(...values) : 0;
    const hi = values.length ? Math.max(...values) : 1;
    const pad = hi === lo ? Math.max(1, Math.abs(lo) * 0.1) : (hi - lo) * 0.06;
    return { lo, hi, min: lo - pad, max: hi + pad };
  };
  const x = range(item.rows.map((row) => row[0]!));
  const y = range(item.rows.flatMap((row) => row.slice(1)));
  const px = (value: number) => ((value - x.min) / (x.max - x.min)) * w;
  const py = (value: number) => h - ((value - y.min) / (y.max - y.min)) * h;
  const palette = [color, colors.blue, colors.red, colors.green, colors.yellow, colors.gray];
  const clipId = `physics-plot-${index}`;
  let result = `<defs><clipPath id="${clipId}"><rect width="${number(w)}" height="${number(h)}"/></clipPath></defs><rect width="${number(w)}" height="${number(h)}" fill="none" stroke="#777"/>`;
  if (y.min <= 0 && y.max >= 0)
    result += `<path d="M0 ${number(py(0))}H${number(w)}" stroke="#777"/>`;
  for (let column = 1; column < item.columns.length; column++) {
    const stroke = palette[(column - 1) % palette.length]!;
    const points = item.rows.map((row) => `${number(px(row[0]!))} ${number(py(row[column]!))}`);
    result += `<g clip-path="url(#${clipId})" fill="${stroke}">`;
    if (points.length > 1)
      result += `<path d="M${points.join("L")}" fill="none" stroke="${stroke}" stroke-width="1.25" opacity="0.6"/>`;
    result += item.rows
      .map(
        (row) => `<circle cx="${number(px(row[0]!))}" cy="${number(py(row[column]!))}" r="2.5"/>`,
      )
      .join("");
    result += `</g><text x="${number(w - 6)}" y="${16 + (column - 1) * 14}" fill="${stroke}" ${mono} font-size="12" text-anchor="end">${escapeXml(item.columns[column]!)}</text>`;
  }
  result += `<g fill="${color}" ${mono} font-size="12"><text x="4" y="14">max ${formatTableCell(y.hi)}</text><text x="4" y="${number(h - 4)}">min ${formatTableCell(y.lo)}</text><text x="${number(w - 4)}" y="${number(h - 4)}" text-anchor="end">${escapeXml(item.columns[0]!)}: ${formatTableCell(x.lo)}…${formatTableCell(x.hi)}</text></g>`;
  if (item.label)
    result += `<text y="${number(h + 22)}" fill="${color}" font-family="sans-serif" font-size="18">${escapeXml(item.label)}</text>`;
  return result;
}

function renderItem(item: BoardItem, index: number): string {
  const color = colors[item.color ?? "white"];
  let content: string;
  switch (item.kind) {
    case "ink":
      content = `<path d="${boardInkPath(item)}" fill="${color}"/>`;
      break;
    case "text":
      content = renderText(item, color);
      break;
    case "math": {
      const size = item.fontSize ?? 28;
      const bounds = boardItemBounds(item);
      // Native MathML renders offline in modern Chrome. KaTeX does the TeX parsing,
      // without KaTeX's HTML CSS/font dependencies or untrusted URL extensions.
      const markup = katex.renderToString(item.latex, {
        output: "mathml",
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxExpand: 1000,
        maxSize: 10,
      });
      content = `<foreignObject width="${number(bounds.w)}" height="${number(bounds.h)}"><div xmlns="http://www.w3.org/1999/xhtml" style="color:${color};font-size:${number(size)}px;overflow:visible">${markup}</div></foreignObject>`;
      break;
    }
    case "shape": {
      const x = Math.min(0, item.w),
        y = Math.min(0, item.h),
        w = Math.abs(item.w),
        h = Math.abs(item.h);
      if (item.shape === "rect")
        content = `<rect x="${number(x)}" y="${number(y)}" width="${number(w)}" height="${number(h)}" fill="none" stroke="${color}" stroke-width="2"/>`;
      else if (item.shape === "ellipse")
        content = `<ellipse cx="${number(item.w / 2)}" cy="${number(item.h / 2)}" rx="${number(w / 2)}" ry="${number(h / 2)}" fill="none" stroke="${color}" stroke-width="2"/>`;
      else {
        const markerId = `physics-arrow-${index}`;
        content =
          item.shape === "arrow"
            ? `<defs><marker id="${markerId}" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10Z" fill="${color}"/></marker></defs>`
            : "";
        content += `<path d="M0 0L${number(item.w)} ${number(item.h)}" stroke="${color}" stroke-width="2"${item.shape === "arrow" ? ` marker-end="url(#${markerId})"` : ""}/>`;
      }
      break;
    }
    case "plot":
      content = renderPlot(item, color, index);
      break;
    case "table":
      content =
        item.view === "plot" ? renderTablePlot(item, color, index) : renderTable(item, color);
      break;
    case "image":
      content = `<image href="${escapeXml(item.src)}" width="${number(item.w)}" height="${number(item.h)}"/>`;
      break;
  }
  return `<g data-item-id="${escapeXml(item.id)}" transform="translate(${number(item.x)} ${number(item.y)})">${content}</g>`;
}

/** Standalone SVG, with black background by default. Consumers may mount it directly
 * as inline SVG so foreignObject MathML renders, or load it as a document in Chrome.
 * Do not put it in an <img>: browsers restrict foreignObject rendering in image mode.
 */
export function renderBoardSvg(board: Board, opts: RenderBoardSvgOptions = {}): string {
  const padding = opts.padding ?? 24;
  const bounds = boardBounds(board, padding);
  const width = opts.width ?? Math.min(1600, Math.max(320, bounds.w));
  const height = opts.height ?? Math.min(1200, Math.max(240, bounds.h));
  if (
    ![padding, width, height].every(Number.isFinite) ||
    padding < 0 ||
    width <= 0 ||
    height <= 0 ||
    width > 8192 ||
    height > 8192
  )
    throw new Error("Invalid board SVG dimensions.");
  const background =
    opts.background === "transparent"
      ? ""
      : `<rect x="${number(bounds.x)}" y="${number(bounds.y)}" width="${number(bounds.w)}" height="${number(bounds.h)}" fill="#000"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" viewBox="${number(bounds.x)} ${number(bounds.y)} ${number(bounds.w)} ${number(bounds.h)}" style="background:${opts.background === "transparent" ? "transparent" : "#000"}">${background}${board.items.map(renderItem).join("")}</svg>`;
}
