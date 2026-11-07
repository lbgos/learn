/**
 * The learner's side of a board: the last server board, local batches not yet confirmed, the
 * optimistic `view` the canvas draws, and undo/redo of the learner's own edits.
 *
 * Writes are serialized, one batch per finished stroke or edit. A server event rebases the
 * pending batches onto the new board, so an agent write that lands mid-stroke never loses the
 * stroke. A batch that no longer applies (its item was erased by the agent) is dropped.
 */
import {
  applyBoardOps,
  applyBoardDelta,
  type BoardDelta,
  type Board,
  type BoardAddItem,
  type BoardItemPatch,
  type BoardOps,
} from "@t3tools/physics/board";

import { randomUUID } from "../lib/utils";

import { EMPTY_BOARD_TALLY, type BoardEditTally } from "./modelContext";

export interface LocalBatch {
  readonly id: number;
  readonly ops: BoardOps;
}

interface HistoryEntry {
  readonly redo: BoardOps;
  readonly undo: BoardOps;
}

/** The ops that restore `board` to its state before `ops` ran, in the order to apply them. */
export function invertBoardOps(board: Board, ops: BoardOps): BoardOps {
  const inverses: BoardOps[number][] = [];
  let current = board;
  for (const op of ops) {
    switch (op.type) {
      case "add": {
        const result = applyBoardOps(current, [op], "user");
        inverses.push({ type: "remove", ids: result.createdIds });
        current = result.board;
        continue;
      }
      case "update": {
        const existing = current.items.find((item) => item.id === op.id);
        if (existing) {
          const previous = Object.fromEntries(
            Object.keys(op.patch).map((key) => [
              key,
              existing[key as keyof typeof existing] ?? null,
            ]),
          ) as BoardItemPatch;
          inverses.push({ type: "update", id: op.id, patch: previous });
        }
        break;
      }
      case "remove": {
        const removed = current.items.filter((item) => op.ids.includes(item.id));
        if (removed.length > 0) {
          inverses.push({
            type: "add",
            items: removed.map(({ author: _author, ...item }): BoardAddItem => item),
          });
        }
        break;
      }
      case "clear":
        if (current.items.length > 0) {
          inverses.push({
            type: "add",
            items: current.items.map(({ author: _author, ...item }): BoardAddItem => item),
          });
        }
        break;
    }
    current = applyBoardOps(current, [op], "user").board;
  }
  return inverses.toReversed();
}

function tryApply(board: Board, ops: BoardOps): Board | undefined {
  try {
    return applyBoardOps(board, ops, "user").board;
  } catch {
    return undefined;
  }
}

function addToTally(tally: BoardEditTally, ops: BoardOps): BoardEditTally {
  const added: Partial<Record<keyof typeof tally.added, number>> = { ...tally.added };
  let { updated, removed } = tally;
  for (const op of ops) {
    if (op.type === "add") {
      for (const item of op.items) added[item.kind] = (added[item.kind] ?? 0) + 1;
    } else if (op.type === "update") updated++;
    else if (op.type === "remove") removed += op.ids.length;
  }
  return { added, updated, removed };
}

export class BoardSession {
  private server: Board;
  private pending: LocalBatch[] = [];
  private inFlight: number | null = null;
  // Revisions that arrived while a write was in flight; they are ours or foreign once it acks.
  private unclassified = new Set<number>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private nextBatchId = 1;
  private listeners = new Set<() => void>();
  private currentView: Board;
  private currentTally: BoardEditTally = EMPTY_BOARD_TALLY;

  constructor(initial: Board) {
    this.server = initial;
    this.currentView = initial;
  }

  /** Server board plus unconfirmed local batches. */
  get view(): Board {
    return this.currentView;
  }

  /** Revision of the last server board, the one model context reports. */
  get revision(): number {
    return this.server.revision;
  }

