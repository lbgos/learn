import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../../project/ProjectService.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import playerFixture from "./fixtures/player.json" with { type: "json" };
import captionsFixture from "./fixtures/timedtext.json" with { type: "json" };
import {
  Player,
  TimedText,
  existingResult,
  formatTranscript,
  mergeCues,
  selectTrack,
  videoIdFromUrl,
} from "./captions.ts";
import * as Captions from "./YouTubeCaptions.ts";

const id = "mTd3tBpfYmw";
const player = Schema.decodeSync(Player)(playerFixture);
const captions = Schema.decodeSync(TimedText)(captionsFixture);

it("accepts video URL forms and rejects other hosts, paths and ids", () => {
  for (const url of [
    `https://youtube.com/watch?v=${id}&t=3`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://m.youtube.com/live/${id}`,
  ])
    expect(videoIdFromUrl(url)).toBe(id);
  for (const url of [
    "oops",
    `https://youtube.com.evil/watch?v=${id}`,
    `https://evil.com/watch?v=${id}`,
    `https://youtube.com/playlist?v=${id}`,
    "https://youtube.com/watch?v=short",
    `ftp://youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}/extra`,
    `https://youtube.com:@evil.com/watch?v=${id}`,
  ])
    expect(() => videoIdFromUrl(url)).toThrow();
});
it("prefers manual captions, then English, or the default original language", () => {
  expect(selectTrack(player)?.languageCode).toBe("en");
  const original = {
    baseUrl: "https://www.youtube.com/api/timedtext",
    languageCode: "uk",
    kind: "asr",
  };
  const list = (
    captionTracks: typeof player.captions.playerCaptionsTracklistRenderer.captionTracks,
  ) => ({
    ...player,
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks,
        audioTracks: [{ defaultCaptionTrackIndex: 0 }],
      },
    },
  });
  expect(selectTrack(list([original, { ...original, languageCode: "en" }]))?.languageCode).toBe(
    "en",
  );
  expect(
    selectTrack(
      list([
        { ...original, kind: undefined },
        { ...original, languageCode: "en" },
      ]),
    )?.languageCode,
  ).toBe("uk");
  expect(selectTrack(list([original]))).toEqual(original);
  const dubbed = list([{ ...original, languageCode: "fr", kind: undefined }, original]);
  expect(
    selectTrack({
      ...dubbed,
      captions: {
        playerCaptionsTracklistRenderer: {
          ...dubbed.captions.playerCaptionsTracklistRenderer,
          defaultAudioTrackIndex: 1,
          audioTracks: [{ defaultCaptionTrackIndex: 0 }, { defaultCaptionTrackIndex: 1 }],
        },
      },
    })?.languageCode,
  ).toBe("uk");
});
it("merges recorded json3 cues into roughly 15-second timestamped lines without duplicating window events", () => {
  const lines = mergeCues(captions);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines[0]?.text).toContain("With the anticipated Nvidia");
  for (let i = 1; i < lines.length; i++) {
    expect(lines[i]!.start - lines[i - 1]!.start).toBeGreaterThanOrEqual(15);
    expect(lines[i]!.start - lines[i - 1]!.start).toBeLessThanOrEqual(20);
  }
  expect(lines.map((l) => l.text).join(" ")).toBe(
    captions.events
      .flatMap(
        (e) =>
          e.segs
            ?.map((s) => s.utf8)
            .join("")
            .replace(/\s+/g, " ")
            .trim() || [],
      )
      .join(" "),
  );
});
it("writes the required Markdown and extracts only short metadata", () => {
  const content = formatTranscript(id, player, selectTrack(player)!, captions);
  expect(content).toMatch(/^# NVIDIA Made 4-Bit AI Work/);
  expect(content).toContain(
    `channel: ${player.videoDetails.author} | url: https://www.youtube.com/watch?v=${id} | duration: 19:51`,
  );
  expect(content).toContain("source: youtube captions (auto, en)\n\n[00:00] With");
  const result = existingResult(`transcripts/${id}.raw.md`, content);
  expect(result).toEqual({
    path: `transcripts/${id}.raw.md`,
    title: player.videoDetails.title,
    duration: "19:51",
    lineCount: mergeCues(captions).length,
    captionKind: "auto",
  });
  expect(existingResult("a", "# placeholder\n")).toBeUndefined();
});
it.effect(
  "uses the caller's shared cwd, falls back from empty WEB captions, and reuses a real file without HTTP",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = yield* fs.makeTempDirectoryScoped();
      const worktree = yield* fs.makeTempDirectoryScoped();
      const calls: string[] = [];
      const http = HttpClient.make((request) => {
        calls.push(request.url);
        const body = request.url.includes("/watch?")
          ? `var ytInitialPlayerResponse = ${JSON.stringify(playerFixture)};`
          : request.url.includes("/player")
            ? JSON.stringify(playerFixture)
            : calls.length === 2
              ? ""
              : JSON.stringify(captionsFixture);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
      });
      const threadId = ThreadId.make("captions-thread");
      yield* Effect.gen(function* () {
        const service = yield* Captions.YouTubeCaptions;
        const result = yield* service.fetch(threadId, `https://youtu.be/${id}`);
        expect(calls).toHaveLength(4);
        expect(result.lineCount).toBeGreaterThan(1);
        expect(yield* fs.exists(`${projectRoot}/${result.path}`)).toBe(false);
        expect(yield* fs.readFileString(`${worktree}/${result.path}`)).toContain("[00:00] With");
        expect(yield* service.fetch(threadId, `https://youtube.com/live/${id}`)).toEqual(result);
        expect(calls).toHaveLength(4);
      }).pipe(
        Effect.provide(
          Captions.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(HttpClient.HttpClient, http),
                Layer.mock(Threads.ThreadManagementService)({
                  getThreadShell: () =>
                    Effect.succeed({ ...liveThreadShell(threadId), worktreePath: worktree }),
                }),
                Layer.mock(Projects.ProjectService)({
                  getById: () => Effect.succeedNone,
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect(
  "resolves the project Lab when the caller has no worktree and skips HTTP for a cached transcript",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const threadId = ThreadId.make("captions-project");
      const shell = liveThreadShell(threadId);
      const content = formatTranscript(id, player, selectTrack(player)!, captions);
      yield* fs.makeDirectory(`${root}/transcripts`);
      yield* fs.writeFileString(`${root}/transcripts/${id}.raw.md`, content);
      yield* Effect.gen(function* () {
        const service = yield* Captions.YouTubeCaptions;
        expect(yield* service.fetch(threadId, `https://youtu.be/${id}`)).toEqual(
          existingResult(`transcripts/${id}.raw.md`, content),
        );
      }).pipe(
        Effect.provide(
          Captions.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() =>
                    Effect.die("A cached transcript must not send HTTP requests"),
                  ),
                ),
                Layer.mock(Threads.ThreadManagementService)({
                  getThreadShell: () => Effect.succeed(shell),
                }),
                Layer.mock(Projects.ProjectService)({
                  getById: () =>
                    Effect.succeedSome({
                      id: shell.projectId,
                      title: "Lab",
                      workspaceRoot: root,
                      defaultModelSelection: null,
                      scripts: [],
                      createdAt: "2026-10-26T00:00:00.000Z",
                      updatedAt: "2026-10-26T00:00:00.000Z",
                      deletedAt: null,
                    }),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
