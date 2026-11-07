import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ModelSelection,
  NodeId,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Config from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { LearnModelRouter, LearnRouteUnavailable } from "../LearnModelRouter.ts";
import type * as PlatformError from "effect/PlatformError";
import type { CaptionCue, TranscriptLine } from "./format.ts";
import { TranscriptionError } from "./settings.ts";
import { TranscriptionMachine, type VideoMetadata } from "./TranscriptionMachine.ts";
import * as Transcripts from "./YouTubeTranscription.ts";
import captions from "./fixtures/captions.json" with { type: "json" };
import replies from "./fixtures/replies.json" with { type: "json" };

const threadId = ThreadId.make("transcript-parent");
const id = "JGO_zDWmkvk";
const url = `https://www.youtube.com/watch?v=${id}`;
const metadata: VideoMetadata = {
  title: "Newton's 3 Laws",
  channel: "TED-Ed",
  durationSeconds: 213,
  captions: [],
};
const callerModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("gemini-cli"),
  model: "gemini-3-pro",
};
const routeModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("antigravity"),
  model: "gemini-4",
};
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("transcript-test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "transcript-test",
  thread: {
    threadId,
    providerSessionId: "parent-session",
    providerInstanceId: callerModel.instanceId,
  },
  client: undefined,
};
const completed: OrchestratorMcpDelegateTaskResult = {
  taskId: NodeId.make("transcript-task"),
  childThreadId: ThreadId.make("transcript-child"),
  childRunId: null,
  childNodeId: NodeId.make("transcript-child-node"),
  status: "completed",
  workState: "result_available",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: callerModel.instanceId,
  model: callerModel.model,
  summary: "transcripts/JGO_zDWmkvk.md 812",
  resultContextTransferId: null,
  hasPendingQuestion: false,
  pendingApproval: null,
  waitTimedOut: false,
};
const geminiFile = `# Newton's 3 Laws
channel: TED-Ed | url: https://www.youtube.com/watch?v=${id} | duration: 03:33
source: gemini

[00:00] Have you ever noticed that it is harder to start pedaling.
`;
const settings = (nemotronUrl: string) =>
  JSON.stringify({
    enabled: true,
    host: "transcriber.example",
    user: "ubuntu",
    identityFile: "/keys/transcriber",
    nemotronUrl,
  });

interface FixtureOptions {
  readonly root: string;
  readonly durationSeconds?: number;
  readonly ready?: boolean;
  readonly route?: ModelSelection;
  readonly metadataFails?: boolean;
  readonly lines?: ReadonlyArray<TranscriptLine>;
  /** The video's own captions, used to verify each chunk. */
  readonly captions?: ReadonlyArray<CaptionCue>;
  /** One reply per attempt; an undefined entry fails like a reply without timestamps. */
  readonly replies?: ReadonlyArray<ReadonlyArray<TranscriptLine> | undefined>;
  /** The fake Gemini child writes this to transcripts/<id>.md when set. */
  readonly geminiFile?: string;
  readonly writeFile?: (
    path: string,
    content: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
}

function fixture(options: FixtureOptions) {
  const delegations: Array<OrchestratorMcpDelegateTaskInput> = [];
  const slices: Array<{ start: number; seconds: number; pad?: number }> = [];
  const transcribed: string[] = [];
  const machine = TranscriptionMachine.of({
    ready: () => Effect.succeed(options.ready ?? true),
    metadata: () =>
      options.metadataFails
        ? Effect.fail(
            new TranscriptionError({
              stage: "download",
              detail: "yt-dlp could not fetch the video.",
            }),
          )
        : Effect.succeed({
            ...metadata,
            durationSeconds: options.durationSeconds ?? 90,
            captions: options.captions ?? [],
          }),
    audio: (_url, dir) => Effect.succeed(`${dir}/audio.wav`),
    slice: (_wav, start, seconds, out, pad) =>
      Effect.sync(() => {
        slices.push({ start, seconds, ...(pad ? { pad } : {}) });
        return `${out}:${start}:${seconds}`;
      }).pipe(Effect.asVoid),
    transcribe: (_settings, file) => {
      transcribed.push(file);
      if (options.replies) {
        const reply = options.replies[transcribed.length - 1];
        if (reply === undefined)
          return Effect.fail(
            new TranscriptionError({
              stage: "transcribe",
              detail: "The STT server returned no timestamps.",
            }),
          );
        return Effect.succeed(reply);
      }
      return Effect.succeed(options.lines ?? [{ start: 0, text: "Talking about inertia." }]);
    },
    dictate: () => Effect.die(new Error("transcribe_youtube never dictates")),
  });
  const layer = Transcripts.layer.pipe(
    Layer.provide(Layer.succeed(TranscriptionMachine, machine)),
    Layer.provide(
      Layer.mock(ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({ ...liveThreadShell(threadId), worktreePath: options.root }),
      }),
    ),
    Layer.provide(Layer.mock(ProjectService)({})),
    Layer.provide(
      Layer.mock(OrchestratorMcpService)({
        delegateTask: (_scope, input) => {
          delegations.push(input);
          if (options.geminiFile === undefined) return Effect.succeed(completed);
          return (options.writeFile ?? (() => Effect.void))(
            `${options.root}/transcripts/${id}.md`,
            options.geminiFile,
          ).pipe(Effect.orDie, Effect.as(completed));
        },
      }),
    ),
    Layer.provide(
      Layer.mock(LearnModelRouter)({
        resolve: (role) =>
          options.route === undefined
            ? Effect.fail(new LearnRouteUnavailable({ role, reason: "unset" }))
            : Effect.succeed(options.route),
      }),
    ),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "t3-transcript-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, delegations, slices, transcribed };
}

const writeSettings = (json: string | undefined) =>
  Effect.gen(function* () {
    if (json === undefined) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* Config.ServerConfig;
    yield* fs.writeFileString(path.join(stateDir, "youtube-transcribe.json"), json);
  });

const lab = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return { fs, root: yield* fs.makeTempDirectoryScoped({ prefix: "transcript-lab-" }) };
});

