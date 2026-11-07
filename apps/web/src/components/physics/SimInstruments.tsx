import type { BoardAddItem } from "@t3tools/physics/board";
import { intervalStats } from "@t3tools/physics/measure";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChartLineIcon,
  CircleIcon,
  CrosshairIcon,
  FlagIcon,
  SquareIcon,
  TableIcon,
  TimerIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  lapTableItem,
  recordingPlotItem,
  recordingTableItem,
  statsText,
  stopwatchElapsed,
  stopwatchLaps,
} from "~/physics/instruments";
import { formatQuantity } from "~/physics/modelContext";
import type { SimHost } from "~/physics/simHost";
import { Button } from "../ui/button";
import { Tip } from "./Tip";

const Divider = () => <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-white/10" />;

/** Stopwatch dial, written to the DOM on every time update so playing never re-renders. */
function StopwatchReadout({ host }: { host: SimHost }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { stopwatch } = useSyncExternalStore(host.subscribe, host.getSnapshot);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to sim time and writes the DOM directly
  useEffect(() => {
    const write = (t: number) => {
      if (ref.current) ref.current.textContent = `${stopwatchElapsed(stopwatch, t).toFixed(3)} s`;
    };
    write(host.t);
    return stopwatch.running ? host.onTime(write) : undefined;
  }, [host, stopwatch]);
  return (
    <span
      ref={ref}
      className="shrink-0 px-1 text-xs whitespace-nowrap text-white/90 tabular-nums"
    />
  );
}

/** Crossing level; commits on every parseable edit and keeps partial input like "-" local. */
function LevelInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    if (Number(text) !== value) setText(String(value));
  }
  return (
    <input
      aria-label="Crossing level"
      inputMode="decimal"
      className="h-8 w-14 shrink-0 rounded-md border border-white/15 bg-black px-1.5 text-white text-xs tabular-nums outline-none focus-visible:border-white/50 sm:h-7"
      value={text}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        const parsed = Number(next);
        if (next.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  );
}

/** The instrument row: probe mode, stopwatch with manual or auto laps, and recording. */
export function SimInstrumentRow({ host }: { host: SimHost }) {
  const { meta, instruments, stopwatch, recording } = useSyncExternalStore(
    host.subscribe,
    host.getSnapshot,
  );
  const ready = meta !== null;
  const { crossing, probeMode, probes } = instruments;
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-white/10 border-b px-1.5 text-xs sm:h-8">
      <Tip label="Probe: click an object to pin its readout">
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Probe"
          aria-pressed={probeMode}
          data-pressed={probeMode || undefined}
          disabled={!ready}
          onClick={host.toggleProbeMode}
        >
          <CrosshairIcon />
        </Button>
      </Tip>
      {probes.length === 0 ? null : (
        <Tip label="Unpin all probes">
          <Button
            size="sm"
            variant="ghost-muted"
            aria-label="Unpin all probes"
            onClick={host.clearProbes}
          >
            {probes.length}
            <XIcon />
          </Button>
        </Tip>
      )}
      <Divider />
      <Tip label={stopwatch.running ? "Stop stopwatch" : "Start stopwatch (simulated time)"}>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={stopwatch.running ? "Stop stopwatch" : "Start stopwatch"}
          data-pressed={stopwatch.running || undefined}
          disabled={!ready}
          onClick={stopwatch.running ? host.stopStopwatch : host.startStopwatch}
        >
          {stopwatch.running ? <SquareIcon /> : <TimerIcon />}
        </Button>
      </Tip>
      <Tip label="Lap">
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Lap"
          disabled={!stopwatch.running || crossing !== null}
          onClick={host.lap}
        >
          <FlagIcon />
        </Button>
      </Tip>
      <StopwatchReadout host={host} />
      <select
        aria-label="Auto lap"
        className="h-8 min-w-0 max-w-32 shrink truncate rounded-md border border-white/15 bg-black px-1.5 text-white text-xs outline-none focus-visible:border-white/50 sm:h-7"
        disabled={!ready}
        value={crossing?.observable ?? ""}
        onChange={(event) => {
          const observable = event.currentTarget.value;
          host.setAutoLap(
            observable === ""
              ? null
              : { observable, value: crossing?.value ?? 0, direction: crossing?.direction ?? "up" },
          );
        }}
      >
        <option value="">manual laps</option>
        {meta?.observables.map((name) => (
          <option key={name} value={name}>
            lap on {name}
          </option>
        ))}
      </select>
      {crossing === null ? null : (
        <>
          <Tip label={crossing.direction === "up" ? "Crossing upward" : "Crossing downward"}>
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Crossing direction"
              onClick={() =>
                host.setAutoLap({
                  ...crossing,
                  direction: crossing.direction === "up" ? "down" : "up",
                })
              }
            >
              {crossing.direction === "up" ? <ArrowUpIcon /> : <ArrowDownIcon />}
            </Button>
          </Tip>
          <LevelInput
            value={crossing.value}
            onChange={(value) => host.setAutoLap({ ...crossing, value })}
          />
        </>
      )}
      <Divider />
      <Tip label={recording?.active ? "Stop recording" : "Record observables"}>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={recording?.active ? "Stop recording" : "Record"}
          data-pressed={recording?.active || undefined}
          disabled={!ready}
          onClick={recording?.active ? host.stopRecording : host.startRecording}
        >
          {recording?.active ? (
            <SquareIcon />
          ) : (
            <CircleIcon className="fill-current text-destructive" />
          )}
        </Button>
      </Tip>
    </div>
  );
}

