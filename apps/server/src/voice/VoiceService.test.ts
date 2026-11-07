import * as NodeNet from "node:net";
import { afterEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TranscriptionMachine } from "../learn/transcripts/TranscriptionMachine.ts";
import { TranscriptionError, type TranscriptionSettings } from "../learn/transcripts/settings.ts";
import { VoiceService, layer, MAX_PCM_BYTES } from "./VoiceService.ts";
import * as VoiceConfig from "./VoiceConfig.ts";
import { encodeEvent, exchange, WyomingDecoder, type WyomingEvent } from "./WyomingClient.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function createFake(onEvent: (event: WyomingEvent, socket: NodeNet.Socket) => void) {
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = new WyomingDecoder();
    socket.on("data", (data) => {
      for (const event of decoder.push(data)) onEvent(event, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return `tcp://127.0.0.1:${address.port}`;
}
const fake = (onEvent: (event: WyomingEvent, socket: NodeNet.Socket) => void) =>
  Effect.promise(() => createFake(onEvent));
const nemotron: TranscriptionSettings = {
  enabled: true,
  host: "localhost",
  user: "stt",
  identityFile: "/keys/stt",
  nemotronUrl: "http://127.0.0.1:8090",
};
const nemotronDown = () =>
  Effect.fail(new TranscriptionError({ stage: "transcribe", detail: "host is off" }));
/** `machine` is the Nemotron side; without `nemotron` settings the service never calls it. */
function run<A, E>(
  endpoint: string,
  operation: (service: VoiceService["Service"]) => Effect.Effect<A, E>,
  options: {
    readonly nemotron?: TranscriptionSettings;
    readonly machine?: Partial<TranscriptionMachine["Service"]>;
  } = {},
) {
  return Effect.flatMap(VoiceService, operation).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          VoiceConfig.layerStatic(
            {
              sttEndpoint: endpoint,
              sttLanguage: "en",
              ttsEndpoint: endpoint,
              ttsVoice: "af_heart",
            },
            options.nemotron,
          ),
        ),
        Layer.provide(Layer.mock(TranscriptionMachine)(options.machine ?? {})),
      ),
    ),
  );
}