  /** Learner edits confirmed since the last write by anyone else. */
  get tally(): BoardEditTally {
    return this.currentTally;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** For `useSyncExternalStore`; every change replaces `view`, `tally` or the history flags. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private rebase() {
    let board = this.server;
    this.pending = this.pending.filter((batch) => {
      const next = tryApply(board, batch.ops);
      if (next) board = next;
      return next !== undefined || batch.id === this.inFlight;
    });
    this.currentView = board;
  }

  private enqueue(ops: BoardOps): LocalBatch {
    const batch = { id: this.nextBatchId++, ops };
    this.pending.push(batch);
    this.rebase();
    return batch;
  }

  /** Applies an edit optimistically. Returns undefined when it is empty or invalid. */
  commit(ops: BoardOps): LocalBatch | undefined {
    if (ops.length === 0) return undefined;
    ops = ops.map((op) =>
      op.type === "add"
        ? {
            ...op,
            items: op.items.map((item) => ({
              ...item,
              id: item.id ?? `user-${randomUUID()}`,
            })),
          }
        : op,
    );
    let undo: BoardOps;
    try {
      undo = invertBoardOps(this.currentView, ops);
    } catch {
      return undefined;
    }
    const batch = this.enqueue(ops);
    this.undoStack.push({ redo: ops, undo });
    this.redoStack = [];
    this.changed();
    return batch;
  }

  /** Re-applies one side of the newest history entry that still applies to the current view. */
  private replay(from: HistoryEntry[], to: HistoryEntry[], pick: "undo" | "redo") {
    for (let entry = from.pop(); entry; entry = from.pop()) {
      const ops = entry[pick];
      // The agent may have erased or moved what this entry touches; skip entries that no longer fit.
      const result = tryApply(this.currentView, ops);
      if (!result || JSON.stringify(result.items) === JSON.stringify(this.currentView.items)) {
        continue;
      }
      const batch = this.enqueue(ops);
      to.push(entry);
      this.changed();
      return batch;
    }
    this.changed();
    return undefined;
  }

  undo(): LocalBatch | undefined {
    return this.replay(this.undoStack, this.redoStack, "undo");
  }

  redo(): LocalBatch | undefined {
    return this.replay(this.redoStack, this.undoStack, "redo");
  }

  /** The oldest unsent batch, marked in flight; undefined while one is still awaiting its ack. */
  next(): LocalBatch | undefined {
    if (this.inFlight !== null) return undefined;
    const batch = this.pending[0];
    if (batch) this.inFlight = batch.id;
    return batch;
  }

  boardAfter(delta: BoardDelta): Board {
    return applyBoardDelta(this.server, delta);
  }

  /** The server accepted `id`; `board` is the result it produced. */
  ack(id: number, board: Board): void {
    const batch = this.pending.find((entry) => entry.id === id);
    if (this.inFlight === id) this.inFlight = null;
    if (batch) {
      this.pending = this.pending.filter((entry) => entry !== batch);
      const others = [...this.unclassified].filter((revision) => revision !== board.revision);
      if (others.some((revision) => revision < board.revision)) {
        this.currentTally = EMPTY_BOARD_TALLY;
      }
      this.currentTally = addToTally(this.currentTally, batch.ops);
      if (others.some((revision) => revision > board.revision)) {
        this.currentTally = EMPTY_BOARD_TALLY;
      }
    }
    this.unclassified.clear();
    if (board.revision > this.server.revision) this.server = board;
    this.rebase();
    this.changed();
  }

  /** The server refused or never received `id`; the optimistic edit disappears. */
  reject(id: number): void {
    if (this.inFlight === id) this.inFlight = null;
    this.pending = this.pending.filter((entry) => entry.id !== id);
    this.rebase();
    this.changed();
  }

  /** A board from the subscription: the first snapshot, our own echo, or someone else's write. */
  receive(board: Board): void {
    if (board.revision <= this.server.revision && this.server.revision > 0) return;
    if (this.inFlight !== null) this.unclassified.add(board.revision);
    else if (this.server.revision > 0) this.currentTally = EMPTY_BOARD_TALLY;
    this.server = board;
    this.rebase();
    this.changed();
  }
}
