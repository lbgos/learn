import type { Board, BoardOps } from "@t3tools/physics/board";
import { applyBoardOps } from "@t3tools/physics/board";
import { describe, expect, it } from "vite-plus/test";

import { BoardSession, invertBoardOps } from "./boardSession";

const empty: Board = { version: 1, revision: 0, items: [] };
const stroke = (id: string): BoardOps => [
  {
    type: "add",
    items: [
      {
        id,
        kind: "ink",
        x: 10,
        y: 10,
        width: 3,
        points: [
          [0, 0, 0.5],
          [5, 5, 0.5],
        ],
      },
    ],
  },
];
/** What the server does with a batch: applies it as the learner and bumps the revision. */
const serve = (board: Board, ops: BoardOps) => applyBoardOps(board, ops, "user").board;

describe("BoardSession", () => {
  it("shows a committed edit before the server confirms it", () => {
    const session = new BoardSession(empty);
    session.commit(stroke("a"));
    expect(session.view.items.map((item) => item.id)).toEqual(["a"]);
    expect(session.revision).toBe(0);
  });

  it("sends one batch at a time and clears it on ack", () => {
    const session = new BoardSession(empty);
    const first = session.commit(stroke("a"))!;
    const second = session.commit(stroke("b"))!;
    expect(session.next()).toBe(first);
    expect(session.next()).toBeUndefined();
    session.ack(first.id, serve(empty, first.ops));
    expect(session.next()).toBe(second);
    expect(session.view.items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("keeps a pending stroke when an agent write lands first", () => {
    const session = new BoardSession(empty);
    session.commit(stroke("mine"));
    const agent = applyBoardOps(
      empty,
      [{ type: "add", items: [{ id: "theirs", kind: "text", text: "F = ma", x: 0, y: 0 }] }],
      "agent",
    ).board;
    session.receive(agent);
    expect(session.view.items.map((item) => item.id)).toEqual(["theirs", "mine"]);
  });

  it("undoes a local add after an agent receives the next generated ID", () => {
    const session = new BoardSession(empty);
    const local = session.commit([{ type: "add", items: [{ kind: "text", text: "mine" }] }])!;
    const agent = applyBoardOps(
      empty,
      [{ type: "add", items: [{ kind: "text", text: "theirs" }] }],
      "agent",
    ).board;
    session.next();
    session.receive(agent);
    const confirmed = serve(agent, local.ops);
    session.ack(local.id, confirmed);
    const undo = session.undo()!;
    expect(
      serve(confirmed, undo.ops).items.map((item) => (item.kind === "text" ? item.text : "")),
    ).toEqual(["theirs"]);
  });

  it("drops a pending batch the server board can no longer take", () => {
    const base = serve(empty, stroke("a"));
    const session = new BoardSession(base);
    session.commit([{ type: "update", id: "a", patch: { x: 50 } }]);
    session.receive(applyBoardOps(base, [{ type: "remove", ids: ["a"] }], "agent").board);
    expect(session.view.items).toEqual([]);
  });

  it("treats an echo that beats the ack as ours, and a later write as foreign", () => {
    const session = new BoardSession(empty);
    const batch = session.commit(stroke("a"))!;
    session.next();
    const confirmed = serve(empty, batch.ops);
    session.receive(confirmed);
    session.ack(batch.id, confirmed);
    expect(session.tally.added).toEqual({ ink: 1 });
    session.receive(
      applyBoardOps(
        confirmed,
        [{ type: "add", items: [{ kind: "text", text: "hi", x: 0, y: 0 }] }],
        "agent",
      ).board,
    );
    expect(session.tally).toEqual({ added: {}, updated: 0, removed: 0 });
  });

  it("undoes and redoes the learner's own edits", () => {
    const session = new BoardSession(empty);
    session.commit(stroke("a"));
    session.commit([{ type: "update", id: "a", patch: { x: 99 } }]);
    session.undo();
    expect(session.view.items[0]).toMatchObject({ id: "a", x: 10 });
    session.undo();
    expect(session.view.items).toEqual([]);
    session.redo();
    expect(session.view.items.map((item) => item.id)).toEqual(["a"]);
    session.commit(stroke("b"));
    expect(session.canRedo).toBe(false);
  });

  it("restores absent optional fields through JSON", () => {
    const base = serve(empty, [
      {
        type: "add",
        items: [
          { id: "text", kind: "text", text: "hello" },
          { id: "table", kind: "table", columns: ["x"], rows: [[1]] },
        ],
      },
    ]);
    const session = new BoardSession(base);
    const change = session.commit([
      { type: "update", id: "text", patch: { color: "red", fontSize: 30, maxWidth: 500 } },
      { type: "update", id: "table", patch: { w: 500, h: 300, view: "table" } },
    ])!;
    session.next();
    const confirmed = serve(base, change.ops);
    session.ack(change.id, confirmed);
    const undo = session.undo()!;
    expect(serve(confirmed, JSON.parse(JSON.stringify(undo.ops))).items).toEqual(base.items);
  });

  it("skips an undo whose target the agent erased", () => {
    const session = new BoardSession(empty);
    const batch = session.commit(stroke("a"))!;
    session.next();
    const confirmed = serve(empty, batch.ops);
    session.ack(batch.id, confirmed);
    session.receive(applyBoardOps(confirmed, [{ type: "clear" }], "agent").board);
    expect(session.undo()).toBeUndefined();
    expect(session.view.items).toEqual([]);
  });

  it("restores erased items with their position", () => {
    const board = serve(empty, stroke("a"));
    const inverse = invertBoardOps(board, [{ type: "remove", ids: ["a"] }]);
    expect(
      applyBoardOps(
        applyBoardOps(board, [{ type: "remove", ids: ["a"] }], "user").board,
        inverse,
        "user",
      ).board.items[0],
    ).toMatchObject({ id: "a", x: 10, y: 10 });
  });
});
