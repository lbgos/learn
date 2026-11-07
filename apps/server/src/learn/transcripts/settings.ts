import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

/**
 * Server-owned settings in `<stateDir>/youtube-transcribe.json`, shared by `transcribe_youtube` and
 * dictation. `identityFile` is a path on this host; key material stays in it. `nemotronUrl` is the
 * STT server's loopback address on the remote host, reached only through SSH.
 */
export const TranscriptionSettings = Schema.Struct({
  enabled: Schema.Boolean,
  host: Schema.String.check(Schema.isMinLength(1)),
  user: Schema.String.check(Schema.isMinLength(1)),
  identityFile: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.optional(Schema.Int),
  nemotronUrl: Schema.String.check(Schema.isMinLength(1)),
});
export type TranscriptionSettings = typeof TranscriptionSettings.Type;
export const TRANSCRIPTION_SETTINGS_FILE = "youtube-transcribe.json";

const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(TranscriptionSettings));

/** Read per call, so enabling or editing the file needs no restart. Null skips Nemotron. */
export const readTranscriptionSettings = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(
    Effect.flatMap(decodeSettings),
    Effect.map((value) => (value.enabled ? value : null)),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    }),
    Effect.catch(() =>
      Effect.logWarning("transcription.settings-invalid", {
        detail: `${TRANSCRIPTION_SETTINGS_FILE} on the server is invalid; Nemotron is skipped.`,
      }).pipe(Effect.as(null)),
    ),
  );

/** `detail` is shown to the learner as is; never include paths to key material or command output. */
export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()(
  "TranscriptionError",
  {
    stage: Schema.Literals([
      "settings",
      "url",
      "workspace",
      "remote",
      "download",
      "convert",
      "transcribe",
      "route",
      "delegate",
      "file",
      "cortex",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}

/** The STT server's base URL, restricted to loopback so config can never point SSH at a third party. */
export function remoteBase(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Nemotron URL must be plain http on loopback.");
  return `http://${url.hostname}${url.port ? `:${url.port}` : ""}`;
}
