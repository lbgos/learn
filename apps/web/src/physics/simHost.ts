/**
 * Host side of the sandboxed simulation iframe (see `@t3tools/physics/sim`). One `SimHost` owns
 * one iframe: it forwards commands, and keeps the latest meta, run state and parameter values.
 *
 * `t` and sample rows arrive many times a second, so they have their own listeners and never go
 * through `subscribe`/`getSnapshot`, which React reads and which only change on discrete events.
 * Sample rows are kept in `samples` as they arrive, so a plot that mounts or subscribes late (the
 * t=0 row comes right after `ready`) still draws everything received so far.
 *
 * The host also owns the lab instruments (see `instruments.ts`) and resends their setup to the
 * runtime after every `ready`, so pins and the auto-lap trigger survive reloads. Probe readouts
 * reach the snapshot only while paused; while playing the runtime draws them itself.
 */
import type { CrossingSpec } from "@t3tools/physics/measure";
import type {
  SimError,
  SimFrameMessage,
  SimHostMessage,
  SimInstruments,
  SimMeta,
  SimProbeReadout,
} from "@t3tools/physics/sim";

import {
  IDLE_STOPWATCH,
  markStopwatch,
  startStopwatch,
  stopStopwatch,
  type Recording,
  type Stopwatch,
} from "./instruments";

import type { SimParamChange } from "./modelContext";
import { SampleRing } from "./plotBuffer";

/** A key the sim passed on; see `SimFrameMessage`. */
export type SimKeyDown = Extract<SimFrameMessage, { type: "keydown" }>;

export interface SimHostSnapshot {
  readonly meta: SimMeta | null;
  readonly playing: boolean;
  readonly speed: number;
  readonly error: SimError | null;
  /** Current parameter values, defaults until the learner changes one. */
  readonly params: Readonly<Record<string, number>>;
  readonly lastChange: SimParamChange | null;
  /** Probe mode, pinned probes and the auto-lap trigger (null: manual laps). */
  readonly instruments: SimInstruments;
  /** Probe readouts as of the last pause, step or pin change. */
  readonly readouts: readonly SimProbeReadout[];
  readonly stopwatch: Stopwatch;
  readonly recording: Recording | null;
}

/** Recording stops by itself after this many rows, 5 minutes at the runtime's 20 Hz. */
const MAX_RECORDED_ROWS = 6000;

const INITIAL: SimHostSnapshot = {
  meta: null,
  playing: false,
  speed: 1,
  error: null,
  params: {},
  lastChange: null,
  instruments: { probeMode: false, probes: [], crossing: null },
  readouts: [],
  stopwatch: IDLE_STOPWATCH,
  recording: null,
};

export class SimHost {
  private iframe: HTMLIFrameElement | null = null;
  private snapshotValue: SimHostSnapshot = INITIAL;
  private elapsed = 0;
  private booted = false;
  private bootCode: string | null = null;
  private wantedCode: string | null = null;
  /** Parameter values from before a reload, restored on the next `ready` where they still fit. */
  private carriedParams: Readonly<Record<string, number>> | null = null;
  private listeners = new Set<() => void>();
  private timeListeners = new Set<(t: number) => void>();
  private sampleListeners = new Set<() => void>();
  private keyListeners = new Set<(key: SimKeyDown, frame: HTMLIFrameElement) => void>();
  /** Rows of the current sim, one column per observable after the time; null before `ready`. */
  samples: SampleRing | null = null;
  private snapshotWaiters: Array<(dataUrl: string) => void> = [];
  private latestReadouts: readonly SimProbeReadout[] = [];
  /** Rows of the active recording; the snapshot gets a copy when it stops. */
  private recordedRows: number[][] = [];

  /** Binds the iframe whose document was built from `code`. */
  attach(iframe: HTMLIFrameElement | null, code: string): void {
    this.iframe = iframe;
    this.booted = false;
    this.bootCode = code;
  }

  get t(): number {
    return this.elapsed;
  }

  getSnapshot = (): SimHostSnapshot => this.snapshotValue;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onTime(listener: (t: number) => void): () => void {
    this.timeListeners.add(listener);
    return () => this.timeListeners.delete(listener);
  }

