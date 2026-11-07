// Ported from learnharness (AGPL-3.0-only) tests/coverage.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import {
  messageViewLines,
  teacherProseBlocks,
  batchRuns,
  chunkNotes,
  estimateTokens,
} from "./coverage.ts";
import {
  messageFingerprint,
  coverageSlots,
  coverageOf,
  batchTag,
  sha256,
  notesSourceId,
} from "./node/index.ts";
const message = (id: string, text: string) => ({ id, text });
describe("teacher prose coverage", () => {
  it("fingerprints exactly the labeled extraction view, including message identity", () => {
    const a = message("m1", " hello world ");
    expect(messageViewLines(a)).toEqual(["TEACHER [m1] hello world"]);
    expect(messageFingerprint(a)).toBe(sha256(JSON.stringify(["assistant", messageViewLines(a)])));
    expect(messageFingerprint(a)).toBe(messageFingerprint(message("m1", "hello world")));
    expect(messageFingerprint(a)).not.toBe(messageFingerprint(message("m2", "hello world")));
    expect(messageFingerprint(a)).not.toBe(messageFingerprint(message("m1", "hello worlds")));
  });
  it("ignores blank prose and estimates chars/4 on the same view", () => {
    expect(teacherProseBlocks([message("m1", " a "), message("blank", " ")])).toEqual(["a"]);
    const slots = coverageSlots([message("m1", "a"), message("blank", " ")]);
    expect(slots.map((s) => s.tokens)).toEqual([estimateTokens("TEACHER [m1] a"), 0]);
    expect(
      coverageOf(
        slots.map((s) => s.message),
        [],
        "s1",
      ).uncovered,
    ).toEqual([0]);
  });
  it("derives uncovered state per source; editing prose reopens only that message", () => {
    const messages = [message("m1", "first"), message("m2", "second")];
    const ledger = coverageSlots(messages).map((s) => ({
      chatId: "s1",
      fp: s.fp,
      tokens: s.tokens,
      foldedAt: "now",
    }));
    expect(coverageOf(messages, ledger, "s1").coveredCount).toBe(2);
    expect(coverageOf(messages, ledger, "other").uncoveredCount).toBe(2);
    const edited = coverageOf([messages[0]!, message("m2", "second edit")], ledger, "s1");
    expect(edited.uncovered).toEqual([1]);
    expect(edited.coveredTokens).toBe(coverageSlots(messages)[0]?.tokens);
  });
  it("greedily fills oldest uncovered messages, preserving oversized messages", () => {
    const slots = coverageSlots([
      message("m1", "a"),
      message("m2", "b"),
      message("m3", "x".repeat(100)),
    ]);
    const budget = slots[0]!.tokens + slots[1]!.tokens;
    const batches = batchRuns(slots, [0, 1, 2], budget);
    expect(batches.map((b) => b.map((s) => s.message.id))).toEqual([["m1", "m2"], ["m3"]]);
    expect(batchRuns(slots, [0], 0)).toEqual([]);
    expect(batchTag(batches[0]!)).toBe(batchTag(batches[0]!));
    expect(batchTag(batches[0]!)).not.toBe(batchTag([...batches[0]!].reverse()));
  });
  it("chunks notes at line boundaries under the same token budget, keeping blank lines", () => {
    const text = "\nalpha\n\nbeta\n" + "x".repeat(40) + "\n";
    const chunks = chunkNotes(text, 3);
    expect(chunks.join("\n")).toBe(text);
    expect(chunks.some((chunk) => chunk === "x".repeat(40))).toBe(true);
    expect(chunks.filter((chunk) => estimateTokens(chunk) > 3)).toEqual(["x".repeat(40)]);
    expect(chunkNotes(" ", 5)).toEqual([]);
    expect(chunkNotes("a", 0)).toEqual([]);
  });
  it("uses path-based deterministic note source ids", () => {
    expect(notesSourceId("notes/a.md")).toBe(`notes:${sha256("notes/a.md")}`);
    expect(notesSourceId("notes/a.md")).not.toBe(notesSourceId("notes/b.md"));
  });
});
