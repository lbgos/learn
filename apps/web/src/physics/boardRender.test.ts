import { applyBoardOps } from "@t3tools/physics/board";
import { expect, it } from "vite-plus/test";
import { boardMarkup } from "./boardRender.ts";

it("refreshes image markup when the SVG changes but its data URL length stays the same", () => {
  const source = (color: string) =>
    `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="${color}"/></svg>`)}`;
  const first = source("#ff0000");
  const second = source("#0000ff");
  expect(first.length).toBe(second.length);
  const { board } = applyBoardOps(
    { version: 1, revision: 0, items: [] },
    [
      {
        type: "add",
        items: [{ kind: "image", id: "same-length-image", src: first, w: 100, h: 100 }],
      },
    ],
    "agent",
  );
  expect(boardMarkup(board, new Set())).toContain(first);
  const updated = applyBoardOps(
    board,
    [{ type: "update", id: "same-length-image", patch: { src: second } }],
    "agent",
  ).board;
  const markup = boardMarkup(updated, new Set());
  expect(markup).toContain(`<image href="${second}"`);
  expect(markup).not.toContain(first);
  expect(markup).not.toContain('<rect width="100"');
});
