import type { CaptureSource, PcmCapture } from "./capture";

export type DictationState =
  | { readonly status: "idle" }
  | { readonly status: "listening"; readonly startedAt: number }
  | { readonly status: "transcribing" }
  | { readonly status: "error"; readonly message: string };

/** The hook's state machine also runs with a fake capture source in unit tests. */
export function createDictation(options: {
  readonly capture: CaptureSource;
  readonly transcribe: (pcm: Uint8Array, signal: AbortSignal) => Promise<{ readonly text: string }>;
  readonly onText: (text: string) => void;
  readonly onState: (state: DictationState) => void;
}) {
  let state: DictationState = { status: "idle" };
  let capture: PcmCapture | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let acquiring = false;
  let disposed = false;
  const setState = (next: DictationState) => {
    state = next;
    if (!disposed) options.onState(next);
  };
  const fail = (error: unknown) =>
    setState({
      status: "error",
      message: error instanceof Error ? error.message : "Dictation failed",
    });
  const stop = async () => {
    if (acquiring) {
      generation++;
      acquiring = false;
      controller?.abort();
      setState({ status: "idle" });
      return;
    }
    if (state.status !== "listening" || !capture || !controller) return;
    clearTimeout(timer);
    const current = generation;
    const active = capture;
    const signal = controller.signal;
    capture = undefined;
    setState({ status: "transcribing" });
    try {
      const pcm = await active.stop();
      if (signal.aborted || disposed) return;
      const result = await options.transcribe(pcm, signal);
      if (current !== generation || disposed) return;
      if (!result.text.trim()) throw new Error("No speech was detected");
      options.onText(result.text);
      setState({ status: "idle" });
    } catch (error) {
      if (current === generation && !disposed) fail(error);
    } finally {
      active.cancel();
    }
  };
  const start = async () => {
    if (disposed || acquiring || state.status === "listening" || state.status === "transcribing")
      return;
    acquiring = true;
    const current = ++generation;
    controller = new AbortController();
    try {
      const active = await options.capture(controller.signal);
      if (current !== generation || disposed) {
        active.cancel();
        return;
      }
      capture = active;
      acquiring = false;
      setState({ status: "listening", startedAt: Date.now() });
      timer = setTimeout(() => {
        void stop();
      }, 120000);
    } catch (error) {
      if (current === generation && !disposed) {
        acquiring = false;
        fail(error);
      }
    }
  };
  return {
    start,
    stop,
    toggle: () => (acquiring || state.status === "listening" ? stop() : start()),
    dispose: () => {
      disposed = true;
      generation++;
      clearTimeout(timer);
      controller?.abort();
      capture?.cancel();
      capture = undefined;
    },
  };
}
