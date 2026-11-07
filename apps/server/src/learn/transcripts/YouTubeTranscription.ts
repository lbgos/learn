import type { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import * as Invocation from "../../mcp/McpInvocationContext.ts";
import * as Orchestration from "../../mcp/OrchestratorMcpService.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../../project/ProjectService.ts";
import { videoIdFromUrl } from "../captions/captions.ts";
import { ingestTranscript } from "../cortex/transcript.ts";
import { LearnModelRouter } from "../LearnModelRouter.ts";
import {
  type TranscriptLine,
  type TranscriptResult,
  type TranscriptSource,
  formatTranscript,
  matchesCaptions,
  parseTranscript,
  planChunks,
  stamp,
  toLines,
  wordCount,
} from "./format.ts";
import {
  readTranscriptionSettings,
  TRANSCRIPTION_SETTINGS_FILE,
  TranscriptionError,
  type TranscriptionSettings,
} from "./settings.ts";
import { TranscriptionMachine } from "./TranscriptionMachine.ts";

/**
 * Ten-minute chunks keep the STT server fast: an 18:32 talk took 17 s + 13 s as two requests and
 * 111 s as one. A short video is one request.
 */
const CHUNK_SECONDS = 600;
/**
 * The STT server answers some slices with a fluent transcript of an unrelated recording. A quarter
 * second of leading silence made it transcribe both known bad slices correctly, so a flagged chunk
 * is sliced again with that much silence in front.
 */
const RETRY_PAD_SECONDS = 0.25;
const GEMINI_TIMEOUT_MS = 20 * 60_000;

const GEMINI_PROMPT = (id: string, root: string) =>
  `Transcribe this YouTube video yourself: https://www.youtube.com/watch?v=${id}

Fetch the video's audio and transcribe the speech with timestamps. Do not use youtube_captions, another transcript tool, or a transcript someone else wrote.

Write exactly one file, ${root}/transcripts/${id}.md, starting with these three lines and then one timestamped line per 15 seconds of speech:

# <video title>
channel: <channel> | url: https://www.youtube.com/watch?v=${id} | duration: <mm:ss>
source: gemini

[mm:ss] spoken words

Use the video's real title, channel and duration. Keep the spoken wording; do not summarize. Edit no other file. Reply with the path and the word count.`;

export class YouTubeTranscription extends Context.Service<
  YouTubeTranscription,
  {
    readonly transcribe: (
      scope: Invocation.McpInvocationScope,
      url: string,
    ) => Effect.Effect<TranscriptResult, TranscriptionError>;
  }
>()("t3/learn/transcripts/YouTubeTranscription") {}

const failure = (stage: TranscriptionError["stage"], detail: string, cause?: unknown) =>
  new TranscriptionError({ stage, detail, ...(cause === undefined ? {} : { cause }) });

const CortexConnection = Schema.Struct({
  url: Schema.String,
  writeBearerToken: Schema.String.check(Schema.isMinLength(24)),
});
const decodeCortex = Schema.decodeUnknownEffect(Schema.fromJsonString(CortexConnection));

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const machine = yield* TranscriptionMachine;
  const orchestration = yield* Orchestration.OrchestratorMcpService;
  const router = yield* LearnModelRouter;

  const settings = readTranscriptionSettings(
    fs,
    path.join(config.stateDir, TRANSCRIPTION_SETTINGS_FILE),
  );

  const labRoot = Effect.fn("YouTubeTranscription.labRoot")(function* (threadId: ThreadId) {
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((cause) =>
          failure("workspace", "Could not load the learning session.", cause),
        ),
      );
    if (!thread || thread.deletedAt !== null)
      return yield* failure("workspace", "Could not load the learning session.");
    if (thread.worktreePath) return thread.worktreePath;
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(
        Effect.mapError((cause) => failure("workspace", "Could not load the Lab folder.", cause)),
      );
    if (Option.isNone(project))
      return yield* failure("workspace", "Could not load the Lab folder.");
    return project.value.workspaceRoot;
  });

  /** Ingestion never fails the call: the transcript is still usable and `indexed` says so. */
  const ingest = Effect.fn("YouTubeTranscription.ingest")(function* (
    relative: string,
    content: string,
  ) {
    const connection = yield* fs.readFileString(path.join(config.stateDir, "cortex-mcp.json")).pipe(
      Effect.flatMap(decodeCortex),
      Effect.orElseSucceed(() => undefined),
    );
    if (!connection)
      return {
        indexed: false,
        warning:
          "Cortex is not configured on this server; the transcript is saved but not indexed.",
      };
    const receipt = yield* Effect.tryPromise({
      try: () => ingestTranscript(relative, content, connection),
      catch: (cause) => failure("cortex", "Cortex ingestion failed.", cause),
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (!receipt)
      return {
        indexed: false,
        warning: "Cortex is unavailable; the transcript is saved but not indexed.",
      };
    return receipt.indexed
      ? { indexed: true, warning: undefined }
      : { indexed: false, warning: "Cortex did not index the transcript." };
  });

  const finish = Effect.fn("YouTubeTranscription.finish")(function* (
    relative: string,
    content: string,
    parsed: {
      readonly title: string;
      readonly channel: string;
      readonly duration: string;
      readonly source: TranscriptSource;
      readonly lines: ReadonlyArray<TranscriptLine>;
    },
  ) {
    const receipt = yield* ingest(relative, content);
    const result: TranscriptResult = {
      path: relative,
      title: parsed.title,
      channel: parsed.channel,
      duration: parsed.duration,
      source: parsed.source,
      words: wordCount(parsed.lines),
      indexed: receipt.indexed,
      ...(receipt.warning === undefined ? {} : { warning: receipt.warning }),
    };
    return result;
  });

  const readTranscript = (absolute: string) =>
    fs
      .readFileString(absolute)
      .pipe(
        Effect.mapError((cause) => failure("file", "Could not read the transcript file.", cause)),
      );

  /** All local media work happens in one temp directory under the state cache, removed at the end. */
  const withWorkDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      fs.makeDirectory(path.join(config.stateDir, "cache"), { recursive: true }).pipe(
        Effect.andThen(
          fs.makeTempDirectory({
            directory: path.join(config.stateDir, "cache"),
            prefix: "transcribe-",
          }),
        ),
        Effect.mapError((cause) => failure("file", "Could not create a work directory.", cause)),
      ),
      use,
      (dir) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore),
    );

  /** Downloads, converts, chunks and transcribes; returns the finished file body. */
  const transcribeWithNemotron = Effect.fn("YouTubeTranscription.transcribeWithNemotron")(
    function* (remote: TranscriptionSettings, url: string, id: string) {
      const metadata = yield* machine.metadata(url);
      return yield* withWorkDir((dir) =>
        Effect.gen(function* () {
          const wav = yield* machine.audio(url, dir);
          const chunks = planChunks(metadata.durationSeconds, CHUNK_SECONDS);
          const segments: TranscriptLine[] = [];
          const retries: string[] = [];
          const textOf = (lines: ReadonlyArray<TranscriptLine>) =>
            lines.map((line) => line.text).join(" ");
          const matches = (
            chunk: { start: number; seconds: number },
            lines: ReadonlyArray<TranscriptLine>,
          ) => matchesCaptions(metadata.captions, chunk.start, chunk.seconds, textOf(lines));
          /** A failed request and a reply without timestamps both count as "no usable reply". */
          const attempt = (file: string, pad: number) =>
            machine.transcribe(remote, file).pipe(
              Effect.map((lines) =>
                lines.map((line) => ({ start: Math.max(0, line.start - pad), text: line.text })),
              ),
              Effect.orElseSucceed(() => undefined),
            );
          for (const [index, chunk] of chunks.entries()) {
            const source = chunks.length === 1 ? wav : path.join(dir, `chunk-${index}.wav`);
            if (chunks.length > 1) yield* machine.slice(wav, chunk.start, chunk.seconds, source);
            const first = yield* attempt(source, 0);
            let lines: ReadonlyArray<TranscriptLine>;
            if (first !== undefined && matches(chunk, first)) lines = first;
            else {
              retries.push(stamp(chunk.start));
              const retryFile = path.join(dir, `chunk-${index}-retry.wav`);
              yield* machine.slice(wav, chunk.start, chunk.seconds, retryFile, RETRY_PAD_SECONDS);
              const second = yield* attempt(retryFile, RETRY_PAD_SECONDS);
              if (second === undefined || !matches(chunk, second))
                return yield* failure(
                  "transcribe",
                  "The speech-to-text server returned text that does not match the audio.",
                );
              lines = second;
            }
            for (const line of lines)
              segments.push({ start: line.start + chunk.start, text: line.text });
          }
          if (retries.length)
            yield* Effect.logInfo("youtube.transcribe.nemotron-retried", { id, retries });
          const lines = toLines(segments);
          return {
            content: formatTranscript({
              id,
              title: metadata.title,
              channel: metadata.channel,
              durationSeconds: metadata.durationSeconds,
              source: "nemotron" as const,
              lines,
            }),
            title: metadata.title,
            channel: metadata.channel,
            duration: stamp(metadata.durationSeconds),
            source: "nemotron" as const,
            lines,
          };
        }),
      );
    },
  );

  const transcribeWithGemini = Effect.fn("YouTubeTranscription.transcribeWithGemini")(function* (
    scope: Invocation.McpInvocationScope,
    threadId: ThreadId,
    id: string,
    root: string,
  ) {
    const caller = yield* threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((cause) =>
          failure("workspace", "Could not load the learning session.", cause),
        ),
      );
    if (!caller || caller.deletedAt !== null)
      return yield* failure("workspace", "Could not load the learning session.");
    const route = yield* router.resolve("transcript").pipe(
      Effect.catchTags({
        LearnRouteUnavailable: (error) =>
          error.reason === "unset" ? Effect.succeed(null) : Effect.fail(error),
      }),
      Effect.mapError((cause) =>
        failure(
          "route",
          "The transcript model route is unavailable. Fix Settings → Learning → transcript.",
          cause,
        ),
      ),
    );
    const selection = route ?? caller.modelSelection;
    const result = yield* orchestration
      .delegateTask(scope, {
        mode: "wait",
        timeoutMs: GEMINI_TIMEOUT_MS,
        isolation: "shared",
        title: `Transcript: ${id}`.slice(0, 200),
        task: GEMINI_PROMPT(id, root),
        target: {
          providerInstanceId: selection.instanceId,
          model: selection.model,
          options: selection.options ?? [],
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("delegate", "Could not start the transcript child. Try again later.", cause),
        ),
      );
    if (result.status !== "completed")
      return yield* failure(
        "delegate",
        "The Gemini transcript child did not finish. Try again later.",
      );
    const content = yield* readTranscript(path.join(root, `transcripts/${id}.md`)).pipe(
      Effect.mapError((cause) =>
        failure("file", "Gemini finished without writing the transcript file.", cause),
      ),
    );
    const parsed = yield* Effect.try({
      try: () => {
        const parsed = parseTranscript(content);
        if (!parsed || parsed.id !== id) throw new Error("Invalid transcript");
        return parsed;
      },
      catch: (cause) =>
        failure(
          "file",
          "Gemini wrote a transcript without the required header, URL or timestamps.",
          cause,
        ),
    });
    return {
      content,
      title: parsed.title,
      channel: parsed.channel,
      duration: parsed.duration,
      source: "gemini" as const,
      lines: parsed.lines,
    };
  });

  const runTranscribe = Effect.fn("YouTubeTranscription.transcribe")(function* (
    scope: Invocation.McpInvocationScope,
    url: string,
  ) {
    const required: Effect.Effect<Invocation.McpThreadInvocationScope, OrchestratorMcpFailure> =
      Invocation.requireThreadScope(scope, "physics");
    const threadScope = yield* required.pipe(
      Effect.mapError((cause) =>
        failure("workspace", "Transcribing needs a learning session.", cause),
      ),
    );
    const videoId = yield* Effect.try({
      try: () => videoIdFromUrl(url),
      catch: (cause) => failure("url", "Expected a YouTube video URL.", cause),
    });
    const threadId = threadScope.thread.threadId;
    const root = yield* labRoot(threadId);
    const relative = `transcripts/${videoId}.md`;
    const absolute = path.join(root, relative);
    const existing = yield* fs.readFileString(absolute).pipe(Effect.orElseSucceed(() => ""));
    if (existing) {
      const parsed = parseTranscript(existing);
      if (parsed) return yield* finish(relative, existing, parsed);
    }
    const produced = yield* Effect.gen(function* () {
      const remote = yield* settings;
      if (!remote) return yield* transcribeWithGemini(threadScope, threadId, videoId, root);
      const ready = yield* machine.ready(remote);
      if (!ready) {
        yield* Effect.logWarning("youtube.transcribe.nemotron-unavailable", {
          detail: "The Nemotron server is not ready; using Gemini.",
        });
        return yield* transcribeWithGemini(threadScope, threadId, videoId, root);
      }
      return yield* transcribeWithNemotron(remote, url, videoId).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("youtube.transcribe.nemotron-failed", {
              stage: error.stage,
              detail: error.detail,
            });
            return yield* transcribeWithGemini(threadScope, threadId, videoId, root);
          }),
        ),
      );
    });
    yield* fs
      .makeDirectory(path.dirname(absolute), { recursive: true })
      .pipe(Effect.mapError((cause) => failure("file", "Could not create transcripts/.", cause)));
    yield* fs
      .writeFileString(absolute, produced.content)
      .pipe(
        Effect.mapError((cause) => failure("file", "Could not write the transcript file.", cause)),
      );
    return yield* finish(relative, produced.content, produced);
  });

  return YouTubeTranscription.of({ transcribe: runTranscribe });
});

export const layer = Layer.effect(YouTubeTranscription, make);