  /** Fires after rows were added to `samples`. */
  onSamples(listener: () => void): () => void {
    this.sampleListeners.add(listener);
    return () => this.sampleListeners.delete(listener);
  }

  /**
   * Keys the sim passed on (modifier chords and Escape, which a focused frame would otherwise
   * keep from the app). Only messages from this host's iframe arrive, with that iframe.
   */
  onKeyDown(listener: (key: SimKeyDown, frame: HTMLIFrameElement) => void): () => void {
    this.keyListeners.add(listener);
    return () => this.keyListeners.delete(listener);
  }

  private update(patch: Partial<SimHostSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const listener of this.listeners) listener();
  }

  private post(message: SimHostMessage) {
    this.iframe?.contentWindow?.postMessage(message, "*");
  }

  /** Message listener; ignores everything that did not come from this host's iframe. */
  handleMessage = (event: MessageEvent<unknown>): void => {
    if (!this.iframe || event.source !== this.iframe.contentWindow) return;
    const message = event.data as SimFrameMessage | null;
    if (!message || typeof message !== "object" || !("type" in message)) return;
    switch (message.type) {
      case "ready": {
        const params: Record<string, number> = {};
        const restored: Record<string, number> = {};
        for (const [name, definition] of Object.entries(message.meta.params)) {
          const carried = this.carriedParams?.[name];
          const fits =
            carried !== undefined &&
            Number.isFinite(carried) &&
            (definition.min === undefined || carried >= definition.min) &&
            (definition.max === undefined || carried <= definition.max);
          params[name] = fits ? carried : definition.value;
          if (fits && carried !== definition.value) restored[name] = carried;
        }
        this.carriedParams = null;
        this.booted = true;
        this.samples = new SampleRing(message.meta.observables.length + 1);
        const { instruments } = this.snapshotValue;
        const crossing =
          instruments.crossing && message.meta.observables.includes(instruments.crossing.observable)
            ? instruments.crossing
            : null;
        this.stopInstruments();
        this.update({
          meta: message.meta,
          error: null,
          params,
          lastChange: null,
          playing: false,
          instruments: { ...instruments, crossing },
        });
        // The runtime keeps its setup across reloads; resend it in case a trigger was dropped.
        if (instruments.probeMode || instruments.probes.length > 0 || instruments.crossing)
          this.postInstruments();
        if (Object.keys(restored).length > 0) this.post({ type: "setParams", params: restored });
        // A reload requested before the first document booted could not be delivered.
        if (this.wantedCode !== null && this.wantedCode !== this.bootCode)
          this.load(this.wantedCode);
        break;
      }
      case "samples":
        this.samples?.push(message.rows);
        if (this.snapshotValue.recording?.active) this.record(message.rows);
        for (const listener of this.sampleListeners) listener();
        break;
      case "state":
        // Time going back means a reset or parameter change restarted the run.
        if (message.t < this.elapsed) this.stopInstruments();
        this.elapsed = message.t;
        for (const listener of this.timeListeners) listener(message.t);
        if (message.playing !== this.snapshotValue.playing)
          this.update(
            message.playing ? { playing: true } : { playing: false, readouts: this.latestReadouts },
          );
        break;
      case "probes":
        this.latestReadouts = message.readouts;
        if (!this.snapshotValue.playing) this.update({ readouts: message.readouts });
        break;
      case "pick": {
        const { instruments } = this.snapshotValue;
        const probes = instruments.probes.includes(message.path)
          ? instruments.probes.filter((path) => path !== message.path)
          : [...instruments.probes, message.path].slice(-8);
        this.setInstruments({ probes });
        break;
      }
      case "crossing":
        if (this.snapshotValue.instruments.crossing)
          this.update({ stopwatch: markStopwatch(this.snapshotValue.stopwatch, message.t) });
        break;
      case "error":
        this.booted = true;
        this.update({
          error: {
            message: message.message,
            phase: message.phase,
            ...(message.stack ? { stack: message.stack } : {}),
          },
          playing: false,
        });
        break;
      case "keydown":
        for (const listener of this.keyListeners) listener(message, this.iframe);
        break;
      case "snapshot":
        for (const resolve of this.snapshotWaiters.splice(0)) resolve(message.dataUrl);
        break;
    }
  };

  /**
   * Replaces the running sim's source without rebuilding the iframe. The learner's parameter
   * values carry over to the new source wherever the name and range still fit.
   */
  load(code: string): void {
    this.wantedCode = code;
    if (!this.booted) return;
    this.bootCode = code;
    this.carriedParams = this.snapshotValue.params;
    this.update({ error: null });
    this.post({ type: "load", code });
  }

  play = () => this.post({ type: "play" });
  pause = () => this.post({ type: "pause" });
  reset = () => this.post({ type: "reset" });
  step = (count: number) => this.post({ type: "step", count });

  setSpeed = (speed: number) => {
    this.update({ speed });
    this.post({ type: "setSpeed", speed });
  };

  /** Changing a parameter restarts the run, paused, so samples and time start over. */
  setParam = (name: string, value: number) => {
    const from = this.snapshotValue.params[name];
    if (from === undefined || from === value) return;
    this.update({
      params: { ...this.snapshotValue.params, [name]: value },
      lastChange: { name, from, to: value },
      playing: false,
    });
    this.post({ type: "setParams", params: { [name]: value } });
  };

  private postInstruments() {
    this.post({ type: "instruments", ...this.snapshotValue.instruments });
  }

  private setInstruments(patch: Partial<SimInstruments>) {
    this.update({ instruments: { ...this.snapshotValue.instruments, ...patch } });
    this.postInstruments();
  }

  /** Stops the stopwatch and recording, keeping their data; the run they timed is gone. */
  private stopInstruments() {
    const { stopwatch } = this.snapshotValue;
    if (stopwatch.running) this.update({ stopwatch: stopStopwatch(stopwatch, this.elapsed) });
    if (this.snapshotValue.recording?.active) this.stopRecording();
  }

  private record(rows: readonly number[][]) {
    for (const row of rows) {
      const last = this.recordedRows.at(-1);
      if (last && row[0]! <= last[0]!) continue;
      this.recordedRows.push(row);
      if (this.recordedRows.length >= MAX_RECORDED_ROWS) return this.stopRecording();
    }
  }

  toggleProbeMode = () =>
    this.setInstruments({ probeMode: !this.snapshotValue.instruments.probeMode });

  clearProbes = () => this.setInstruments({ probes: [] });

  /** Auto-laps on `crossing`, or manual laps with null. Changing it stops the stopwatch. */
  setAutoLap = (crossing: CrossingSpec | null) => {
    this.update({ stopwatch: stopStopwatch(this.snapshotValue.stopwatch, this.elapsed) });
    this.setInstruments({ crossing });
  };

  startStopwatch = () =>
    this.update({
      stopwatch: startStopwatch(this.elapsed, this.snapshotValue.instruments.crossing !== null),
    });

  stopStopwatch = () =>
    this.update({ stopwatch: stopStopwatch(this.snapshotValue.stopwatch, this.elapsed) });

  /** A manual lap at the current simulated time. */
  lap = () => this.update({ stopwatch: markStopwatch(this.snapshotValue.stopwatch, this.elapsed) });

  clearStopwatch = () => this.update({ stopwatch: IDLE_STOPWATCH });

  /** Collects every sample row from now on: `[t, ...observables]`. */
  startRecording = () => {
    const { meta } = this.snapshotValue;
    if (!meta) return;
    this.recordedRows = [];
    this.update({ recording: { active: true, columns: ["t (s)", ...meta.observables], rows: [] } });
  };

  stopRecording = () => {
    const { recording } = this.snapshotValue;
    if (!recording?.active) return;
    this.update({ recording: { ...recording, active: false, rows: this.recordedRows } });
    this.recordedRows = [];
  };

  clearRecording = () => {
    this.recordedRows = [];
    this.update({ recording: null });
  };

  /** PNG data URL of the viewport and plots, or null when the sim never answers. */
  snapshot(): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5_000);
      this.snapshotWaiters.push((dataUrl) => {
        clearTimeout(timer);
        resolve(dataUrl);
      });
      this.post({ type: "snapshot" });
    });
  }
}
