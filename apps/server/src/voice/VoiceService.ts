import type { VoiceStatus, VoiceSynthesizeInput, VoiceTranscript } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TranscriptionMachine } from "../learn/transcripts/TranscriptionMachine.ts";
import * as VoiceConfig from "./VoiceConfig.ts";
import { exchange, voiceError, VoiceError, type WyomingEvent } from "./WyomingClient.ts";

export { VoiceError } from "./WyomingClient.ts";
export const MAX_PCM_BYTES = 120 * 16000 * 2;
const PCM_FORMAT = { rate: 16000, width: 2, channels: 1 };
/** Covers a slow Nemotron reply; a stopped host fails on its connect timeouts within seconds. */
const nemotronDeadlineMs = (pcmBytes: number) => Math.min(30_000, 4_000 + pcmBytes / 32 / 8);
const NEMOTRON_STATUS_TIMEOUT_MS = 3_000;
const AudioFormat = Schema.Struct({
  rate: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 8000, maximum: 192000 })),
  width: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 4 })),
  channels: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 8 })),
});
const Transcript = Schema.Struct({ text: Schema.String });
const Named = Schema.Struct({ name: Schema.String });
const Program = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  models: Schema.optionalKey(Schema.Array(Named)),
  voices: Schema.optionalKey(Schema.Array(Named)),
});
const Info = Schema.Struct({
  asr: Schema.optionalKey(Schema.Array(Program)),
  tts: Schema.optionalKey(Schema.Array(Program)),
});

const decodeAudioFormat = Schema.decodeUnknownSync(AudioFormat);
const decodeTranscript = Schema.decodeUnknownSync(Transcript);
const decodeInfo = Schema.decodeUnknownSync(Info);

export class VoiceService extends Context.Service<
  VoiceService,
  {
    readonly status: () => Effect.Effect<VoiceStatus>;
    readonly transcribe: (input: {
      readonly pcm: Uint8Array;
      readonly language?: string;
    }) => Effect.Effect<VoiceTranscript, VoiceError>;
    readonly synthesize: (
      input: VoiceSynthesizeInput,
    ) => Effect.Effect<{ readonly wav: Uint8Array; readonly sampleRate: number }, VoiceError>;
  }
>()("t3/voice/VoiceService") {}

