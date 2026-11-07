import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Captions from "../../../learn/captions/YouTubeCaptions.ts";
import * as Transcription from "../../../learn/transcripts/YouTubeTranscription.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { YouTubeToolkit } from "./tools.ts";

const caller = Effect.gen(function* () {
  return yield* Invocation.requireThreadScope(yield* Invocation.McpInvocationContext, "physics");
});

export const layer = Access.toLayer(YouTubeToolkit, {
  youtube_captions: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const captions = yield* Captions.YouTubeCaptions;
      return yield* captions.fetch(scope.thread.threadId, input.url).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: error.stage === "url" ? "invalid_request" : "orchestration_error",
              message:
                error.stage === "url"
                  ? error.message
                  : `${error.message} Continue with transcribe_youtube.`,
            }),
        ),
      );
    }),
  ),
  transcribe_youtube: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const transcripts = yield* Transcription.YouTubeTranscription;
      return yield* transcripts.transcribe(scope, input.url).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error.stage === "url"
                  ? "invalid_request"
                  : error.stage === "route"
                    ? "provider_unavailable"
                    : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
});
