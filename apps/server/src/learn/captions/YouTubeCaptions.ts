import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient } from "effect/http";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../../project/ProjectService.ts";
import {
  CaptionResult,
  Player,
  TimedText,
  existingResult,
  formatTranscript,
  mergeCues,
  selectTrack,
  videoIdFromUrl,
} from "./captions.ts";

class YouTubeCaptionsError extends Schema.TaggedError<YouTubeCaptionsError>()(
  "YouTubeCaptionsError",
  {
    stage: Schema.Literals(["url", "workspace", "watch", "player", "captions", "file"]),
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    if (this.stage === "url")
      return "Expected a YouTube watch, youtu.be, shorts or live video URL.";
    if (this.stage === "workspace") return "Could not resolve the calling thread's Lab folder.";
    if (this.stage === "file")
      return "Could not read or write the transcript in the calling thread's Lab.";
    return `YouTube captions failed during ${this.stage}${this.status === undefined ? "" : ` (HTTP ${this.status})`}. Existing subtitles may be unavailable or YouTube may be blocking this host. Continue with delegate_task, learnRole "transcript", passing the original YouTube URL so Gemini fetches and transcribes the video itself.`;
  }
}
export class YouTubeCaptions extends Context.Service<
  YouTubeCaptions,
  {
    readonly fetch: (
      threadId: ThreadId,
      url: string,
    ) => Effect.Effect<typeof CaptionResult.Type, YouTubeCaptionsError>;
  }
>()("t3/learn/captions/YouTubeCaptions") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const http = yield* HttpClient.HttpClient;
  const readResponse = (
    request: ReturnType<typeof http.get>,
    stage: "watch" | "player" | "captions",
  ) =>
    Effect.gen(function* () {
      const response = yield* request.pipe(
        Effect.mapError((cause) => new YouTubeCaptionsError({ stage, cause })),
      );
      if (response.status !== 200)
        return yield* new YouTubeCaptionsError({ stage, status: response.status });
      return yield* response.text.pipe(
        Effect.mapError((cause) => new YouTubeCaptionsError({ stage, cause })),
      );
    }).pipe(
      // Keep application trace headers off public caption requests.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeout("30 seconds"),
      Effect.catchTags({
        TimeoutError: (cause) => Effect.fail(new YouTubeCaptionsError({ stage, cause })),
      }),
    );
  const decodePlayer = Schema.decodeUnknownEffect(Schema.fromJsonString(Player));
  const decodeCaptions = Schema.decodeUnknownEffect(Schema.fromJsonString(TimedText));
  const captionsFor = Effect.fn("YouTubeCaptions.captionsFor")(function* (
    player: typeof Player.Type,
  ) {
    const track = selectTrack(player);
    if (!track) return yield* new YouTubeCaptionsError({ stage: "captions" });
    const url = yield* Effect.try({
      try: () => {
        const url = new URL(track.baseUrl);
        if (
          url.protocol !== "https:" ||
          !["www.youtube.com", "www.youtube-nocookie.com"].includes(url.hostname) ||
          url.pathname !== "/api/timedtext"
        )
          throw new Error("Unexpected caption URL.");
        url.searchParams.set("fmt", "json3");
        return url.toString();
      },
      catch: (cause) => new YouTubeCaptionsError({ stage: "captions", cause }),
    });
    const text = yield* readResponse(http.get(url), "captions");
    const captions = yield* decodeCaptions(text).pipe(
      Effect.mapError((cause) => new YouTubeCaptionsError({ stage: "captions", cause })),
    );
    if (!mergeCues(captions).length) return yield* new YouTubeCaptionsError({ stage: "captions" });
    return { player, track, captions };
  });
  return YouTubeCaptions.of({
    fetch: Effect.fn("YouTubeCaptions.fetch")(function* (threadId, url) {
      const id = yield* Effect.try({
        try: () => videoIdFromUrl(url),
        catch: (cause) => new YouTubeCaptionsError({ stage: "url", cause }),
      });
      const thread = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new YouTubeCaptionsError({ stage: "workspace", cause })));
      if (!thread || thread.deletedAt !== null)
        return yield* new YouTubeCaptionsError({ stage: "workspace" });
      // Shared delegated children inherit this same worktree, or the project root.
      const root =
        thread.worktreePath ??
        (yield* Effect.gen(function* () {
          const project = yield* projects
            .getById(thread.projectId)
            .pipe(
              Effect.mapError((cause) => new YouTubeCaptionsError({ stage: "workspace", cause })),
            );
          if (Option.isNone(project))
            return yield* new YouTubeCaptionsError({ stage: "workspace" });
          return project.value.workspaceRoot;
        }));
      const relative = `transcripts/${id}.raw.md`;
      const file = path.join(root, relative);
      const cached = yield* fs.readFileString(file).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(cause),
        }),
        Effect.mapError((cause) => new YouTubeCaptionsError({ stage: "file", cause })),
      );
      const result = existingResult(relative, cached);
      if (result) return result;
      const primary = Effect.gen(function* () {
        const html = yield* readResponse(
          http.get(`https://www.youtube.com/watch?v=${id}&hl=en`, {
            headers: { "user-agent": "Mozilla/5.0" },
          }),
          "watch",
        );
        const json = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*(\{.*?\});/s.exec(html)?.[1];
        const player = yield* decodePlayer(json).pipe(
          Effect.mapError((cause) => new YouTubeCaptionsError({ stage: "player", cause })),
        );
        return yield* captionsFor(player);
      });
      const fetched = yield* primary.pipe(
        Effect.catchTags({
          YouTubeCaptionsError: Effect.fn("YouTubeCaptions.fetchFromPlayerApi")(function* () {
            // WEB timedtext can return HTTP 200 with an empty body. IOS currently
            // supplies usable subtitle URLs without cookies or a proof-of-origin token.
            const text = yield* readResponse(
              http.post("https://www.youtube.com/youtubei/v1/player", {
                body: HttpBody.jsonUnsafe({
                  context: {
                    client: {
                      clientName: "IOS",
                      clientVersion: "20.10.4",
                      deviceMake: "Apple",
                      deviceModel: "iPhone16,2",
                      osName: "iPhone",
                      osVersion: "18.3.2.22D82",
                      hl: "en",
                    },
                  },
                  videoId: id,
                  contentCheckOk: true,
                  racyCheckOk: true,
                }),
              }),
              "player",
            );
            const player = yield* decodePlayer(text).pipe(
              Effect.mapError((cause) => new YouTubeCaptionsError({ stage: "player", cause })),
            );
            return yield* captionsFor(player);
          }),
        }),
      );
      const content = yield* Effect.try({
        try: () => formatTranscript(id, fetched.player, fetched.track, fetched.captions),
        catch: (cause) => new YouTubeCaptionsError({ stage: "captions", cause }),
      });
      yield* fs
        .makeDirectory(path.dirname(file), { recursive: true })
        .pipe(Effect.mapError((cause) => new YouTubeCaptionsError({ stage: "file", cause })));
      yield* fs
        .writeFileString(file, content)
        .pipe(Effect.mapError((cause) => new YouTubeCaptionsError({ stage: "file", cause })));
      return existingResult(relative, content)!;
    }),
  });
});
export const layer = Layer.effect(YouTubeCaptions, make);