function assembleWav(pcm: Uint8Array, format: typeof AudioFormat.Type): Uint8Array {
  const padding = pcm.length % 2;
  const wav = Buffer.alloc(44 + pcm.length + padding);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length + padding, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(format.channels, 22);
  wav.writeUInt32LE(format.rate, 24);
  wav.writeUInt32LE(format.rate * format.width * format.channels, 28);
  wav.writeUInt16LE(format.width * format.channels, 32);
  wav.writeUInt16LE(format.width * 8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  wav.set(pcm, 44);
  return wav;
}

function* transcriptionEvents(pcm: Uint8Array, language: string): Iterable<WyomingEvent> {
  const format = PCM_FORMAT;
  yield { type: "transcribe", data: language ? { language } : {} };
  yield { type: "audio-start", data: format };
  for (let offset = 0; offset < pcm.length; offset += 32000) {
    yield { type: "audio-chunk", data: format, payload: pcm.subarray(offset, offset + 32000) };
  }
  yield { type: "audio-stop" };
}

const make = Effect.gen(function* () {
  const voiceConfig = yield* VoiceConfig.VoiceConfig;
  const machine = yield* TranscriptionMachine;
  const probe = (backend: "stt" | "tts", endpoint: string) =>
    exchange({
      backend,
      endpoint,
      connectTimeoutMs: 1500,
      deadlineMs: 1500,
      events: [{ type: "describe" }],
      receive: (event) => {
        if (event.type !== "info") throw new Error("Expected info");
        const programs = decodeInfo(event.data)[backend === "stt" ? "asr" : "tts"];
        if (!programs?.length) throw new Error("Missing backend capability");
        return programs
          .flatMap(
            (program) =>
              (backend === "stt" ? program.models : program.voices)?.map((item) => item.name) ??
              (program.name ? [program.name] : []),
          )
          .join(", ");
      },
    }).pipe(
      Effect.map((detail) => ({ ok: true, endpoint, detail })),
      Effect.catch((error) => Effect.succeed({ ok: false, endpoint, detail: error.detail })),
    );
  return VoiceService.of({
    status: Effect.fn("VoiceService.status")(function* () {
      const config = yield* voiceConfig.get;
      const nemotron = yield* voiceConfig.nemotron;
      const probeNemotron = nemotron
        ? machine.ready(nemotron).pipe(
            Effect.timeoutOption(NEMOTRON_STATUS_TIMEOUT_MS),
            Effect.map((ready) => {
              const ok = Option.getOrElse(ready, () => false);
              return {
                nemotron: {
                  ok,
                  endpoint: `${nemotron.user}@${nemotron.host}`,
                  detail: ok ? "ready" : "not ready",
                },
              };
            }),
          )
        : Effect.succeed({});
      const [backends, extra] = yield* Effect.all(
        [
          Effect.all(
            { stt: probe("stt", config.sttEndpoint), tts: probe("tts", config.ttsEndpoint) },
            { concurrency: "unbounded" },
          ),
          probeNemotron,
        ],
        { concurrency: "unbounded" },
      );
      return { ...backends, ...extra };
    }),
    transcribe: Effect.fn("VoiceService.transcribe")(function* (input) {
      const config = yield* voiceConfig.get;
      const endpoint = config.sttEndpoint;
      if (!input.pcm.length)
        return yield* voiceError("stt", endpoint, "empty", "received no audio");
      if (input.pcm.length > MAX_PCM_BYTES)
        return yield* voiceError("stt", endpoint, "too-long", "audio exceeds 120 seconds");
      if (input.pcm.length % 2)
        return yield* voiceError("stt", endpoint, "protocol", "requires s16le 16 kHz mono audio");
      const language = input.language ?? config.sttLanguage;
      if (language.length > 64)
        return yield* voiceError("stt", endpoint, "protocol", "language is too long");
      // Nemotron first so dictation uses the GPU host when it is up; any failure falls through.
      const nemotron = yield* voiceConfig.nemotron;
      if (nemotron) {
        const transcript = yield* machine
          .dictate(
            nemotron,
            assembleWav(input.pcm, PCM_FORMAT),
            nemotronDeadlineMs(input.pcm.length),
          )
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning("voice.stt.nemotron-failed", { detail: error.detail }),
            ),
            Effect.option,
          );
        if (Option.isSome(transcript)) {
          yield* Effect.logInfo("voice.stt.transcribed", { backend: "nemotron" });
          return { text: transcript.value, backend: "nemotron" } satisfies VoiceTranscript;
        }
      }
      const text = yield* exchange({
        backend: "stt",
        endpoint,
        deadlineMs: Math.min(90000, 10000 + input.pcm.length / 32),
        events: transcriptionEvents(input.pcm, language),
        receive: (event) => {
          if (event.type !== "transcript") throw new Error("Expected transcript");
          return decodeTranscript(event.data).text.trim();
        },
      });
      if (!text) return yield* voiceError("stt", endpoint, "empty", "returned an empty transcript");
      yield* Effect.logInfo("voice.stt.transcribed", { backend: "whisper" });
      return { text, backend: "whisper" } satisfies VoiceTranscript;
    }),
    synthesize: Effect.fn("VoiceService.synthesize")(function* (input) {
      const config = yield* voiceConfig.get;
      const endpoint = config.ttsEndpoint;
      const text = input.text.trim();
      if (input.text.length > 4000)
        return yield* voiceError("tts", endpoint, "too-long", "text exceeds 4000 characters");
      if (!text) return yield* voiceError("tts", endpoint, "empty", "received no text");
      if ((input.voice?.length ?? 0) > 128)
        return yield* voiceError("tts", endpoint, "protocol", "voice name is too long");
      let format: typeof AudioFormat.Type | undefined;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const audio = yield* exchange({
        backend: "tts",
        endpoint,
        deadlineMs: Math.min(60000, 10000 + 40 * input.text.length),
        events: [
          { type: "synthesize", data: { text, voice: { name: input.voice ?? config.ttsVoice } } },
        ],
        receive: (event) => {
          switch (event.type) {
            case "audio-start":
              if (format) throw new Error("Duplicate audio-start");
              format = decodeAudioFormat(event.data);
              break;
            case "audio-chunk": {
              if (!format || !event.payload?.length)
                throw new Error("Audio without format or payload");
              const chunkFormat = decodeAudioFormat(event.data);
              if (
                chunkFormat.rate !== format.rate ||
                chunkFormat.width !== format.width ||
                chunkFormat.channels !== format.channels
              )
                throw new Error("Format changed");
              bytes += event.payload.length;
              if (bytes > 32 * 1024 * 1024) throw new Error("Audio response too large");
              chunks.push(event.payload);
              break;
            }
            case "audio-stop":
              if (!format || bytes % (format.width * format.channels))
                throw new Error("Invalid audio format or alignment");
              return { pcm: Buffer.concat(chunks), format };
            default:
              throw new Error("Unexpected audio event");
          }
          return undefined;
        },
      });
      if (!audio.pcm.length)
        return yield* voiceError("tts", endpoint, "empty", "returned no audio");
      return { wav: assembleWav(audio.pcm, audio.format), sampleRate: audio.format.rate };
    }),
  });
});
export const layer = Layer.effect(VoiceService, make);
