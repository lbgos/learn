import { useAtomValue } from "@effect/atom-react";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { BoardAddItem, BoardOps } from "@t3tools/physics/board";
import { CameraIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { use, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { commitToLiveBoard, liveBoardKey } from "~/physics/liveBoards";
import { instrumentContextText } from "~/physics/instruments";
import { fitBoardImage } from "~/physics/snapshot";
import { simContextKey, simContextText } from "~/physics/modelContext";
import { SimHost } from "~/physics/simHost";
import { initialSimSource, reduceSimSource, simSourceNotice } from "~/physics/simSource";
import { physicsEnvironment } from "~/physics/state";
import { useModelContextNote } from "~/physics/useModelContextNote";
import { useAtomCommand } from "~/state/use-atom-command";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tip } from "./Tip";
import { SimError, SimParams, SimPlots, SimTransport } from "./SimControls";
import { SimInstrumentResults, SimInstrumentRow } from "./SimInstruments";
import { SimView } from "./SimView";

/**
 * A sim file from the thread's workspace, live: the server pushes the file whenever it changes
 * and the running sim reloads in place, keeping the learner's parameters where they still exist.
 */
export function SimulationPanel(props: {
  readonly threadRef: ScopedThreadRef;
  /** False for a draft thread: the server resolves the workspace from the project alone. */
  readonly threadStarted: boolean;
  readonly projectId: ProjectId;
  readonly path: string;
  /** False while the surface is hidden behind another tab; the sim pauses then. */
  readonly active: boolean;
  /** Model-context note key; a second copy of the sim needs its own, or unmounting clears the other's. */
  readonly contextKey?: string;
}) {
  const { threadRef, threadStarted, projectId, path } = props;
  const active = props.active && !use(BackgroundThreadContext);
  const { environmentId } = threadRef;
  const threadId = threadStarted ? threadRef.threadId : undefined;
  const [host] = useState(() => new SimHost());
  const events = useAtomValue(
    physicsEnvironment.simEvents({
      environmentId,
      input: { projectId, ...(threadId ? { threadId } : {}), path },
    }),
  );
  // The stream carries one event at a time; fold them so a deleted file keeps the last source.
  const latestEvent = AsyncResult.isSuccess(events) ? events.value : null;
  const [source, setSource] = useState(initialSimSource);
  const [foldedEvent, setFoldedEvent] = useState(latestEvent);
  if (latestEvent !== foldedEvent) {
    setFoldedEvent(latestEvent);
    if (latestEvent !== null) setSource(reduceSimSource(source, latestEvent));
  }
  const { file } = source;
  const notice = simSourceNotice(source, path);
  useEffect(() => {
    if (!active) host.pause();
  }, [active, host]);

  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const contextText = useMemo(
    () =>
      snapshot.meta === null
        ? ""
        : [
            simContextText({
              path,
              meta: snapshot.meta,
              params: snapshot.params,
              t: host.t,
              playing: snapshot.playing,
              lastChange: snapshot.lastChange,
            }),
            instrumentContextText({
              playing: snapshot.playing,
              readouts: snapshot.readouts,
              crossing: snapshot.instruments.crossing,
              stopwatch: snapshot.stopwatch,
              recording: snapshot.recording,
            }),
          ]
            .filter(Boolean)
            .join(" "),
    [host, path, snapshot],
  );
  useModelContextNote({
    environmentId,
    threadId,
    key: props.contextKey ?? simContextKey(path),
    text: contextText,
  });

  const applyBoardOps = useAtomCommand(physicsEnvironment.applyBoardOps, { reportFailure: false });
  /** Adds learner items to board main; `item` may wait on the sim, e.g. for a snapshot. */
  const addToBoard = async (what: string, item: () => Promise<BoardAddItem>) => {
    try {
      const ops: BoardOps = [{ type: "add", items: [await item()] }];
      // An open board takes it through its session (undoable); otherwise write to the file.
      if (
        !commitToLiveBoard(liveBoardKey({ environmentId, projectId, threadId, board: "main" }), ops)
      ) {
        const result = await applyBoardOps({
          environmentId,
          input: { projectId, ...(threadId ? { threadId } : {}), board: "main", ops },
        });
        if (result._tag !== "Success") throw new Error(`The board rejected the ${what}.`);
      }
      toastManager.add({ type: "success", title: "Added to board main" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not add ${what}`,
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  const addSnapshotToBoard = () =>
    addToBoard("snapshot", async () => {
      const dataUrl = await host.snapshot();
      if (dataUrl === null) throw new Error("The simulation did not respond.");
      return { kind: "image", ...(await fitBoardImage(dataUrl)) };
    });

  if (file === null) {
    return (
      <div className="flex size-full items-center justify-center bg-black px-4 text-center font-mono text-white/60 text-xs">
        {notice ?? (AsyncResult.isFailure(events) ? `Could not load ${path}` : path)}
      </div>
    );
  }
  return (
    <div className="flex size-full min-h-0 flex-col bg-black text-white">
      <div className="min-h-40 flex-1">
        <SimView host={host} code={file.code} threadRef={threadRef} />
      </div>
      <SimTransport host={host}>
        <Tip label="Snapshot to board">
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Snapshot to board"
            disabled={snapshot.meta === null}
            onClick={() => void addSnapshotToBoard()}
          >
            <CameraIcon />
          </Button>
        </Tip>
      </SimTransport>
      <SimInstrumentRow host={host} />
      <div className="max-h-[45%] shrink-0 overflow-y-auto">
        {notice === null ? null : (
          <div
            role="status"
            className="border-white/10 border-t px-2 py-1.5 font-mono text-2xs text-white/60"
          >
            {notice}
          </div>
        )}
        <SimError host={host} />
        <SimInstrumentResults
          host={host}
          onSendToBoard={(item) => void addToBoard("measurements", async () => item)}
        />
        <SimParams host={host} />
        <SimPlots host={host} />
      </div>
    </div>
  );
}
