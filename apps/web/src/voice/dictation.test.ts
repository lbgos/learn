import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDictation, type DictationState } from "./dictation";
import type { PcmCapture } from "./capture";

afterEach(() => vi.useRealTimers());
function setup() {
  const states: DictationState[] = [];
  const capture = { stop: vi.fn(async () => new Uint8Array([1, 0])), cancel: vi.fn() };
  const source = vi.fn(async (_signal: AbortSignal): Promise<PcmCapture> => capture);
  const transcribe = vi.fn(async (_pcm: Uint8Array, _signal: AbortSignal) => ({
    text: "Pendulum",
  }));
  const onText = vi.fn();
  const controller = createDictation({
    capture: source,
    transcribe,
    onText,
    onState: (state) => states.push(state),
  });
  return { states, capture, source, transcribe, onText, controller };
}

describe("dictation state machine", () => {
  it("captures once, releases capture, transcribes, and inserts text once", async () => {
    const test = setup();
    await test.controller.start();
    await test.controller.start();
    expect(test.source).toHaveBeenCalledTimes(1);
    await test.controller.stop();
    expect(test.states.map((state) => state.status)).toEqual(["listening", "transcribing", "idle"]);
    expect(test.capture.stop).toHaveBeenCalledOnce();
    expect(test.capture.cancel).toHaveBeenCalledOnce();
    expect(test.onText).toHaveBeenCalledExactlyOnceWith("Pendulum");
    test.controller.dispose();
  });
  it("auto-stops at 120 seconds", async () => {
    vi.useFakeTimers();
    const test = setup();
    await test.controller.start();
    await vi.advanceTimersByTimeAsync(120000);
    expect(test.capture.stop).toHaveBeenCalledOnce();
    expect(test.onText).toHaveBeenCalledOnce();
    test.controller.dispose();
  });
  it("turns permission and transcription failures into error states", async () => {
    const test = setup();
    test.source.mockRejectedValueOnce(new Error("Microphone permission denied"));
    await test.controller.start();
    expect(test.states.at(-1)).toEqual({
      status: "error",
      message: "Microphone permission denied",
    });
    await test.controller.start();
    test.transcribe.mockRejectedValueOnce(new Error("Voice is down"));
    await test.controller.stop();
    expect(test.states.at(-1)).toEqual({ status: "error", message: "Voice is down" });
    expect(test.capture.cancel).toHaveBeenCalledOnce();
    test.controller.dispose();
  });
  it("aborts and releases capture on unmount", async () => {
    const test = setup();
    await test.controller.start();
    const signal = test.source.mock.calls[0]?.[0];
    test.controller.dispose();
    expect(signal?.aborted).toBe(true);
    expect(test.capture.cancel).toHaveBeenCalledOnce();
    expect(test.transcribe).not.toHaveBeenCalled();
  });
  it("cancels pending permission acquisition and releases a late microphone", async () => {
    const test = setup();
    let resolveCapture: ((capture: PcmCapture) => void) | undefined;
    test.source.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const starting = test.controller.start();
    await test.controller.stop();
    resolveCapture?.(test.capture);
    await starting;
    expect(test.capture.cancel).toHaveBeenCalledOnce();
    expect(test.states).toEqual([{ status: "idle" }]);
    expect(test.transcribe).not.toHaveBeenCalled();
    test.controller.dispose();
  });
  it("ignores transcription completion after unmount", async () => {
    const test = setup();
    let resolveText: ((value: { text: string }) => void) | undefined;
    test.transcribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveText = resolve;
        }),
    );
    await test.controller.start();
    const stopping = test.controller.stop();
    await Promise.resolve();
    test.controller.dispose();
    resolveText?.({ text: "late" });
    await stopping;
    expect(test.onText).not.toHaveBeenCalled();
  });
});