describe("VoiceService", () => {
  it.live("sends correctly chunked PCM and returns the non-streaming transcript", () =>
    Effect.gen(function* () {
      const events: WyomingEvent[] = [];
      const endpoint = yield* fake((event, socket) => {
        events.push(event);
        if (event.type === "audio-stop")
          socket.write(encodeEvent({ type: "transcript", data: { text: " A pendulum. " } }));
      });
      const pcm = new Uint8Array(64000).fill(4);
      expect(
        yield* run(endpoint, (service) => service.transcribe({ pcm, language: "uk" })),
      ).toEqual({ text: "A pendulum.", backend: "whisper" });
      expect(events.map((event) => event.type)).toEqual([
        "transcribe",
        "audio-start",
        "audio-chunk",
        "audio-chunk",
        "audio-stop",
      ]);
      expect(events[0]?.data).toEqual({ language: "uk" });
      expect(
        Buffer.concat(
          events
            .filter((event) => event.type === "audio-chunk")
            .map((event) => event.payload ?? new Uint8Array()),
        ),
      ).toEqual(Buffer.from(pcm));
    }),
  );
  it.live("assembles multiple TTS chunks into a valid WAV", () =>
    Effect.gen(function* () {
      const format = { rate: 24000, width: 2, channels: 1 };
      const endpoint = yield* fake((event, socket) => {
        if (event.type !== "synthesize") return;
        expect(event.data).toEqual({ text: "Hello", voice: { name: "af_heart" } });
        socket.write(
          Buffer.concat([
            encodeEvent({ type: "audio-start", data: format }),
            encodeEvent({ type: "audio-chunk", data: format, payload: new Uint8Array([1, 2]) }),
            encodeEvent({ type: "audio-chunk", data: format, payload: new Uint8Array([3, 4]) }),
            encodeEvent({ type: "audio-stop" }),
          ]),
        );
      });
      const result = yield* run(endpoint, (service) => service.synthesize({ text: "Hello" }));
      const wav = Buffer.from(result.wav);
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(wav.subarray(8, 16).toString()).toBe("WAVEfmt ");
      expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
      expect(wav.readUInt16LE(20)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(24000);
      expect(wav.readUInt32LE(28)).toBe(48000);
      expect(wav.readUInt32LE(40)).toBe(4);
      expect(wav.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(result.sampleRate).toBe(24000);
    }),
  );
  it.live("describes both backend capabilities", () =>
    Effect.gen(function* () {
      const endpoint = yield* fake((event, socket) => {
        if (event.type === "describe")
          socket.write(
            encodeEvent({
              type: "info",
              data: {
                asr: [{ models: [{ name: "large-v3-turbo" }] }],
                tts: [{ voices: [{ name: "af_heart" }, { name: "am_michael" }] }],
              },
            }),
          );
      });
      const status = yield* run(endpoint, (service) => service.status());
      expect(status.stt).toEqual({ ok: true, endpoint, detail: "large-v3-turbo" });
      expect(status.tts.detail).toBe("af_heart, am_michael");
      expect(status).not.toHaveProperty("nemotron");
      const withNemotron = yield* run(endpoint, (service) => service.status(), {
        nemotron,
        machine: { ready: () => Effect.succeed(false) },
      });
      expect(withNemotron.nemotron).toEqual({
        ok: false,
        endpoint: "stt@localhost",
        detail: "not ready",
      });
      expect(withNemotron.stt.ok).toBe(true);
    }),
  );
  it.live("transcribes with Nemotron first, as a 16 kHz WAV, without touching Whisper", () =>
    Effect.gen(function* () {
      const events: WyomingEvent[] = [];
      const endpoint = yield* fake((event) => events.push(event));
      const sent: Uint8Array[] = [];
      const pcm = new Uint8Array(64000).fill(4);
      const result = yield* run(endpoint, (service) => service.transcribe({ pcm }), {
        nemotron,
        machine: {
          dictate: (settings, wav) => {
            expect(settings).toBe(nemotron);
            sent.push(wav);
            return Effect.succeed("A pendulum.");
          },
        },
      });
      expect(result).toEqual({ text: "A pendulum.", backend: "nemotron" });
      expect(events).toEqual([]);
      const wav = Buffer.from(sent[0] ?? []);
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(16000);
      expect(wav.subarray(44)).toEqual(Buffer.from(pcm));
    }),
  );
  it.live("falls back to Whisper when Nemotron fails", () =>
    Effect.gen(function* () {
      const endpoint = yield* fake((event, socket) => {
        if (event.type === "audio-stop")
          socket.write(encodeEvent({ type: "transcript", data: { text: "A pendulum." } }));
      });
      expect(
        yield* run(endpoint, (service) => service.transcribe({ pcm: new Uint8Array(2) }), {
          nemotron,
          machine: { dictate: nemotronDown },
        }),
      ).toEqual({ text: "A pendulum.", backend: "whisper" });
    }),
  );
  it.live("reports connection refused with endpoint and typed reason", () =>
    Effect.gen(function* () {
      const endpoint = yield* fake(() => {});
      yield* Effect.promise(async () => {
        await cleanups.pop()?.();
      });
      const error = yield* run(
        endpoint,
        (service) => service.transcribe({ pcm: new Uint8Array(2) }).pipe(Effect.flip),
        // With Nemotron down as well, the error is still Whisper's.
        { nemotron, machine: { dictate: nemotronDown } },
      );
      expect(error.reason).toBe("unreachable");
      expect(error.endpoint).toBe(endpoint);
      expect(error.message).toContain("refused the connection");
      expect(error.message).toContain(endpoint.slice(6));
    }),
  );
  it.live("times out an accepted but silent peer and closes the socket", () =>
    Effect.gen(function* () {
      const closed = Promise.withResolvers<void>();
      const endpoint = yield* fake((_event, socket) =>
        socket.once("close", () => closed.resolve()),
      );
      const result = yield* exchange({
        endpoint,
        backend: "stt",
        deadlineMs: 40,
        events: [{ type: "describe" }],
        receive: () => undefined,
      }).pipe(Effect.flip);
      expect(result.reason).toBe("timeout");
      yield* Effect.promise(() => closed.promise);
    }),
  );
  it.live("enforces the service transcription deadline for a silent backend", () =>
    Effect.gen(function* () {
      const endpoint = yield* fake(() => {});
      const error = yield* run(endpoint, (service) =>
        service.transcribe({ pcm: new Uint8Array(2) }).pipe(Effect.flip),
      );
      expect(error.reason).toBe("timeout");
      expect(error.message).toContain(endpoint.slice(6));
    }),
  );
  it.live("status enforces its real 1.5 second budget for silent backends", () =>
    Effect.gen(function* () {
      const endpoint = yield* fake(() => {});
      const status = yield* run(endpoint, (service) => service.status());
      expect(status.stt.ok).toBe(false);
      expect(status.tts.ok).toBe(false);
      expect(status.stt.detail).toContain("timed out");
    }),
  );
  it.live("maps garbage responses to protocol failures", () =>
    Effect.gen(function* () {
      const endpoint = yield* fake((_event, socket) => socket.write("garbage\n"));
      expect(
        (yield* run(endpoint, (service) =>
          service.transcribe({ pcm: new Uint8Array(2) }).pipe(Effect.flip),
        )).reason,
      ).toBe("protocol");
    }),
  );
  it.live("rejects empty transcripts", () =>
    Effect.gen(function* () {
      const endpoint = yield* fake((event, socket) => {
        if (event.type === "audio-stop")
          socket.write(encodeEvent({ type: "transcript", data: { text: "  " } }));
      });
      expect(
        (yield* run(endpoint, (service) =>
          service.transcribe({ pcm: new Uint8Array(2) }).pipe(Effect.flip),
        )).reason,
      ).toBe("empty");
    }),
  );
  it.live("rejects invalid inputs before opening a socket", () =>
    Effect.gen(function* () {
      const endpoint = "tcp://127.0.0.1:1";
      expect(
        (yield* run(endpoint, (service) =>
          service.transcribe({ pcm: new Uint8Array() }).pipe(Effect.flip),
        )).reason,
      ).toBe("empty");
      expect(
        (yield* run(endpoint, (service) =>
          service.transcribe({ pcm: new Uint8Array(MAX_PCM_BYTES + 2) }).pipe(Effect.flip),
        )).reason,
      ).toBe("too-long");
      expect(
        (yield* run(endpoint, (service) =>
          service.transcribe({ pcm: new Uint8Array(1) }).pipe(Effect.flip),
        )).reason,
      ).toBe("protocol");
      expect(
        (yield* run(endpoint, (service) => service.synthesize({ text: " " }).pipe(Effect.flip)))
          .reason,
      ).toBe("empty");
      expect(
        (yield* run(endpoint, (service) =>
          service.synthesize({ text: "a".repeat(4001) }).pipe(Effect.flip),
        )).reason,
      ).toBe("too-long");
    }),
  );
  it.live("rejects TTS audio without a start", () =>
    Effect.gen(function* () {
      const endpoint = yield* fake((_event, socket) =>
        socket.write(encodeEvent({ type: "audio-chunk", payload: new Uint8Array(2) })),
      );
      expect(
        (yield* run(endpoint, (service) => service.synthesize({ text: "Hello" }).pipe(Effect.flip)))
          .reason,
      ).toBe("protocol");
    }),
  );
});
