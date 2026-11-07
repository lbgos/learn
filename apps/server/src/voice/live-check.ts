// Read-only Wyoming check. Run with Node 24: node apps/server/src/voice/live-check.ts
import * as NodePerfHooks from "node:perf_hooks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TranscriptionMachine from "../learn/transcripts/TranscriptionMachine.ts";
import * as VoiceConfig from "./VoiceConfig.ts";
import * as VoiceService from "./VoiceService.ts";

function wavToPcm(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const rate = view.getUint32(24, true);
  const channels = view.getUint16(22, true);
  const width = view.getUint16(34, true) / 8;
  const length = view.getUint32(40, true);
  if (width !== 2) throw new Error(`Live check expects s16le TTS, got width ${width}`);
  const inputLength = length / (channels * width);
  const output = new Uint8Array(Math.floor((inputLength * 16000) / rate) * 2);
  const encoded = new DataView(output.buffer);
  const ratio = rate / 16000;
  for (let i = 0; i < output.length / 2; i++) {
    const start = i * ratio;
    const end = Math.min((i + 1) * ratio, inputLength);
    let sum = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      let mono = 0;
      for (let channel = 0; channel < channels; channel++)
        mono += view.getInt16(44 + (j * channels + channel) * width, true) / channels;
      sum += mono * (Math.min(end, j + 1) - Math.max(start, j));
    }
    encoded.setInt16(i * 2, Math.round(sum / (end - start)), true);
  }
  return output;
}
const config = VoiceConfig.layerStatic({
  sttEndpoint: "tcp://127.0.0.1:10300",
  sttLanguage: "en",
  ttsEndpoint: "tcp://127.0.0.1:10800",
  ttsVoice: "af_heart",
});
const service = VoiceService.layer.pipe(
  Layer.provide(config),
  // Nemotron stays unconfigured here, so the machine is never called.
  Layer.provide(Layer.mock(TranscriptionMachine.TranscriptionMachine)({})),
);
const timings: Record<string, number> = {};
const measured = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const start = NodePerfHooks.performance.now();
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          timings[name] = Math.round(NodePerfHooks.performance.now() - start);
        }),
      ),
    );
  });
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const voice = yield* VoiceService.VoiceService;
    const status = yield* measured("statusMs", voice.status());
    const synthesis = yield* measured(
      "synthesizeMs",
      voice.synthesize({
        text: "The period of a pendulum depends on its length.",
        voice: "af_heart",
      }),
    ).pipe(Effect.result);
    if (synthesis._tag === "Failure") return { status, error: synthesis.failure, timings };
    const pcm = wavToPcm(synthesis.success.wav);
    const transcription = yield* measured(
      "transcribeMs",
      voice.transcribe({ pcm, language: "en" }),
    ).pipe(Effect.result);
    return {
      status,
      sampleRate: synthesis.success.sampleRate,
      wavBytes: synthesis.success.wav.length,
      audioSeconds: pcm.length / 32000,
      transcription,
      timings,
    };
  }).pipe(Effect.provide(service)),
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
