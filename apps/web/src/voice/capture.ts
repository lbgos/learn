import * as Schema from "effect/Schema";
import { framesToPcm } from "./pcm";

export interface PcmCapture {
  stop: () => Promise<Uint8Array>;
  cancel: () => void;
}
export type CaptureSource = (signal: AbortSignal) => Promise<PcmCapture>;
const isFrame = Schema.is(Schema.instanceOf(Float32Array));

export const startPcmCapture: CaptureSource = async (signal) => {
  if (!globalThis.isSecureContext) throw new Error("Microphone access requires HTTPS or localhost");
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error("This browser does not support microphone capture");
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let stopped = false;
  const frames: Float32Array[] = [];
  let samples = 0;
  const cleanup = () => {
    stopped = true;
    signal.removeEventListener("abort", cleanup);
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.disconnect();
      worklet = undefined;
    }
    source?.disconnect();
    source = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    if (context && context.state !== "closed") void context.close().catch(() => {});
    context = undefined;
  };
  signal.addEventListener("abort", cleanup, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    context = new AudioContext();
    await context.audioWorklet.addModule("/voice/pcm-capture-worklet.js");
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const sampleRate = context.sampleRate;
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (stopped || !isFrame(event.data)) return;
      const remaining = Math.floor(sampleRate * 120) - samples;
      if (remaining <= 0) return;
      const frame = event.data.subarray(0, remaining);
      frames.push(frame);
      samples += frame.length;
    };
    source.connect(worklet);
    // The processor emits silence; a connected output keeps capture running.
    worklet.connect(context.destination);
    await context.resume();
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    return {
      stop: async () => {
        cleanup();
        const pcm = framesToPcm(frames, sampleRate);
        frames.length = 0;
        return pcm;
      },
      cancel: () => {
        cleanup();
        frames.length = 0;
      },
    };
  } catch (error) {
    cleanup();
    if (
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "SecurityError")
    )
      throw new Error(
        "Microphone permission was denied. Allow microphone access in your browser.",
        { cause: error },
      );
    if (error instanceof DOMException && error.name === "NotFoundError")
      throw new Error("No microphone was found", { cause: error });
    if (error instanceof DOMException && error.name === "NotReadableError")
      throw new Error("The microphone is unavailable or in use by another application", {
        cause: error,
      });
    throw error;
  }
};
