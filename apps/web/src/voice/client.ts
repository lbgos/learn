import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  VoiceErrorResponse,
  VoiceSynthesizeInput,
  VoiceTranscript,
  EnvironmentId,
} from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";

const decodeError = Schema.decodeOption(Schema.fromJsonString(VoiceErrorResponse));
const decodeTranscript = Schema.decodeSync(Schema.fromJsonString(VoiceTranscript));
const decodeSynthesis = Schema.decodeSync(VoiceSynthesizeInput);

async function requestVoice(
  path: string,
  body: Uint8Array<ArrayBuffer> | string,
  contentType: string,
  signal: AbortSignal,
  environmentId: EnvironmentId = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID),
) {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("Voice requires a connected environment");
  const url = new URL(path, prepared.httpBaseUrl).toString();
  const authorization = prepared.httpAuthorization;
  const effect = Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.post(url).pipe(
      typeof body === "string"
        ? HttpClientRequest.bodyText(body, contentType)
        : HttpClientRequest.bodyUint8Array(body, contentType),
    );
    if (authorization?._tag === "Bearer")
      request = HttpClientRequest.bearerToken(request, authorization.token);
    if (authorization?._tag === "Dpop") {
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      const proof = yield* signer.createProof({
        method: "POST",
        url,
        accessToken: authorization.accessToken,
      });
      request = HttpClientRequest.setHeaders(request, {
        authorization: `DPoP ${authorization.accessToken}`,
        dpop: proof,
      });
    }
    const response = yield* http.execute(request);
    const bytes = yield* response.arrayBuffer;
    return { status: response.status, bytes };
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: authorization === null ? "include" : "omit",
    }),
    Effect.timeout(95000),
  );
  const result = await executeAtomQuery(appAtomRegistry, connectionAtomRuntime.atom(effect), {
    signal,
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  if (result.value.status < 200 || result.value.status >= 300) {
    const decoded = decodeError(new TextDecoder().decode(result.value.bytes));
    throw new Error(
      decoded._tag === "Some"
        ? decoded.value.error.message
        : `Voice request failed (${result.value.status})`,
    );
  }
  return result.value.bytes;
}

export async function transcribePcm(
  pcm: Uint8Array,
  language: string | undefined,
  signal: AbortSignal,
  environmentId?: EnvironmentId,
) {
  const path = `/api/voice/transcribe${language ? `?${new URLSearchParams({ language })}` : ""}`;
  const bytes = await requestVoice(
    path,
    new Uint8Array(pcm),
    "audio/L16;rate=16000",
    signal,
    environmentId,
  );
  return decodeTranscript(new TextDecoder().decode(bytes));
}
export async function synthesizeText(
  text: string,
  signal: AbortSignal,
  environmentId?: EnvironmentId,
) {
  const input = decodeSynthesis({ text });
  return requestVoice(
    "/api/voice/synthesize",
    JSON.stringify(input),
    "application/json",
    signal,
    environmentId,
  );
}
