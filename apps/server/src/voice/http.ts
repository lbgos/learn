import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  VoiceSynthesizeInput,
  VoiceTranscribeQuery,
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  type EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";
import { authenticateHttpScope } from "../auth/http.ts";
import * as VoiceService from "./VoiceService.ts";
import { VoiceError } from "./WyomingClient.ts";

const decodeQuery = Schema.decodeOption(VoiceTranscribeQuery);
const isVoiceError = Schema.is(VoiceError);
const decodeSynthesis = Schema.decodeEffect(Schema.fromJsonString(VoiceSynthesizeInput));

export const voiceErrorResponse = (error: VoiceError) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: { backend: error.backend, reason: error.reason, message: error.message },
    },
    {
      status:
        error.reason === "unreachable" || error.reason === "timeout"
          ? 503
          : error.reason === "too-long"
            ? 413
            : error.reason === "protocol"
              ? 502
              : 422,
    },
  );

function withErrors<R>(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    | VoiceError
    | EnvironmentAuthInvalidError
    | EnvironmentInternalError
    | EnvironmentScopeRequiredError,
    R
  >,
) {
  return effect.pipe(
    Effect.catchTags({
      VoiceError: (error) => Effect.succeed(voiceErrorResponse(error)),
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  );
}

const invalid = (backend: "stt" | "tts", message: string, status = 400) =>
  HttpServerResponse.jsonUnsafe(
    { error: { backend, reason: status === 413 ? "too-long" : "protocol", message } },
    { status },
  );

const layerVoiceTranscribeRoute = HttpRouter.add(
  "POST",
  "/api/voice/transcribe",
  withErrors(
    Effect.gen(function* () {
      yield* authenticateHttpScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
      if (
        !/^application\/octet-stream(?:\s*;.*)?$/.test(contentType) &&
        !/^audio\/l16\s*;\s*rate=16000(?:\s*;\s*channels=1)?\s*$/.test(contentType)
      )
        return invalid("stt", "Expected audio/L16;rate=16000 or application/octet-stream", 415);
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) return invalid("stt", "Invalid URL");
      const query = decodeQuery(Object.fromEntries(url.value.searchParams));
      if (Option.isNone(query)) return invalid("stt", "Invalid language");
      const length = request.headers["content-length"];
      if (
        length !== undefined &&
        (!/^\d+$/.test(length) || Number(length) > VoiceService.MAX_PCM_BYTES)
      )
        return invalid("stt", "Audio exceeds 120 seconds", 413);
      const body = yield* request.stream.pipe(
        Stream.runFoldEffect(
          () => Buffer.alloc(0),
          (buffer, chunk) =>
            buffer.length + chunk.length > VoiceService.MAX_PCM_BYTES
              ? Effect.fail(
                  new VoiceError({
                    backend: "stt",
                    endpoint: "",
                    reason: "too-long",
                    detail: "Audio exceeds 120 seconds",
                    message: "Audio exceeds 120 seconds",
                  }),
                )
              : Effect.succeed(Buffer.concat([buffer, chunk])),
        ),
        Effect.result,
      );
      if (body._tag === "Failure")
        return isVoiceError(body.failure)
          ? voiceErrorResponse(body.failure)
          : invalid("stt", "Could not read audio body");
      if (body.success.length % 2)
        return invalid("stt", "Audio must contain complete s16le samples");
      const service = yield* VoiceService.VoiceService;
      return HttpServerResponse.jsonUnsafe(
        yield* service.transcribe({ pcm: body.success, ...query.value }),
      );
    }),
  ),
);

const layerVoiceSynthesizeRoute = HttpRouter.add(
  "POST",
  "/api/voice/synthesize",
  withErrors(
    Effect.gen(function* () {
      yield* authenticateHttpScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? ""))
        return invalid("tts", "Expected application/json", 415);
      const body = yield* request.stream.pipe(
        Stream.runFoldEffect(
          () => Buffer.alloc(0),
          (buffer, chunk) =>
            buffer.length + chunk.length > 32768
              ? Effect.fail(
                  new VoiceError({
                    backend: "tts",
                    endpoint: "",
                    reason: "too-long",
                    detail: "Speech request exceeds 32 KiB",
                    message: "Speech request exceeds 32 KiB",
                  }),
                )
              : Effect.succeed(Buffer.concat([buffer, chunk])),
        ),
        Effect.result,
      );
      if (body._tag === "Failure")
        return isVoiceError(body.failure)
          ? voiceErrorResponse(body.failure)
          : invalid("tts", "Could not read speech request");
      const decoded = yield* decodeSynthesis(body.success.toString("utf8")).pipe(Effect.result);
      if (decoded._tag === "Failure")
        return invalid("tts", "Expected JSON {text, voice?}; text must be at most 4000 characters");
      const service = yield* VoiceService.VoiceService;
      const audio = yield* service.synthesize(decoded.success);
      return HttpServerResponse.uint8Array(audio.wav, {
        contentType: "audio/wav",
        headers: { "cache-control": "no-store" },
      });
    }),
  ),
);

const layerVoiceStatusRoute = HttpRouter.add(
  "GET",
  "/api/voice/status",
  withErrors(
    Effect.gen(function* () {
      yield* authenticateHttpScope(AuthOrchestrationReadScope);
      const service = yield* VoiceService.VoiceService;
      return HttpServerResponse.jsonUnsafe(yield* service.status(), {
        headers: { "cache-control": "no-store" },
      });
    }),
  ),
);
export const layerVoiceRoutes = Layer.mergeAll(
  layerVoiceTranscribeRoute,
  layerVoiceSynthesizeRoute,
  layerVoiceStatusRoute,
);
