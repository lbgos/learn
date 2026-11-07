import { PauseIcon, PlayIcon, RotateCcwIcon, StepForwardIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";

import type { SampleRing } from "~/physics/plotBuffer";
import { formatQuantity } from "~/physics/modelContext";
import type { SimHost } from "~/physics/simHost";
import { observeResize } from "~/lib/observeResize";
import { Button } from "../ui/button";

const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
// One fixed-timestep frame of the default 1/240 s step is too small to see, so step in 1/12 s.
const STEP_TICKS = 20;
const PLOT_COLORS = ["#fff", "#72b7ff", "#ffac72", "#8bd399"] as const;

/** Simulated time, written straight to the DOM so playing never re-renders the panel. */
function TimeReadout({ host }: { host: SimHost }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const write = (t: number) => {
      if (ref.current) ref.current.textContent = `t ${t.toFixed(2)} s`;
    };
    write(host.t);
    return host.onTime(write);
  }, [host]);
  return <span ref={ref} className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums" />;
}

/** Play/pause, step, reset, speed and time; `children` add surface-specific actions before the time. */
export function SimTransport({ host, children }: { host: SimHost; children?: ReactNode }) {
  const { playing, speed, meta } = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const ready = meta !== null;
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-y border-border px-1.5 sm:h-8">
      <Button
        size="icon-sm"
        variant="ghost-muted"
        aria-label={playing ? "Pause" : "Play"}
        disabled={!ready}
        onClick={playing ? host.pause : host.play}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost-muted"
        aria-label="Step"
        disabled={!ready}
        onClick={() => host.step(STEP_TICKS)}
      >
        <StepForwardIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost-muted"
        aria-label="Reset"
        disabled={!ready}
        onClick={host.reset}
      >
        <RotateCcwIcon />
      </Button>
      <Button
        size="sm"
        variant="ghost-muted"
        aria-label="Speed"
        onClick={() => host.setSpeed(SPEEDS.find((next) => next > speed) ?? SPEEDS[0])}
      >
        {speed}×
      </Button>
      {children}
      <TimeReadout host={host} />
    </div>
  );
}

/** Label, slider and value per declared parameter, two columns where width allows. */
export function SimParams({ host }: { host: SimHost }) {
  const { meta, params } = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const entries = meta ? Object.entries(meta.params) : [];
  if (entries.length === 0) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-4 gap-y-0.5 px-2 py-1.5">
      {entries.map(([name, definition]) => {
        const value = params[name] ?? definition.value;
        const min = definition.min ?? 0;
        const max = definition.max ?? Math.max(1, definition.value * 2);
        const progress = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
        const progressStyle = {
          "--settings-slider-progress": `${progress * 100}%`,
        } as CSSProperties;
        return (
          <label key={name} className="flex h-8 items-center gap-2 text-xs sm:h-7">
            <span className="w-14 shrink-0 truncate text-muted-foreground">
              {definition.label ?? name}
            </span>
            <input
              type="range"
              className="settings-slider min-w-0 flex-1"
              style={progressStyle}
              min={min}
              max={max}
              step={definition.step ?? "any"}
              value={value}
              onChange={(event) => host.setParam(name, Number(event.currentTarget.value))}
            />
            <span className="w-16 shrink-0 text-right text-foreground tabular-nums">
              {formatQuantity(value)}
              {definition.unit ? ` ${definition.unit}` : ""}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function drawPlot(
  canvas: HTMLCanvasElement,
  ring: SampleRing,
  group: readonly string[],
  columns: number[],
) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const left = 56;
  const top = 4;
  const plotWidth = Math.max(1, width - left - 6);
  const plotHeight = Math.max(1, height - top - 4);
  const series = columns.map((column) => ring.series(column, Math.floor(plotWidth)));
  const all = series.flatMap(({ y }) => y);
  let min = all.length > 0 ? all.reduce((a, b) => Math.min(a, b)) : -1;
  let max = all.length > 0 ? all.reduce((a, b) => Math.max(a, b)) : 1;
  // Roundoff in a nearly constant observable should not fill the whole plot.
  const minimumRange = Math.max(1e-6, Math.max(Math.abs(min), Math.abs(max)) * 0.02);
  if (max - min < minimumRange) {
    const mid = (min + max) / 2;
    min = mid - minimumRange / 2;
    max = mid + minimumRange / 2;
  }
  const first = series[0]?.x[0] ?? 0;
  const last = series[0]?.x.at(-1) ?? 1;
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, plotWidth, plotHeight);
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.textAlign = "right";
  ctx.fillText(max.toPrecision(3), left - 4, top + 10);
  ctx.fillText(min.toPrecision(3), left - 4, top + plotHeight);
  series.forEach(({ x, y }, index) => {
    ctx.beginPath();
    ctx.strokeStyle = PLOT_COLORS[index % PLOT_COLORS.length]!;
    ctx.lineWidth = 1.25;
    x.forEach((time, i) => {
      const px = left + ((time - first) / (last - first || 1)) * plotWidth;
      const py = top + (1 - (y[i]! - min) / (max - min)) * plotHeight;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    // A lone point (the t=0 sample before the first frame) has no line to draw.
    if (x.length === 1) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(left, top + (1 - (y[0]! - min) / (max - min)) * plotHeight, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.textAlign = "left";
  group.forEach((name, index) => {
    ctx.fillStyle = PLOT_COLORS[index % PLOT_COLORS.length]!;
    ctx.fillText(name, left + 6, top + 13 + index * 14);
  });
}

/** One canvas per `meta.plots` group. Redraws only when sample rows arrive or the canvas resizes. */
export function SimPlots({ host }: { host: SimHost }) {
  const { meta } = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);
  const groups = meta?.plots ?? [];

  useEffect(() => {
    if (!meta || meta.plots.length === 0) return;
    let frame: number | undefined;
    const draw = () => {
      frame = undefined;
      const ring = host.samples;
      if (!ring) return;
      meta.plots.forEach((group, index) => {
        const canvas = canvases.current[index];
        if (!canvas) return;
        drawPlot(
          canvas,
          ring,
          group,
          group.map((name) => meta.observables.indexOf(name) + 1).filter((column) => column > 0),
        );
      });
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(draw);
    };
    const stopSamples = host.onSamples(schedule);
    const stopResize = observeResize(
      canvases.current.filter((node): node is HTMLCanvasElement => node !== null),
      schedule,
    );
    schedule();
    return () => {
      stopSamples();
      stopResize();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [host, meta]);

  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      {groups.map((group, index) => (
        <canvas
          key={group.join("|")}
          ref={(node) => {
            canvases.current[index] = node;
          }}
          aria-label={`Plot: ${group.join(", ")}`}
          className="h-20 w-full"
        />
      ))}
    </div>
  );
}

/** Load, step or render failure from the sim, with the phase it happened in. */
export function SimError({ host }: { host: SimHost }) {
  const { error } = useSyncExternalStore(host.subscribe, host.getSnapshot);
  if (!error) return null;
  return (
    <pre className="max-h-32 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 font-sans text-xs text-destructive-foreground">
      {`${error.phase}: ${error.message}`}
    </pre>
  );
}
