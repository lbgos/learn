import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { runSshCommand } from "@t3tools/ssh/command";
import * as ServerConfig from "../../config.ts";
import * as Process from "../../processRunner.ts";
import { quoteRemoteArg } from "../../device/sshDeviceScript.ts";
import { type TranscriptLine, NemotronReply, replySegments, type CaptionCue } from "./format.ts";
import { TranscriptionError, type TranscriptionSettings, remoteBase } from "./settings.ts";
import { ensureYtDlp, ffmpegCommand } from "./tools.ts";
import { TimedText } from "../captions/captions.ts";

/** Model served by Nemotron on the STT host. */
const NEMOTRON_MODEL = "nemotron-transcribe";
const READY_TIMEOUT_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const CONVERT_TIMEOUT_MS = 2 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
const CAPTION_TIMEOUT_MS = 20_000;
// The STT host is often off; a stopped host or service must fail in seconds, not on TCP defaults.
const SSH_CONNECT_TIMEOUT_SECONDS = 2;
const CURL_CONNECT_TIMEOUT_SECONDS = 1;

const STT_SAMPLE_RATE = 16_000;
// The default client served mixed audio from another video on this host; Android returned the
// right stream, and default stays as the fallback when YouTube retires that client.
const YOUTUBE_CLIENT = "youtube:player_client=android,default";

export interface VideoMetadata {
  readonly title: string;
  readonly channel: string;
  readonly durationSeconds: number;
  /** The video's own captions, used to verify chunk replies; empty when unavailable. */
  readonly captions: ReadonlyArray<CaptionCue>;
}

const identityArgs = (settings: TranscriptionSettings) => [
  "-i",
  settings.identityFile,
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
];
const sshTarget = (settings: TranscriptionSettings) => ({
  alias: settings.host,
  hostname: settings.host,
  username: settings.user,
  port: settings.port ?? null,
});

const transcriptError = (stage: TranscriptionError["stage"], detail: string, cause?: unknown) =>
  new TranscriptionError({
    stage,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const Metadata = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  channel: Schema.optional(Schema.NullOr(Schema.String)),
  uploader: Schema.optional(Schema.NullOr(Schema.String)),
  duration: Schema.optional(Schema.NullOr(Schema.Number)),
  language: Schema.optional(Schema.NullOr(Schema.String)),
  subtitles: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ ext: Schema.String, url: Schema.String })),
    ),
  ),
  automatic_captions: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ ext: Schema.String, url: Schema.String })),
    ),
  ),
});
const decodeMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata));
const decodeReply = Schema.decodeEffect(Schema.fromJsonString(NemotronReply));
const decodeCaptions = Schema.decodeUnknownEffect(Schema.fromJsonString(TimedText));

/**
 * The json3 track in the video's own language. Translated tracks are skipped because their words
 * cannot be compared with a transcript of the audio; without a known language only an `-orig`
 * track is safe.
 */
function captionUrl(video: typeof Metadata.Type) {
  const language = video.language ?? undefined;
  const tracks = language
    ? [
        video.subtitles?.[language],
        video.automatic_captions?.[`${language}-orig`],
        video.automatic_captions?.[language],
      ]
    : [video.automatic_captions?.["en-orig"]];
  return tracks.flatMap((list) => list ?? []).find((track) => track.ext === "json3")?.url;
}

/** Cues as seconds; rolling captions repeat text, which only widens the reference bag. */
function captionCues(captions: typeof TimedText.Type): ReadonlyArray<CaptionCue> {
  return captions.events.flatMap((event) => {
    const text = event.segs
      ?.map((segment) => segment.utf8)
      .join("")
      .replace(/\s+/gu, " ")
      .trim();
    if (!text) return [];
    const start = event.tStartMs / 1000;
    return [{ start, end: start + (event.dDurationMs ?? 0) / 1000, text }];
  });
}

/** The STT host: SSH, a pinned yt-dlp, ffmpeg and the Nemotron HTTP endpoint behind it. */
export class TranscriptionMachine extends Context.Service<
  TranscriptionMachine,
  {
    /** A failed probe is "not ready", never a failed tool call: the caller falls back to Gemini. */
    readonly ready: (settings: TranscriptionSettings) => Effect.Effect<boolean>;
    readonly metadata: (url: string) => Effect.Effect<VideoMetadata, TranscriptionError>;
    /** Downloads the video's audio and converts it to 16 kHz mono WAV. */
    readonly audio: (url: string, workDir: string) => Effect.Effect<string, TranscriptionError>;
    readonly slice: (
      wav: string,
      start: number,
      seconds: number,
      out: string,
      /** Leading silence prepended before the audio, to break the STT server's bad replies. */
      padSeconds?: number,
    ) => Effect.Effect<void, TranscriptionError>;
    /** Timestamps are relative to the file, so the caller adds the chunk offset. */
    readonly transcribe: (
      settings: TranscriptionSettings,
      file: string,
    ) => Effect.Effect<ReadonlyArray<TranscriptLine>, TranscriptionError>;
    /** A short WAV clip to plain text, for dictation; fails rather than wait past `timeoutMs`. */
    readonly dictate: (
      settings: TranscriptionSettings,
      wav: Uint8Array,
      timeoutMs: number,
    ) => Effect.Effect<string, TranscriptionError>;
  }