it.effect("transcribes with Nemotron when ready and returns the tiny result", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* lab;
    const f = fixture({ root });
    yield* Effect.gen(function* () {
      yield* writeSettings(settings("http://127.0.0.1:8090"));
      const service = yield* Transcripts.YouTubeTranscription;
      const result = yield* service.transcribe(scope, url);
      expect(result).toEqual({
        path: `transcripts/${id}.md`,
        title: metadata.title,
        channel: metadata.channel,
        duration: "01:30",
        source: "nemotron",
        words: 3,
        indexed: false,
        warning:
          "Cortex is not configured on this server; the transcript is saved but not indexed.",
      });
      expect(f.delegations).toHaveLength(0);
      expect(f.slices).toHaveLength(0);
      expect(yield* fs.readFileString(`${root}/transcripts/${id}.md`)).toBe(
        `# Newton's 3 Laws\nchannel: TED-Ed | url: https://www.youtube.com/watch?v=${id} | duration: 01:30\nsource: nemotron 3.5 transcribe (word timestamps)\n\n[00:00] Talking about inertia.\n`,
      );
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("chunks a 20-minute video at 10 minutes and offsets each chunk's timestamps", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* lab;
    const f = fixture({ root, durationSeconds: 1112, lines: [{ start: 5, text: "chunk words" }] });
    yield* Effect.gen(function* () {
      yield* writeSettings(settings("http://127.0.0.1:8090"));
      const service = yield* Transcripts.YouTubeTranscription;
      const result = yield* service.transcribe(
        scope,
        "https://www.youtube.com/watch?v=0DHNGtsmmH8",
      );
      expect(f.slices).toEqual([
        { start: 0, seconds: 600 },
        { start: 600, seconds: 512 },
      ]);
      expect(f.transcribed).toHaveLength(2);
      expect(result.duration).toBe("18:32");
      const written = yield* fs.readFileString(`${root}/transcripts/0DHNGtsmmH8.md`);
      expect(written).toContain("[00:05] chunk words");
      expect(written).toContain("[10:05] chunk words");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "re-transcribes a chunk that does not match the video's captions behind 250 ms of silence",
  () =>
    Effect.gen(function* () {
      const { fs, root } = yield* lab;
      const f = fixture({
        root,
        durationSeconds: 213,
        captions,
        replies: [[{ start: 120, text: replies.bad }], [{ start: 0.25, text: replies.good }]],
      });
      yield* Effect.gen(function* () {
        yield* writeSettings(settings("http://127.0.0.1:8090"));
        const service = yield* Transcripts.YouTubeTranscription;
        const result = yield* service.transcribe(scope, url);
        expect(result.source).toBe("nemotron");
        expect(f.delegations).toHaveLength(0);
        expect(f.slices).toEqual([{ start: 0, seconds: 213, pad: 0.25 }]);
        const written = yield* fs.readFileString(`${root}/transcripts/${id}.md`);
        expect(written).toContain("[00:00] Bike moving, why does it go forward?");
        expect(written).not.toContain("Hugging the equator");
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back to Gemini when the padded retry still does not match the captions", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* lab;
    const f = fixture({
      root,
      durationSeconds: 213,
      captions,
      replies: [[{ start: 120, text: replies.bad }], [{ start: 0.25, text: replies.bad }]],
      geminiFile,
      writeFile: (target, content) =>
        fs
          .makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(target, content))),
    });
    yield* Effect.gen(function* () {
      yield* writeSettings(settings("http://127.0.0.1:8090"));
      const service = yield* Transcripts.YouTubeTranscription;
      const result = yield* service.transcribe(scope, url);
      expect(f.delegations).toHaveLength(1);
      expect(result.source).toBe("gemini");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retries a reply without timestamps even when there are no captions", () =>
  Effect.gen(function* () {
    const { root } = yield* lab;
    const f = fixture({
      root,
      durationSeconds: 213,
      replies: [undefined, [{ start: 0, text: "Talking about inertia." }]],
    });
    yield* Effect.gen(function* () {
      yield* writeSettings(settings("http://127.0.0.1:8090"));
      const service = yield* Transcripts.YouTubeTranscription;
      const result = yield* service.transcribe(scope, url);
      expect(result.source).toBe("nemotron");
      expect(f.slices).toEqual([{ start: 0, seconds: 213, pad: 0.25 }]);
      expect(result.words).toBe(3);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back to a waited Gemini child when there is no config, and uses its file", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* lab;
    const f = fixture({
      root,
      geminiFile,
      writeFile: (target, content) =>
        fs
          .makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(target, content))),
    });
    yield* Effect.gen(function* () {
      const service = yield* Transcripts.YouTubeTranscription;
      const result = yield* service.transcribe(scope, url);
      expect(f.delegations).toHaveLength(1);
      const delegation = f.delegations[0]!;
      expect(delegation.mode).toBe("wait");
      expect(delegation.isolation).toBe("shared");
      expect(delegation.target?.providerInstanceId).toBe("codex");
      expect(delegation.target?.model).toBe("gpt-5");
      expect(delegation.task).toContain(`transcripts/${id}.md`);
      expect(result).toMatchObject({
        path: `transcripts/${id}.md`,
        title: "Newton's 3 Laws",
        channel: "TED-Ed",
        duration: "03:33",
        source: "gemini",
        words: 11,
        indexed: false,
      });
      expect(yield* fs.readFileString(`${root}/transcripts/${id}.md`)).toBe(geminiFile);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses the configured transcript route and falls back when the STT host is not ready",
  () =>
    Effect.gen(function* () {
      const { fs, root } = yield* lab;
      const f = fixture({
        root,
        ready: false,
        route: routeModel,
        geminiFile,
        writeFile: (target, content) =>
          fs
            .makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(target, content))),
      });
      yield* Effect.gen(function* () {
        yield* writeSettings(settings("http://127.0.0.1:8090"));
        const service = yield* Transcripts.YouTubeTranscription;
        const result = yield* service.transcribe(scope, url);
        expect(f.delegations).toHaveLength(1);
        expect(f.delegations[0]!.target?.providerInstanceId).toBe(routeModel.instanceId);
        expect(f.delegations[0]!.target?.model).toBe(routeModel.model);
        expect(result.source).toBe("gemini");
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back to Gemini when the Nemotron attempt fails after it was ready", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* lab;
    const f = fixture({
      root,
      metadataFails: true,
      geminiFile,
      writeFile: (target, content) =>
        fs
          .makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(target, content))),
    });
    yield* Effect.gen(function* () {
      yield* writeSettings(settings("http://127.0.0.1:8090"));
      const service = yield* Transcripts.YouTubeTranscription;
      const result = yield* service.transcribe(scope, url);
      expect(f.delegations).toHaveLength(1);
      expect(result.source).toBe("gemini");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reuses an existing valid transcript without downloading or delegating", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* lab;
    const f = fixture({ root });
    yield* fs.makeDirectory(`${root}/transcripts`, { recursive: true });
    yield* fs.writeFileString(`${root}/transcripts/${id}.md`, geminiFile);
    yield* Effect.gen(function* () {
      const service = yield* Transcripts.YouTubeTranscription;
      const result = yield* service.transcribe(scope, url);
      expect(result).toMatchObject({ source: "gemini", words: 11, indexed: false });
      expect(f.delegations).toHaveLength(0);
      expect(f.transcribed).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails with one line when Nemotron fails and the Gemini child writes no file", () =>
  Effect.gen(function* () {
    const { root } = yield* lab;
    const f = fixture({ root, metadataFails: true, geminiFile });
    yield* Effect.gen(function* () {
      yield* writeSettings(settings("http://127.0.0.1:8090"));
      const service = yield* Transcripts.YouTubeTranscription;
      const error = yield* Effect.flip(service.transcribe(scope, url));
      expect(error.message).toBe("Gemini finished without writing the transcript file.");
      expect(f.delegations).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports indexing failures without losing the transcript", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* lab;
    const f = fixture({ root });
    const path = yield* Path.Path;
    yield* Effect.gen(function* () {
      const { stateDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(
        path.join(stateDir, "cortex-mcp.json"),
        JSON.stringify({ url: "http://127.0.0.1:1/mcp", writeBearerToken: "x".repeat(24) }),
      );
      yield* writeSettings(settings("http://127.0.0.1:8090"));
      const service = yield* Transcripts.YouTubeTranscription;
      const result = yield* service.transcribe(scope, url);
      expect(result.indexed).toBe(false);
      expect(result.warning).toBe(
        "Cortex is unavailable; the transcript is saved but not indexed.",
      );
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a URL that is not a YouTube video", () =>
  Effect.gen(function* () {
    const { root } = yield* lab;
    const f = fixture({ root });
    yield* Effect.gen(function* () {
      const service = yield* Transcripts.YouTubeTranscription;
      const error = yield* Effect.flip(service.transcribe(scope, "https://example.com/watch?v=x"));
      expect(error.message).toBe("Expected a YouTube video URL.");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
