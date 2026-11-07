import { useAtomValue } from "@effect/atom-react";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { BoardColor, BoardOps } from "@t3tools/physics/board";
import { AsyncResult } from "effect/reactivity";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { BoardSession } from "~/physics/boardSession";
import { liveBoardKey, registerLiveBoard } from "~/physics/liveBoards";
import { boardContextKey, boardContextText } from "~/physics/modelContext";
import { physicsEnvironment } from "~/physics/state";
import { useModelContextNote } from "~/physics/useModelContextNote";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { BoardCanvas, type BoardTool } from "./BoardCanvas";
import { BOARD_TOOLS, BoardToolbar } from "./BoardToolbar";

/**
 * The Latin letter a shortcut means. On a non-Latin layout (Russian, Greek) `key` is the
 * local letter, so fall back to the physical key: Ctrl+Я is still Ctrl+Z.
 */
function shortcutLetter(event: KeyboardEvent<HTMLDivElement>): string {
  const key = event.key.toLowerCase();
  if (/^[a-z]$/.test(key) || !/^Key[A-Z]$/.test(event.code)) return key;
  return event.code.slice(3).toLowerCase();
}

/** A board file in the thread's workspace, live: the learner and the agent draw on it together. */
export function WhiteboardPanel(props: {
  readonly threadRef: ScopedThreadRef;
  /** False for a draft thread: the server resolves the workspace from the project alone. */
  readonly threadStarted: boolean;
  readonly projectId: ProjectId;
  readonly board: string;
}) {
  const { threadRef, threadStarted, projectId, board } = props;
  const { environmentId } = threadRef;
  const threadId = threadStarted ? threadRef.threadId : undefined;
  const events = useAtomValue(
    physicsEnvironment.boardEvents({
      environmentId,
      input: { projectId, ...(threadId ? { threadId } : {}), board },
    }),
  );
  const latest = AsyncResult.isSuccess(events) ? events.value : null;
  const [session, setSession] = useState<BoardSession | null>(null);

  // The first snapshot starts the session; later events rebase it onto the server's board.
  useEffect(() => {
    if (latest === null) return;
    if (session === null) setSession(new BoardSession(latest.board));
    else session.receive(latest.board);
  }, [latest, session]);

  if (session === null) {
    return (
      <div className="flex size-full items-center justify-center bg-black font-mono text-white/60 text-xs">
        {AsyncResult.isFailure(events) ? "Board unavailable" : ""}
      </div>
    );
  }
  return <LiveWhiteboard key={board} {...props} session={session} />;
}

function LiveWhiteboard(props: {
  readonly threadRef: ScopedThreadRef;
  /** False for a draft thread: the server resolves the workspace from the project alone. */
  readonly threadStarted: boolean;
  readonly projectId: ProjectId;
  readonly board: string;
  readonly session: BoardSession;
}) {
  const { threadRef, threadStarted, projectId, board, session } = props;
  const { environmentId } = threadRef;
  const threadId = threadStarted ? threadRef.threadId : undefined;
  const view = useSyncExternalStore(session.subscribe, () => session.view);
  const tally = useSyncExternalStore(session.subscribe, () => session.tally);
  const canUndo = useSyncExternalStore(session.subscribe, () => session.canUndo);
  const canRedo = useSyncExternalStore(session.subscribe, () => session.canRedo);
  const [tool, setTool] = useState<BoardTool>("pen");
  const [color, setColor] = useState<BoardColor>("white");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [fitSignal, setFitSignal] = useState(0);

  const applyBoardOps = useAtomCommand(physicsEnvironment.applyBoardOps, { reportFailure: false });
  const fetchBoard = useAtomCommand(physicsEnvironment.fetchBoard, { reportFailure: false });
  const pumping = useRef(false);
  /** Sends pending batches one at a time; the session drops a batch the server refuses. */
  const send = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      for (let batch = session.next(); batch; batch = session.next()) {
        const result = await applyBoardOps({
          environmentId,
          input: { projectId, ...(threadId ? { threadId } : {}), board, ops: batch.ops },
        });
        if (result._tag === "Success") {
          let confirmed;
          try {
            confirmed = session.boardAfter(result.value);
          } catch {
            const snapshot = await fetchBoard({
              environmentId,
              input: { projectId, ...(threadId ? { threadId } : {}), board },
            });
            if (snapshot._tag !== "Success") {
              session.reject(batch.id);
              break;
            }
            confirmed = snapshot.value.board;
          }
          session.ack(batch.id, confirmed);
        } else {
          session.reject(batch.id);
          toastManager.add({ type: "error", title: "Board edit was not saved" });
        }
      }
    } finally {
      pumping.current = false;
    }
  }, [applyBoardOps, fetchBoard, board, environmentId, projectId, session, threadId]);

  const commit = useCallback(
    (ops: BoardOps) => {
      if (session.commit(ops)) void send();
    },
    [send, session],
  );
  // Lets the sim's snapshot button add to this board through the session, so it can be undone.
  useEffect(
    () =>
      registerLiveBoard(liveBoardKey({ environmentId, projectId, threadId, board }), (ops) => {
        const committed = session.commit(ops) !== undefined;
        if (committed) void send();
        return committed;
      }),
    [board, environmentId, projectId, send, session, threadId],
  );
  const undo = useCallback(() => {
    if (session.undo()) void send();
  }, [send, session]);
  const redo = useCallback(() => {
    if (session.redo()) void send();
  }, [send, session]);

  const pickColor = (next: BoardColor) => {
    setColor(next);
    if (selection.size > 0) {
      commit([...selection].map((id) => ({ type: "update" as const, id, patch: { color: next } })));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
      return;
    const mod = event.ctrlKey || event.metaKey;
    const key = shortcutLetter(event);
    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && key === "y") {
      event.preventDefault();
      redo();
    } else if (!mod && !event.altKey) {
      const match = BOARD_TOOLS.find((entry) => entry.key === key);
      if (match) setTool(match.tool);
    }
  };

  const contextText = boardContextText({ name: board, revision: session.revision, tally });
  useModelContextNote({ environmentId, threadId, key: boardContextKey(board), text: contextText });

  return (
    <div className="flex size-full min-h-0 flex-col bg-black text-white" onKeyDown={onKeyDown}>
      <BoardToolbar
        tool={tool}
        color={color}
        canUndo={canUndo}
        canRedo={canRedo}
        onTool={setTool}
        onColor={pickColor}
        onUndo={undo}
        onRedo={redo}
        onFit={() => setFitSignal((signal) => signal + 1)}
      />
      <div className="min-h-0 flex-1">
        <BoardCanvas
          board={view}
          tool={tool}
          color={color}
          selection={selection}
          onSelectionChange={setSelection}
          onCommit={commit}
          fitSignal={fitSignal}
        />
      </div>
    </div>
  );
}
