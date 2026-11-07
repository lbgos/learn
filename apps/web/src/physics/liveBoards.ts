/**
 * Boards currently open in a whiteboard surface, so other surfaces (the sim's snapshot button)
 * can edit them as the learner would: through the board's session, which makes the edit undoable
 * and sends it with the rest of the learner's batches.
 */
import type { BoardOps } from "@t3tools/physics/board";

type Commit = (ops: BoardOps) => boolean;

const live = new Map<string, Commit>();

export function liveBoardKey(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string | undefined;
  readonly board: string;
}): string {
  return [input.environmentId, input.projectId, input.threadId ?? "", input.board].join(":");
}

/** Registers an open board; the returned function unregisters it, unless another took its place. */
export function registerLiveBoard(key: string, commit: Commit): () => void {
  live.set(key, commit);
  return () => {
    if (live.get(key) === commit) live.delete(key);
  };
}

/** True when the board is open and accepted `ops`; false means the caller must write directly. */
export function commitToLiveBoard(key: string, ops: BoardOps): boolean {
  return live.get(key)?.(ops) ?? false;
}
