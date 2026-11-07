import { describe, expect, it } from "vite-plus/test";
import { encodeS16le, framesToPcm, resampleMono } from "./pcm";

describe("PCM conversion", () => {
  it("preserves 16 kHz input", () => {
    const input = new Float32Array([0, 0.25, -0.25, 1, -1]);
    expect(resampleMono(input, 16000)).toEqual(input);
  });
  it("averages 48 kHz samples into 16 kHz mono", () => {
    expect(resampleMono(new Float32Array([0, 0.3, 0.6, -0.3, -0.6, -0.9]), 48000)[0]).toBeCloseTo(
      0.3,
    );
    expect(resampleMono(new Float32Array([0, 0.3, 0.6, -0.3, -0.6, -0.9]), 48000)[1]).toBeCloseTo(
      -0.6,
    );
  });
  it("handles fractional 44.1 kHz ratios with the right duration and DC level", () => {
    const output = resampleMono(new Float32Array(44100).fill(0.5), 44100);
    expect(output.length).toBe(16000);
    expect(output.every((value) => Math.abs(value - 0.5) < 0.000001)).toBe(true);
  });
  it("clips finite values, silences NaN, and writes signed little endian", () => {
    const bytes = encodeS16le(new Float32Array([-2, -1, 0, 0.5, 1, 2, NaN]));
    const view = new DataView(bytes.buffer);
    expect(Array.from({ length: 7 }, (_, index) => view.getInt16(index * 2, true))).toEqual([
      -32768, -32768, 0, 16384, 32767, 32767, 0,
    ]);
    expect(bytes.subarray(0, 2)).toEqual(new Uint8Array([0, 128]));
  });
  it("does not lose samples at worklet frame boundaries", () => {
    const input = new Float32Array(44100).fill(0.25);
    const frames: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 128) frames.push(input.subarray(i, i + 128));
    expect(framesToPcm(frames, 44100)).toEqual(encodeS16le(resampleMono(input, 44100)));
  });
  it("handles empty input and rejects invalid rates", () => {
    expect(resampleMono(new Float32Array(), 48000).length).toBe(0);
    expect(() => resampleMono(new Float32Array(2), 0)).toThrow();
    expect(() => resampleMono(new Float32Array(2), NaN)).toThrow();
  });
});
