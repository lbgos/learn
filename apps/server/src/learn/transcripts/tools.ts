import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import { HttpClient } from "effect/http";
import * as Path from "effect/Path";
import { TranscriptionError } from "./settings.ts";

/** Pinned so a deploy gets a known yt-dlp; YouTube breaks old builds, so bump this with its hash. */
const YT_DLP_VERSION = "2026.10.26";
const YT_DLP_LINUX_SHA256 =
  "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795";
const YT_DLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux`;

const failure =
  (stage: "download" | "convert" | "transcribe", detail: string) => (cause: unknown) =>
    new TranscriptionError({ stage, detail, cause });

const digest = Effect.fn("TranscriptTools.digest")(function* (bytes: Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(yield* crypto.digest("SHA-256", bytes));
});

/**
 * The pinned yt-dlp in `<stateDir>/tools`, fetched once and verified against its release hash.
 * Nothing is installed system-wide.
 */
export const ensureYtDlp = Effect.fn("TranscriptTools.ensureYtDlp")(function* (toolsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const binary = path.join(toolsDir, "yt-dlp");
  const verified = yield* fs.readFile(binary).pipe(
    Effect.flatMap(digest),
    Effect.map((hash) => hash === YT_DLP_LINUX_SHA256),
    Effect.orElseSucceed(() => false),
  );
  if (!verified) {
    const response = yield* http.get(YT_DLP_URL).pipe(
      Effect.mapError(failure("download", "Could not download the pinned yt-dlp binary.")),
      Effect.timeout("2 minutes"),
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(
            new TranscriptionError({
              stage: "download",
              detail: "The pinned yt-dlp download timed out.",
            }),
          ),
      }),
    );
    if (response.status !== 200)
      return yield* new TranscriptionError({
        stage: "download",
        detail: `The yt-dlp release download failed with HTTP ${response.status}.`,
      });
    const buffer = yield* response.arrayBuffer.pipe(
      Effect.mapError(failure("download", "Could not download the pinned yt-dlp binary.")),
    );
    const bytes = new Uint8Array(buffer);
    if ((yield* digest(bytes).pipe(Effect.orElseSucceed(() => ""))) !== YT_DLP_LINUX_SHA256)
      return yield* new TranscriptionError({
        stage: "download",
        detail: "The downloaded yt-dlp binary did not match its pinned checksum.",
      });
    yield* fs
      .makeDirectory(toolsDir, { recursive: true })
      .pipe(Effect.mapError(failure("download", "Could not create the server tools directory.")));
    yield* fs
      .writeFile(binary, bytes)
      .pipe(Effect.mapError(failure("download", "Could not write the yt-dlp binary.")));
  }
  yield* fs
    .chmod(binary, 0o755)
    .pipe(Effect.mapError(failure("download", "Could not make yt-dlp executable.")));
  return binary;
});

/** A locally provisioned `<stateDir>/tools/ffmpeg` wins; otherwise the host's ffmpeg package. */
export const ffmpegCommand = Effect.fn("TranscriptTools.ffmpegCommand")(function* (
  toolsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const local = path.join(toolsDir, "ffmpeg");
  return (yield* fs.exists(local).pipe(Effect.orElseSucceed(() => false))) ? local : "ffmpeg";
});
