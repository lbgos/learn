import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { VoiceBackend, VoiceErrorReason } from "@t3tools/contracts";

const Data = Schema.Record(Schema.String, Schema.Unknown);
const FrameHeader = Schema.Struct({
  type: Schema.String,
  data: Schema.optionalKey(Data),
  data_length: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  payload_length: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});
const decodeHeader = Schema.decodeSync(Schema.fromJsonString(FrameHeader));
const decodeData = Schema.decodeSync(Schema.fromJsonString(Data));

export interface WyomingEvent {
  readonly type: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly payload?: Uint8Array;
}
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export function encodeEvent(event: WyomingEvent): Uint8Array {
  const data = event.data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(event.data));
  const payload = event.payload ?? new Uint8Array();
  const header = Buffer.from(
    JSON.stringify({ type: event.type, data_length: data.length, payload_length: payload.length }) +
      "\n",
  );
  return Buffer.concat([header, data, payload]);
}

/** Retains incomplete frames between TCP reads. */
export class WyomingDecoder {
  private pending: Buffer = Buffer.alloc(0);
  push(chunk: Uint8Array): WyomingEvent[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const events: WyomingEvent[] = [];
    for (;;) {
      const newline = this.pending.indexOf(10);
      if (newline < 0) {
        if (this.pending.length > MAX_HEADER_BYTES) throw new Error("Wyoming header is too large");
        break;
      }
      if (newline > MAX_HEADER_BYTES) throw new Error("Wyoming header is too large");
      const header = decodeHeader(this.pending.subarray(0, newline).toString("utf8"));
      const dataLength = header.data_length ?? 0;
      const payloadLength = header.payload_length ?? 0;
      if (dataLength + payloadLength > MAX_FRAME_BYTES)
        throw new Error("Wyoming frame is too large");
      const end = newline + 1 + dataLength + payloadLength;
      if (this.pending.length < end) break;
      const data =
        dataLength === 0
          ? {}
          : decodeData(
              this.pending.subarray(newline + 1, newline + 1 + dataLength).toString("utf8"),
            );
      events.push({
        type: header.type,
        data: { ...header.data, ...data },
        payload: new Uint8Array(this.pending.subarray(newline + 1 + dataLength, end)),
      });
      this.pending = this.pending.subarray(end);
    }
    return events;
  }
}

export class VoiceError extends Schema.TaggedError<VoiceError>()("VoiceError", {
  backend: VoiceBackend,
  reason: VoiceErrorReason,
  endpoint: Schema.String,
  /** The cause alone, for lines that already name the backend and endpoint. */
  detail: Schema.String,
  message: Schema.String,
}) {}

export function voiceError(
  backend: typeof VoiceBackend.Type,
  endpoint: string,
  reason: typeof VoiceErrorReason.Type,
  detail: string,
) {
  return new VoiceError({
    backend,
    endpoint,
    reason,
    detail,
    message: `Voice ${reason === "unreachable" ? "is down" : "failed"}: ${endpoint.replace(/^tcp:\/\//, "")} ${detail}`,
  });
}

/** One bounded request per socket; cancellation always closes the connection. */
export function exchange<A>(options: {
  readonly endpoint: string;
  readonly backend: typeof VoiceBackend.Type;
  readonly connectTimeoutMs?: number;
  readonly deadlineMs: number;
  readonly events: Iterable<WyomingEvent>;
  readonly receive: (event: WyomingEvent) => A | undefined;
}): Effect.Effect<A, VoiceError> {
  return Effect.callback<A, VoiceError>((resume) => {
    let socket: NodeNet.Socket | undefined;
    let finished = false;
    const cleanup = () => {
      socket?.destroy();
    };
    const fail = (reason: typeof VoiceErrorReason.Type, detail: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      resume(Effect.fail(voiceError(options.backend, options.endpoint, reason, detail)));
    };
    try {
      const endpoint = new URL(options.endpoint);
      if (
        endpoint.protocol !== "tcp:" ||
        !endpoint.hostname ||
        !endpoint.port ||
        endpoint.username ||
        endpoint.password ||
        (endpoint.pathname && endpoint.pathname !== "/") ||
        endpoint.search ||
        endpoint.hash
      ) {
        fail("protocol", "requires a tcp://host:port endpoint");
        return Effect.sync(cleanup);
      }
      socket = NodeNet.createConnection({
        host: endpoint.hostname.replace(/^\[|\]$/g, ""),
        port: Number(endpoint.port),
      });
      const activeSocket = socket;
      const decoder = new WyomingDecoder();
      const iterator = options.events[Symbol.iterator]();
      const send = () => {
        try {
          for (;;) {
            const next = iterator.next();
            if (next.done) return;
            if (!activeSocket.write(encodeEvent(next.value))) {
              activeSocket.once("drain", send);
              return;
            }
          }
        } catch {
          fail("protocol", "could not encode the Wyoming request");
        }
      };
      socket.setTimeout(options.connectTimeoutMs ?? 2000);
      socket.once("timeout", () => fail("timeout", "connection timed out"));
      socket.once("connect", () => {
        activeSocket.setTimeout(0);
        send();
      });
      socket.on("data", (chunk) => {
        if (finished) return;
        try {
          for (const event of decoder.push(chunk)) {
            if (event.type === "error") {
              fail("protocol", "backend reported a Wyoming error");
              return;
            }
            const result = options.receive(event);
            if (result !== undefined) {
              finished = true;
              cleanup();
              resume(Effect.succeed(result));
              return;
            }
          }
        } catch {
          fail("protocol", "sent an invalid Wyoming response");
        }
      });
      socket.once("error", (error) => {
        const code = "code" in error ? error.code : undefined;
        fail(
          code === "ETIMEDOUT" ? "timeout" : "unreachable",
          code === "ECONNREFUSED" ? "refused the connection" : "could not be reached",
        );
      });
      socket.once("close", () => fail("protocol", "closed before completing the response"));
    } catch {
      fail("protocol", "requires a valid tcp://host:port endpoint");
    }
    return Effect.sync(cleanup);
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.deadlineMs,
      orElse: () =>
        Effect.fail(voiceError(options.backend, options.endpoint, "timeout", "request timed out")),
    }),
  );
}