/** Lap list with statistics, and the finished recording, each with its board actions. */
export function SimInstrumentResults({
  host,
  onSendToBoard,
}: {
  host: SimHost;
  onSendToBoard: (item: BoardAddItem) => void;
}) {
  const { stopwatch, recording, instruments } = useSyncExternalStore(
    host.subscribe,
    host.getSnapshot,
  );
  const { crossing } = instruments;
  const laps = stopwatchLaps(stopwatch);
  const stats = intervalStats(laps);
  if (stopwatch.startedAt === null && recording === null) return null;
  const first = recording?.rows[0]?.[0];
  const last = recording?.rows.at(-1)?.[0];
  return (
    <div className="flex flex-col gap-0.5 border-white/10 border-t px-2 py-1 text-xs">
      {stopwatch.startedAt === null ? null : (
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-white/90 tabular-nums">
              {stats
                ? statsText(stats)
                : crossing && stopwatch.running
                  ? `waiting for ${crossing.observable} ${crossing.direction === "up" ? "↑" : "↓"} ${formatQuantity(crossing.value)}`
                  : "no laps"}
            </div>
            {laps.length === 0 ? null : (
              <ol className="flex flex-wrap gap-x-3 font-mono text-2xs text-white/70 tabular-nums">
                {laps.map((lap, index) => (
                  // Laps only append, so the index is a stable key.
                  // oxlint-disable-next-line react/no-array-index-key
                  <li key={index}>
                    <span className="text-white/40">{index + 1}</span> {formatQuantity(lap)}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <Tip label="Laps to board">
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Laps to board"
              disabled={laps.length === 0}
              onClick={() => onSendToBoard(lapTableItem(laps, crossing))}
            >
              <TableIcon />
            </Button>
          </Tip>
          <Tip label="Clear laps">
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Clear laps"
              onClick={host.clearStopwatch}
            >
              <XIcon />
            </Button>
          </Tip>
        </div>
      )}
      {recording === null ? null : (
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 truncate font-mono text-white/90 tabular-nums">
            {recording.active
              ? "recording"
              : `${recording.rows.length} samples${first === undefined || last === undefined ? "" : `, t ${formatQuantity(first)}…${formatQuantity(last)} s`}`}
          </div>
          <Tip label="Recording to board as a table">
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Recording table to board"
              disabled={recording.active || recording.rows.length === 0}
              onClick={() => onSendToBoard(recordingTableItem(recording))}
            >
              <TableIcon />
            </Button>
          </Tip>
          <Tip label="Recording to board as a plot">
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Recording plot to board"
              disabled={recording.active || recording.rows.length === 0}
              onClick={() => onSendToBoard(recordingPlotItem(recording))}
            >
              <ChartLineIcon />
            </Button>
          </Tip>
          <Tip label="Clear recording">
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Clear recording"
              onClick={host.clearRecording}
            >
              <XIcon />
            </Button>
          </Tip>
        </div>
      )}
    </div>
  );
}
