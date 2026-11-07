import {
  LearnErrorResponse,
  type EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";

const decodeError = Schema.decodeOption(Schema.fromJsonString(LearnErrorResponse));

/**
 * Calls one `LEARN_ENDPOINTS` entry over the environment's cookie, bearer or relay DPoP
 * transport. Resolves to the decoded success; rejects with the server's message.
 */
export async function learnRequest<
  E extends {
    readonly path: `/api/learn/${string}`;
    readonly payload: Schema.Top & {
      readonly DecodingServices: never;
      readonly EncodingServices: never;
    };
    readonly success: Schema.Top & {
      readonly DecodingServices: never;
      readonly EncodingServices: never;
    };
    readonly scope: AuthEnvironmentScope;
  },
>(
  environmentId: EnvironmentId,
  endpoint: E,
  payload: E["payload"]["Type"],
  signal?: AbortSignal,
): Promise<E["success"]["Type"]> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("Not connected to the environment.");
  const url = new URL(endpoint.path, prepared.httpBaseUrl).toString();
  const authorization = prepared.httpAuthorization;
  const body = await Effect.runPromise(
    Schema.encodeEffect(Schema.fromJsonString(endpoint.payload))(payload),
  );
  const effect = Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(body, "application/json"),
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
    return { status: response.status, text: yield* response.text };
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: authorization === null ? "include" : "omit",
    }),
  );
  const result = await executeAtomQuery(appAtomRegistry, connectionAtomRuntime.atom(effect), {
    ...(signal ? { signal } : {}),
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const { status, text } = result.value;
  if (status < 200 || status >= 300) {
    const decoded = decodeError(text);
    throw new Error(
      decoded._tag === "Some" ? decoded.value.error.message : `Request failed (${status}).`,
    );
  }
  return Effect.runPromise(Schema.decodeEffect(Schema.fromJsonString(endpoint.success))(text));
}
