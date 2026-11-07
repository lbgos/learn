import { describe, expect, it } from "vite-plus/test";
import { encodeEvent, WyomingDecoder } from "./WyomingClient.ts";

describe("Wyoming framing", () => {
  it("round trips UTF-8 JSON data and opaque binary payload", () => {
    const event = {
      type: "audio-chunk",
      data: { name: "Привіт", rate: 16000 },
      payload: new Uint8Array([0, 10, 255, 123]),
    };
    expect(new WyomingDecoder().push(encodeEvent(event))).toEqual([event]);
  });
  it("handles every byte split and multiple frames", () => {
    const frame = Buffer.concat([
      encodeEvent({ type: "transcript", data: { text: "résumé" } }),
      encodeEvent({ type: "audio-stop" }),
    ]);
    for (let split = 0; split <= frame.length; split++) {
      const decoder = new WyomingDecoder();
      const events = [
        ...decoder.push(frame.subarray(0, split)),
        ...decoder.push(frame.subarray(split)),
      ];
      expect(events.map((event) => event.type)).toEqual(["transcript", "audio-stop"]);
      expect(events[0]?.data).toEqual({ text: "résumé" });
    }
  });
  it("merges inline and external data, with external fields winning", () => {
    const data = Buffer.from('{"text":"外部"}');
    const frame = Buffer.concat([
      Buffer.from(
        JSON.stringify({
          type: "transcript",
          data: { language: "en", text: "old" },
          data_length: data.length,
        }) + "\n",
      ),
      data,
    ]);
    expect(new WyomingDecoder().push(frame)[0]?.data).toEqual({ language: "en", text: "外部" });
  });
  it.each([
    "garbage\n",
    '{"type":"x","data_length":-1}\n',
    '{"type":"x","payload_length":999999999}\n',
  ])("rejects malformed frames %s", (frame) => {
    expect(() => new WyomingDecoder().push(Buffer.from(frame))).toThrow();
  });
  it("rejects unbounded unterminated headers", () => {
    expect(() => new WyomingDecoder().push(new Uint8Array(65537))).toThrow();
  });
});
