import { describe, expect, it, vi } from "vite-plus/test";

import { commitToLiveBoard, liveBoardKey, registerLiveBoard } from "./liveBoards";

const key = liveBoardKey({
  environmentId: "e",
  projectId: "p",
  threadId: undefined,
  board: "main",
});
const ops = [{ type: "clear" }] as const;

describe("live boards", () => {
  it("routes a commit to the open board and reports whether it took it", () => {
    const commit = vi.fn(() => true);
    const unregister = registerLiveBoard(key, commit);
    expect(commitToLiveBoard(key, ops)).toBe(true);
    expect(commit).toHaveBeenCalledWith(ops);
    unregister();
    expect(commitToLiveBoard(key, ops)).toBe(false);
  });

  it("keeps a newer registration when an older one unregisters late", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregisterFirst = registerLiveBoard(key, first);
    const unregisterSecond = registerLiveBoard(key, second);
    unregisterFirst();
    expect(commitToLiveBoard(key, ops)).toBe(true);
    expect(second).toHaveBeenCalled();
    unregisterSecond();
  });

  it("separates draft and started threads", () => {
    const draft = liveBoardKey({
      environmentId: "e",
      projectId: "p",
      threadId: undefined,
      board: "main",
    });
    const started = liveBoardKey({
      environmentId: "e",
      projectId: "p",
      threadId: "t",
      board: "main",
    });
    expect(draft).not.toBe(started);
  });
});
