import { describe, expect, it } from "vite-plus/test";
import { HttpServerResponse } from "effect/http";
import { voiceErrorResponse } from "./http.ts";
import { VoiceError } from "./WyomingClient.ts";

describe("voice HTTP error responses", () => {
  it.each([
    ["unreachable", 503],
    ["timeout", 503],
    ["protocol", 502],
    ["empty", 422],
    ["too-long", 413],
  ] as const)("maps %s to %s without leaking the internal error tag", async (reason, status) => {
    const response = HttpServerResponse.toWeb(
      voiceErrorResponse(
        new VoiceError({
          backend: "stt",
          endpoint: "tcp://127.0.0.1:10300",
          reason,
          detail: "Voice failed",
          message: "Voice failed",
        }),
      ),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: { backend: "stt", reason, message: "Voice failed" },
    });
  });
});

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as VoiceService from "./VoiceService.ts";
import { layerVoiceRoutes } from "./http.ts";

function routes(
  scopes: readonly AuthEnvironmentScope[] | null = [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
  ],
) {
  const calls: unknown[] = [];
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: () =>
      scopes === null
        ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({ cause: "test" }))
        : Effect.succeed({
            sessionId: AuthSessionId.make("voice-test"),
            subject: "test",
            method: "bearer-access-token",
            scopes,
          }),
  });
  const voice = Layer.mock(VoiceService.VoiceService, {
    transcribe: (input) => {
      calls.push(input);
      return Effect.succeed({ text: "A pendulum", backend: "whisper" as const });
    },
    synthesize: (input) => {
      calls.push(input);
      return Effect.succeed({ wav: new Uint8Array([82, 73, 70, 70]), sampleRate: 24000 });
    },
    status: () =>
      Effect.succeed({
        stt: { ok: true, endpoint: "tcp://stt:1", detail: "whisper" },
        tts: { ok: false, endpoint: "tcp://tts:2", detail: "unreachable" },
      }),
  });
  return {
    ...HttpRouter.toWebHandler(
      layerVoiceRoutes.pipe(Layer.provideMerge(auth), Layer.provideMerge(voice)),
      {
        disableLogger: true,
      },
    ),
    calls,
  };
}

describe("authenticated voice routes", () => {
  it("accepts raw PCM with language and returns JSON", async () => {
    const app = routes();
    try {
      const response = await app.handler(
        new Request("http://test/api/voice/transcribe?language=uk", {
          method: "POST",
          headers: { "content-type": "audio/L16;rate=16000" },
          body: new Uint8Array([1, 0]),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "A pendulum", backend: "whisper" });
      expect(app.calls).toEqual([{ language: "uk", pcm: Buffer.from([1, 0]) }]);
    } finally {
      await app.dispose();
    }
  });
  it("accepts synthesis JSON and sends binary WAV with no-store", async () => {
    const app = routes();
    try {
      const response = await app.handler(
        new Request("http://test/api/voice/synthesize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "A pendulum", voice: "af_heart" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array([82, 73, 70, 70]),
      );
      expect(app.calls).toEqual([{ text: "A pendulum", voice: "af_heart" }]);
    } finally {
      await app.dispose();
    }
  });
  it("requires authentication and operate scope before reading audio", async () => {
    for (const scopes of [null, [AuthOrchestrationReadScope]]) {
      const app = routes(scopes);
      try {
        const response = await app.handler(
          new Request("http://test/api/voice/transcribe", { method: "POST" }),
        );
        expect(response.status).toBe(scopes === null ? 401 : 403);
        expect(app.calls).toEqual([]);
      } finally {
        await app.dispose();
      }
    }
  });
  it("allows read scope for backend status", async () => {
    const app = routes([AuthOrchestrationReadScope]);
    try {
      const response = await app.handler(new Request("http://test/api/voice/status"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ stt: { ok: true }, tts: { ok: false } });
    } finally {
      await app.dispose();
    }
  });
  it("rejects unsupported formats, partial samples, oversized bodies and invalid JSON before calling voice", async () => {
    const app = routes();
    try {
      const requests = [
        { path: "transcribe", contentType: "audio/webm", body: new Uint8Array(2), status: 415 },
        {
          path: "transcribe",
          contentType: "application/octet-stream",
          body: new Uint8Array(1),
          status: 400,
        },
        {
          path: "transcribe",
          contentType: "application/octet-stream",
          body: new Uint8Array(3840002),
          status: 413,
        },
        { path: "synthesize", contentType: "application/json", body: "not JSON", status: 400 },
        {
          path: "synthesize",
          contentType: "application/json",
          body: JSON.stringify({ text: "x".repeat(4001) }),
          status: 400,
        },
        {
          path: "synthesize",
          contentType: "application/json",
          body: " ".repeat(32769),
          status: 413,
        },
      ];
      for (const input of requests) {
        const response = await app.handler(
          new Request(`http://test/api/voice/${input.path}`, {
            method: "POST",
            headers: { "content-type": input.contentType },
            body: input.body,
          }),
        );
        expect(response.status).toBe(input.status);
      }
      expect(app.calls).toEqual([]);
    } finally {
      await app.dispose();
    }
  });
});
