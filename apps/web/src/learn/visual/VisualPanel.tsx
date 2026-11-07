import { useAtomValue } from "@effect/atom-react";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { buildVisualDocument } from "@t3tools/physics/visual";
import { AsyncResult } from "effect/reactivity";
import { PauseIcon, PlayIcon, StepBackIcon, StepForwardIcon } from "lucide-react";
import {
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
import { Button } from "~/components/ui/button";
import { visualContextKey, visualContextText } from "~/physics/modelContext";
import { physicsEnvironment } from "~/physics/state";
import { useModelContextNote } from "~/physics/useModelContextNote";
import { VisualCaption } from "./VisualCaption";
import { VisualHost } from "./VisualHost";
import { useVisualSelection, visualSelectionKey } from "./selection";

export function VisualPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly threadStarted: boolean;
  readonly projectId: ProjectId;
  readonly path: string;
  readonly active: boolean;
  /** The step to open at when no Prev/Next selection exists for this visual. */
  readonly initialStep?: number;
  /** Model-context note key; a second copy of the visual needs its own. */
  readonly contextKey?: string;
}) {
  const { threadRef, threadStarted, projectId, path } = props;
  const active = props.active && !use(BackgroundThreadContext);
  const threadId = threadStarted ? threadRef.threadId : undefined;
  const events = useAtomValue(
    physicsEnvironment.simEvents({
      environmentId: threadRef.environmentId,
      input: { projectId, ...(threadId ? { threadId } : {}), path },
    }),
  );
  const file = AsyncResult.isSuccess(events) && events.value.type === "file" ? events.value : null;
  const html = file?.code ?? "";
  const document = useMemo(
    () => (html ? buildVisualDocument(html, { allowMissingCaptions: true }) : ""),
    [html],
  );
  const [host] = useState(() => new VisualHost());
  const iframe = useRef<HTMLIFrameElement>(null);
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const selection = useVisualSelection(
    (value) => value.byPath[visualSelectionKey(threadRef, path)],
  );
  const initialStep = useRef(selection?.step ?? props.initialStep ?? 0);
  initialStep.current = selection?.step ?? props.initialStep ?? 0;
  useLayoutEffect(() => {
    const receive = (event: MessageEvent<unknown>) => host.receive(event);
    window.addEventListener("message", receive);
    // Attach before the iframe's scripts send ready, rather than waiting for onLoad.
    if (iframe.current?.contentWindow)
      host.attach(iframe.current.contentWindow, initialStep.current);
    return () => {
      window.removeEventListener("message", receive);
      host.detach();
    };
  }, [host, document]);
  useEffect(() => {
    if (selection) host.seek(selection.step);
  }, [host, selection]);
  useEffect(() => {
    if (!active) host.pause();
  }, [active, host]);
  const text =
    active && file && state.steps.length
      ? visualContextText({
          path,
          step: state.step,
          labels: state.steps.map((step) => step.label),
          t: state.t,
          playing: state.playing,
        })
      : "";
  useModelContextNote({
    environmentId: threadRef.environmentId,
    threadId,
    key: props.contextKey ?? visualContextKey(path),
    text,
  });
  const disabled = state.steps.length === 0 || state.error !== null;
  const progressStyle = { "--settings-slider-progress": `${state.t * 100}%` } as CSSProperties;
  return (
    <div className="flex size-full min-h-0 flex-col bg-black text-white">
      {file ? (
        <iframe
          ref={iframe}
          title={path}
          sandbox="allow-scripts"
          srcDoc={document}
          onLoad={() => host.connect()}
          className="block h-0 min-h-0 w-full flex-1 border-0 bg-background"
        />
      ) : (
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
          {AsyncResult.isFailure(events)
            ? `Could not load ${path}`
            : AsyncResult.isSuccess(events) && events.value.type === "error"
              ? events.value.message
              : `Waiting for ${path}`}
        </div>
      )}
      {state.error ? (
        <div
          role="alert"
          className="border-t border-border px-3 py-2 text-xs text-destructive-foreground"
        >
          {state.error}
        </div>
      ) : null}
      <div className="flex max-h-[50%] shrink-0 flex-col gap-2 border-t border-border px-3 py-2">
        {state.captions[state.step] ? (
          <p
            aria-label="Step caption"
            aria-live="polite"
            className="min-h-0 overflow-auto text-sm leading-relaxed break-words"
          >
            <VisualCaption text={state.captions[state.step]!} />
          </p>
        ) : null}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Previous step"
            disabled={disabled || state.step === 0}
            onClick={() => host.seek(state.step - 1)}
          >
            <StepBackIcon aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={state.playing ? "Pause" : "Play"}
            disabled={disabled || !active}
            onClick={state.playing ? host.pause : host.play}
          >
            {state.playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
            {state.playing ? "Pause" : "Play"}
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Next step"
            disabled={disabled || state.step >= state.steps.length - 1}
            onClick={() => host.seek(state.step + 1)}
          >
            <StepForwardIcon aria-hidden />
          </Button>
          <span className="min-w-0 flex-1 truncate pl-2 text-xs text-white tabular-nums">
            {state.steps.length
              ? `${state.step + 1}/${state.steps.length} ${state.steps[state.step]?.label}`
              : "Loading"}
          </span>
        </div>
        <input
          aria-label="Step progress"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={state.t}
          disabled={disabled}
          className="settings-slider block w-full min-w-0"
          style={progressStyle}
          onChange={(event) => host.seek(state.step, Number(event.target.value))}
        />
      </div>
    </div>
  );
}
