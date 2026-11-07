import { expect, it } from "@effect/vitest";
import {
  captionOverlap,
  formatTranscript,
  matchesCaptions,
  parseTranscript,
  planChunks,
  replySegments,
  stamp,
  toLines,
  wordCount,
} from "./format.ts";
import captions from "./fixtures/captions.json" with { type: "json" };
import replies from "./fixtures/replies.json" with { type: "json" };

it("stamps minutes and hours", () => {
  expect(stamp(0)).toBe("00:00");
  expect(stamp(59.9)).toBe("00:59");
  expect(stamp(213)).toBe("03:33");
  expect(stamp(1112)).toBe("18:32");
  expect(stamp(3723)).toBe("1:02:03");
});

it("plans whole-second chunks that cover the duration once", () => {
  expect(planChunks(213, 300)).toEqual([{ start: 0, seconds: 213 }]);
  expect(planChunks(1112, 600)).toEqual([
    { start: 0, seconds: 600 },
    { start: 600, seconds: 512 },
  ]);
  expect(planChunks(600, 300)).toEqual([
    { start: 0, seconds: 300 },
    { start: 300, seconds: 300 },
  ]);
  expect(() => planChunks(0, 300)).toThrow();
});

it("groups cues into one line per 15 seconds and counts its words", () => {
  const lines = toLines([
    { start: 0, text: "  Objects   in motion " },
    { start: 4, text: "stay in motion." },
    { start: 16, text: "Inertia resists change." },
    { start: 20, text: "   " },
  ]);
  expect(lines).toEqual([
    { start: 0, text: "Objects in motion stay in motion." },
    { start: 16, text: "Inertia resists change." },
  ]);
  expect(wordCount(lines)).toBe(9);
});

it("writes the header cortex ingestion requires and reads it back", () => {
  const content = formatTranscript({
    id: "JGO_zDWmkvk",
    title: "Newton's  3 Laws",
    channel: "TED-Ed",
    durationSeconds: 213,
    source: "nemotron",
    lines: [
      { start: 0, text: "One." },
      { start: 75, text: "Two." },
    ],
  });
  expect(content).toBe(
    "# Newton's 3 Laws\nchannel: TED-Ed | url: https://www.youtube.com/watch?v=JGO_zDWmkvk | duration: 03:33\nsource: nemotron 3.5 transcribe (word timestamps)\n\n[00:00] One.\n[01:15] Two.\n",
  );
  expect(parseTranscript(content)).toEqual({
    id: "JGO_zDWmkvk",
    title: "Newton's 3 Laws",
    channel: "TED-Ed",
    duration: "03:33",
    source: "nemotron",
    lines: [
      { start: 0, text: "One." },
      { start: 75, text: "Two." },
    ],
    words: 2,
  });
});

it("rejects files without the canonical header or timestamped body", () => {
  expect(parseTranscript("# Title\nchannel: X\n[00:00] Hi.\n")).toBeUndefined();
  expect(
    parseTranscript(
      "# Title\nchannel: X | url: https://www.youtube.com/watch?v=JGO_zDWmkvk | duration: 03:33\n\nno timestamps\n",
    ),
  ).toBeUndefined();
});

it("detects a fabricated chunk by its overlap with the video's own captions", () => {
  expect(matchesCaptions(captions, 120, 93, replies.good)).toBe(true);
  expect(matchesCaptions(captions, 120, 93, replies.bad)).toBe(false);
  expect(captionOverlap(captions, 120, 93, replies.bad)).toBeLessThan(0.2);
});

it("has no verdict without captions, enough text or a captioned window", () => {
  expect(matchesCaptions([], 120, 93, replies.bad)).toBe(true);
  expect(captionOverlap([], 120, 93, replies.bad)).toBeUndefined();
  expect(matchesCaptions(captions, 120, 93, "only a few words")).toBe(true);
  expect(captionOverlap(captions, 1000, 93, replies.bad)).toBeUndefined();
});

it("builds cues from words when the server returns no segments", () => {
  const lines = replySegments({
    words: [
      { word: "Have", start: 14.63 },
      { word: "you", start: 14.8 },
      { word: "Inertia", start: 31.2 },
    ],
  });
  expect(lines).toEqual([
    { start: 14.63, text: "Have you" },
    { start: 31.2, text: "Inertia" },
  ]);
  expect(
    replySegments({
      segments: [
        { start: 0, text: "One." },
        { start: 9, text: "Two." },
      ],
    }),
  ).toEqual([
    { start: 0, text: "One." },
    { start: 9, text: "Two." },
  ]);
  expect(() => replySegments({ text: "no timestamps" })).toThrow();
});
