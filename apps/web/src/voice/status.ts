import {
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  VoiceErrorResponse,
  VoiceStatus,
} from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";

const decodeStatus = Schema.decodeSync(Schema.fromJsonString(VoiceStatus));
const decodeError = Schema.decodeOption(Schema.fromJsonString(VoiceErrorResponse));

/** Use the selected environment's cookie, bearer, or relay DPoP transport. */
export async function fetchVoiceStatus(
  signal: AbortSignal,
  environmentId: EnvironmentId = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID),
): Promise<VoiceStatus> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("Voice requires a connected environment");
  const url = new URL("/api/voice/status", prepared.httpBaseUrl).toString();
  const authorization = prepared.httpAuthorization;
  const effect = Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.get(url);
    if (authorization?._tag === "Bearer")
      request = HttpClientRequest.bearerToken(request, authorization.token);
    if (authorization?._tag === "Dpop") {
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      const proof = yield* signer.createProof({
        method: "GET",
        url,
        accessToken: authorization.accessToken,
      });
      request = HttpClientRequest.setHeaders(request, {
        authorization: `DPoP ${authorization.accessToken}`,
        dpop: proof,
      });
    }
    const response = yield* http.execute(request);
    return { status: response.status, body: yield* response.text };
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: authorization === null ? "include" : "omit",
    }),
    Effect.timeout(10000),
  );
  const result = await executeAtomQuery(appAtomRegistry, connectionAtomRuntime.atom(effect), {
    signal,
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  if (result.value.status < 200 || result.value.status >= 300) {
    const decoded = decodeError(result.value.body);
    throw new Error(
      decoded._tag === "Some"
        ? decoded.value.error.message
        : `Voice request failed (${result.value.status})`,
    );
  }
  return decodeStatus(result.value.body);
}
