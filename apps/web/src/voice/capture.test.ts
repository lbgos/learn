import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { startPcmCapture } from "./capture";

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] };
  const getUserMedia = vi.fn(async () => stream);
  const disconnect = vi.fn();
  const close = vi.fn(async () => {});
  class Context {
    sampleRate = 48000;
    state = "running";
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => {}) };
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect });
    resume = vi.fn(async () => {});
    close = close;
  }
  let onFrame: ((event: MessageEvent<unknown>) => void) | undefined;
  class Worklet {
    port = {
      get onmessage() {
        return onFrame;
      },
      set onmessage(value: ((event: MessageEvent<unknown>) => void) | null | undefined) {
        onFrame = value ?? undefined;
      },
    };
    connect = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  return {
    stream,
    stopTrack,
    getUserMedia,
    close,
    disconnect,
    frame: (data: unknown) => onFrame?.(new MessageEvent("message", { data })),
  };
}

describe("microphone capture", () => {
  it("encodes captured frames and releases tracks and the audio context on stop", async () => {
    const test = setup();
    const capture = await startPcmCapture(new AbortController().signal);
    test.frame(new Float32Array([0.5, 0.5, 0.5]));
    expect(await capture.stop()).toEqual(new Uint8Array([0, 64]));
    expect(test.stopTrack).toHaveBeenCalledOnce();
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.disconnect).toHaveBeenCalledTimes(2);
  });
  it("releases tracks when cancelled and ignores malformed worklet messages", async () => {
    const test = setup();
    const controller = new AbortController();
    const capture = await startPcmCapture(controller.signal);
    test.frame({ invalid: true });
    controller.abort();
    expect(test.stopTrack).toHaveBeenCalledOnce();
    capture.cancel();
  });
  it("releases a microphone acquired after cancellation", async () => {
    const test = setup();
    let resolve: ((value: typeof test.stream) => void) | undefined;
    test.getUserMedia.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    const capture = startPcmCapture(controller.signal);
    controller.abort();
    resolve?.(test.stream);
    await expect(capture).rejects.toMatchObject({ name: "AbortError" });
    expect(test.stopTrack).toHaveBeenCalledOnce();
  });
  it("explains denied permission and insecure origins", async () => {
    const test = setup();
    test.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(startPcmCapture(new AbortController().signal)).rejects.toThrow(
      "Microphone permission was denied",
    );
    vi.stubGlobal("isSecureContext", false);
    await expect(startPcmCapture(new AbortController().signal)).rejects.toThrow(
      "HTTPS or localhost",
    );
  });
});