>()("t3/learn/transcripts/TranscriptionMachine") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runner = yield* Process.ProcessRunner;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const toolsDir = path.join(config.stateDir, "tools");

  /** Standalone helpers take their services from here so the methods need no context. */
  const ytDlpBinary = () =>
    ensureYtDlp(toolsDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(Crypto.Crypto, crypto),
    );
  const ffmpegBinary = () =>
    ffmpegCommand(toolsDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const stageFor = (command: string): TranscriptionError["stage"] =>
    command.endsWith("ffmpeg") || command === "ffmpeg" ? "convert" : "download";

  const run = (command: string, args: ReadonlyArray<string>, timeoutMs: number) =>
    runner.run({ command, args, timeout: timeoutMs, maxOutputBytes: 8 * 1024 * 1024 }).pipe(
      Effect.mapError((cause) =>
        transcriptError(
          stageFor(command),
          command === "ffmpeg" || command.endsWith("/ffmpeg")
            ? "ffmpeg is not available on this server."
            : "Could not run yt-dlp on this server.",
          cause,
        ),
      ),
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.succeed(output.stdout)
          : Effect.fail(
              transcriptError(
                stageFor(command),
                command === "ffmpeg" || command.endsWith("/ffmpeg")
                  ? "ffmpeg could not convert the downloaded audio."
                  : "yt-dlp could not fetch the video.",
              ),
            ),
      ),
    );

  const ssh = (
    settings: TranscriptionSettings,
    remote: ReadonlyArray<string>,
    options?: { readonly stdin: string; readonly timeoutMs: number },
  ) =>
    runSshCommand(sshTarget(settings), {
      batchMode: "yes",
      preHostArgs: identityArgs(settings),
      remoteCommandArgs: remote,
      ...options,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const remoteScript = (
    settings: TranscriptionSettings,
    script: string,
    options?: { readonly stdin: string; readonly timeoutMs: number },
  ) => ssh(settings, ["sh", "-c", quoteRemoteArg(script)], options);

  /** Posts a WAV to Nemotron's transcription route on the STT host and decodes the reply. */
  const nemotronReply = Effect.fn("TranscriptionMachine.nemotronReply")(function* (
    settings: TranscriptionSettings,
    wav: Uint8Array,
    fields: ReadonlyArray<string>,
    timeoutMs: number,
  ) {
    const base = yield* Effect.try({
      try: () => remoteBase(settings.nemotronUrl),
      catch: (cause) => transcriptError("settings", "Nemotron URL is invalid.", cause),
    });
    // The shim only takes a string, so the WAV crosses SSH as base64 and is rebuilt on the host.
    const script = [
      'tmp="$(mktemp)" || exit 1',
      'base64 -d > "$tmp" || { rm -f "$tmp"; exit 1; }',
      `curl -sS --connect-timeout ${CURL_CONNECT_TIMEOUT_SECONDS} --max-time ${Math.ceil(timeoutMs / 1000)} -F model=${NEMOTRON_MODEL} ${fields.map((field) => `-F ${field}`).join(" ")} -F "file=@$tmp;type=audio/wav" ${quoteRemoteArg(`${base}/v1/audio/transcriptions`)}`,
      "rc=$?",
      'rm -f "$tmp"',
      "exit $rc",
    ].join("\n");
    const { stdout } = yield* remoteScript(settings, script, {
      stdin: Buffer.from(wav).toString("base64"),
      timeoutMs,
    }).pipe(
      Effect.mapError((cause) =>
        transcriptError("transcribe", "The STT server did not answer over SSH.", cause),
      ),
    );
    return yield* decodeReply(stdout).pipe(
      Effect.mapError((cause) =>
        transcriptError("transcribe", "The STT server returned an unexpected reply.", cause),
      ),
    );
  });

  return TranscriptionMachine.of({
    ready: Effect.fn("TranscriptionMachine.ready")(
      function* (settings) {
        const base = yield* Effect.try({
          try: () => remoteBase(settings.nemotronUrl),
          catch: (cause) => transcriptError("settings", "Nemotron URL is invalid.", cause),
        });
        const script = `curl -fsS --max-time 4 ${quoteRemoteArg(`${base}/ready`)}`;
        const { stdout } = yield* remoteScript(settings, script, {
          stdin: "",
          timeoutMs: READY_TIMEOUT_MS,
        });
        return /"ready"\s*:\s*true/u.test(stdout);
      },
      Effect.orElseSucceed(() => false),
    ),

    metadata: Effect.fn("TranscriptionMachine.metadata")(function* (url) {
      const ytDlp = yield* ytDlpBinary();
      const stdout = yield* run(
        ytDlp,
        [
          "--no-warnings",
          "--socket-timeout",
          "30",
          "--retries",
          "20",
          "--extractor-args",
          YOUTUBE_CLIENT,
          "--skip-download",
          "--no-playlist",
          "-J",
          url,
        ],
        DOWNLOAD_TIMEOUT_MS,
      );
      const video = yield* decodeMetadata(stdout).pipe(
        Effect.mapError((cause) =>
          transcriptError("download", "Could not read the video's metadata.", cause),
        ),
      );
      const channel = video.channel ?? video.uploader;
      if (
        !channel ||
        video.duration === undefined ||
        video.duration === null ||
        video.duration <= 0
      )
        return yield* transcriptError(
          "download",
          "The video has no readable title, channel or duration.",
        );
      const track = captionUrl(video);
      const captions = track
        ? yield* Effect.gen(function* () {
            const response = yield* http.get(track);
            if (response.status !== 200) return [];
            const body = yield* response.text;
            const decoded = yield* decodeCaptions(body).pipe(Effect.orElseSucceed(() => undefined));
            return decoded ? captionCues(decoded) : [];
          }).pipe(
            Effect.timeout(CAPTION_TIMEOUT_MS),
            Effect.orElseSucceed((): ReadonlyArray<CaptionCue> => []),
          )
        : [];
      return { title: video.title, channel, durationSeconds: video.duration, captions };
    }),

    audio: Effect.fn("TranscriptionMachine.audio")(function* (url, workDir) {
      const ytDlp = yield* ytDlpBinary();
      yield* run(
        ytDlp,
        [
          "--no-warnings",
          "--no-progress",
          "--socket-timeout",
          "30",
          "--retries",
          "20",
          "--extractor-args",
          YOUTUBE_CLIENT,
          "--no-playlist",
          "-f",
          "bestaudio/best",
          "-o",
          path.join(workDir, "audio.%(ext)s"),
          url,
        ],
        DOWNLOAD_TIMEOUT_MS,
      );
      const downloaded = (yield* fs
        .readDirectory(workDir)
        .pipe(
          Effect.mapError((cause) =>
            transcriptError("download", "Could not read the download directory.", cause),
          ),
        ))
        .filter((name) => name.startsWith("audio.") && !name.endsWith(".wav"))
        .map((name) => path.join(workDir, name));
      if (downloaded.length !== 1)
        return yield* transcriptError("download", "yt-dlp did not leave one audio file.");
      const ffmpeg = yield* ffmpegBinary();
      const wav = path.join(workDir, "audio.wav");
      yield* run(
        ffmpeg,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          downloaded[0]!,
          "-vn",
          "-ac",
          "1",
          "-ar",
          String(STT_SAMPLE_RATE),
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          wav,
        ],
        CONVERT_TIMEOUT_MS,
      );
      return wav;
    }),

    slice: Effect.fn("TranscriptionMachine.slice")(
      function* (wav, start, seconds, out, padSeconds) {
        const ffmpeg = yield* ffmpegBinary();
        yield* run(
          ffmpeg,
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            String(start),
            "-t",
            String(seconds),
            "-i",
            wav,
            ...(padSeconds ? ["-af", `adelay=${Math.round(padSeconds * 1000)}:all=1`] : []),
            "-ac",
            "1",
            "-ar",
            String(STT_SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            out,
          ],
          CONVERT_TIMEOUT_MS,
        );
      },
    ),

    transcribe: Effect.fn("TranscriptionMachine.transcribe")(function* (settings, file) {
      const bytes = yield* fs
        .readFile(file)
        .pipe(
          Effect.mapError((cause) =>
            transcriptError("transcribe", "Could not read the audio chunk.", cause),
          ),
        );
      const reply = yield* nemotronReply(
        settings,
        bytes,
        ["response_format=verbose_json", '"timestamp_granularities[]=word"'],
        TRANSCRIBE_TIMEOUT_MS,
      );
      return yield* Effect.try({
        try: () => replySegments(reply),
        catch: (cause) =>
          transcriptError("transcribe", "The STT server returned no timestamps.", cause),
      });
    }),

    dictate: Effect.fn("TranscriptionMachine.dictate")(function* (settings, wav, timeoutMs) {
      const reply = yield* nemotronReply(settings, wav, ["response_format=json"], timeoutMs);
      const text = reply.text?.trim();
      if (!text) return yield* transcriptError("transcribe", "The STT server returned no text.");
      return text;
    }),
  });
});

export const layer = Layer.effect(TranscriptionMachine, make).pipe(Layer.provide(Process.layer));
