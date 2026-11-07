// Ported from learnharness (AGPL-3.0-only) tests/graph.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import { GraphChain, GraphNode, CoverageEntry, SessionCheckpoint, NotesSource } from "./model.ts";
import { decodeLedger, encodeLedger, decodePositions, assertGraphFormat } from "./ledger.ts";
import { node, chain } from "./test-fixtures.ts";
describe("tolerant ledger codecs", () => {
  it("round trips valid lines while dropping corrupt, foreign and malformed records", () => {
    const valid = node("n_a");
    const text =
      encodeLedger(GraphNode, [valid]) +
      '\n{"torn":\n' +
      JSON.stringify({ ...valid, aliases: [1] }) +
      "\n{}\n" +
      encodeLedger(GraphNode, [node("n_b")]);
    expect(decodeLedger(GraphNode, text)).toEqual([valid, node("n_b")]);
  });
  it("requires proposition/argument namespaces and nonempty chain premises", () => {
    const valid = chain("arg_one", ["n_a"], "n_b");
    expect(
      decodeLedger(
        GraphChain,
        [
          valid,
          { ...valid, id: "n_wrong" },
          { ...valid, premises: [] },
          { ...valid, premises: [4] },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n"),
      ),
    ).toEqual([valid]);
    expect(decodeLedger(GraphNode, JSON.stringify(node("arg_wrong")))).toEqual([]);
  });
  it("keeps coverage, checkpoint and notes metadata without guessing missing fields", () => {
    const covered = { chatId: "s1", fp: "abc", tokens: 20, foldedAt: "now" };
    expect(decodeLedger(CoverageEntry, JSON.stringify(covered))).toEqual([covered]);
    expect(decodeLedger(CoverageEntry, JSON.stringify({ ...covered, tokens: -1 }))).toEqual([]);
    const checkpoint = { chatId: "s1", foldedAt: "now" };
    expect(decodeLedger(SessionCheckpoint, JSON.stringify(checkpoint))).toEqual([checkpoint]);
    const source = {
      id: "notes:hash",
      filePath: "notes.md",
      importedAt: "now",
      contentFp: "digest",
      extractions: [
        {
          startedAt: 1,
          at: "now",
          durationMs: 20,
          stages: {
            extractor: { model: "extract", steps: [] },
            auditor: { model: "audit", steps: [] },
          },
        },
      ],
    };
    expect(decodeLedger(NotesSource, JSON.stringify(source))).toEqual([source]);
    expect(decodeLedger(GraphNode, JSON.stringify({ id: "n_old", statement: "text" }))).toEqual([]);
  });
  it("drops bad positions independently, retaining only finite coordinates", () => {
    expect(
      decodePositions({
        n_a: { x: 1, y: 2 },
        n_b: { x: Infinity, y: 1 },
        n_c: { x: "1", y: 2 },
        n_d: { x: 1 },
      }),
    ).toEqual({ n_a: { x: 1, y: 2 } });
    expect(decodePositions(null)).toEqual({});
  });
  it("refuses future formats while tolerating missing and corrupt sidecars", () => {
    expect(() => assertGraphFormat({ version: 2 })).toThrow(/newer/);
    for (const raw of [undefined, null, {}, { version: "2" }, { version: 1 }])
      expect(() => assertGraphFormat(raw)).not.toThrow();
  });
});
