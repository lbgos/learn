// Ported from learnharness (AGPL-3.0-only) tests/extraction.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import { auditCandidates, validateExtractorSubmit, validateAuditorSubmit } from "./extraction.ts";
import {
  buildExtractorPrompt,
  buildAuditorPrompt,
  sourceDigest,
  EXTRACTION_CORE,
  SESSION_PREAMBLE,
  NOTES_PREAMBLE,
  SESSION_MESSAGE_ID_RULE,
} from "./prompts.ts";
import { healStringifiedArrays, healEncodedArguments } from "./argument-heal.ts";
import { messageViewLines } from "./coverage.ts";
import { node, chain } from "./test-fixtures.ts";
const fresh = (id = "p1") => ({
  id,
  name: "Force",
  statement: "Force changes momentum.",
  aliases: [],
});
describe("extractor submit boundary", () => {
  it("requires both top-level arrays, but fills optional aliases", () => {
    expect(validateExtractorSubmit({ propositions: [] }).ok).toBe(false);
    expect(validateExtractorSubmit({ chains: [] }).ok).toBe(false);
    expect(
      validateExtractorSubmit({
        propositions: [{ id: "p1", name: "Force", statement: "A fact" }],
        chains: [],
      }),
    ).toEqual({
      ok: true,
      value: {
        propositions: [{ id: "p1", name: "Force", statement: "A fact", aliases: [] }],
        chains: [],
      },
    });
  });
  it("accepts mixed local/existing n_ endpoints and duplicate argument assertions", () => {
    const c = { premises: ["n_old"], conclusion: "p1" };
    expect(
      validateExtractorSubmit(
        { propositions: [fresh()], chains: [c, c] },
        { existingIds: new Set(["n_old"]) },
      ).ok,
    ).toBe(true);
  });
  it("rejects empty, dangling and self-referential arguments for error-back", () => {
    const examples = [
      { chain: { premises: [], conclusion: "p1" }, pattern: /length|item|at least/i },
      { chain: { premises: ["missing"], conclusion: "n_other" }, pattern: /missing/ },
      { chain: { premises: ["p1"], conclusion: "p1" }, pattern: /own premise/ },
    ];
    for (const example of examples) {
      const result = validateExtractorSubmit({ propositions: [fresh()], chains: [example.chain] });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected problems");
      expect(result.problems.join(" ")).toMatch(example.pattern);
    }
  });
  it("rejects duplicate local IDs and graph namespace collisions", () => {
    for (const propositions of [
      [fresh(), fresh()],
      [fresh("n_existing")],
      [fresh("arg_existing")],
    ]) {
      expect(validateExtractorSubmit({ propositions, chains: [] }).ok).toBe(false);
    }
  });
  it("accepts only message anchors from this session stretch and strips notes anchors", () => {
    const payload = { propositions: [{ ...fresh(), messageId: "m1" }], chains: [] };
    const options = { kind: "session", messageIds: new Set(["m1"]) } satisfies Parameters<
      typeof validateExtractorSubmit
    >[1];
    expect(validateExtractorSubmit(payload, options).ok).toBe(true);
    expect(validateExtractorSubmit({ ...payload, propositions: [fresh()] }, options).ok).toBe(
      false,
    );
    expect(
      validateExtractorSubmit(
        { ...payload, propositions: [{ ...fresh(), messageId: "other-batch" }] },
        options,
      ).ok,
    ).toBe(false);
    const notes = validateExtractorSubmit(payload);
    expect(notes.ok && notes.value.propositions[0]).not.toHaveProperty("messageId");
  });
  it("heals stringified arrays and leaves malformed/truncated values invalid", () => {
    const result = validateExtractorSubmit({
      propositions: JSON.stringify([fresh()]),
      chains: "[]",
    });
    expect(result.ok).toBe(true);
    expect(validateExtractorSubmit({ propositions: '[{"id":', chains: "[]" }).ok).toBe(false);
    expect(healStringifiedArrays({ propositions: "{}" })).toEqual({ propositions: "{}" });
  });
});
describe("one-shot identity audit", () => {
  it("ranks names, aliases and statements, and appends every same-source birth beyond top eight", () => {
    const unrelated = Array.from({ length: 10 }, (_, i) =>
      node(`n_other${i}`, "other", { name: "Unrelated", statement: "An unrelated statement" }),
    );
    const sameSource = Array.from({ length: 12 }, (_, i) =>
      node(`n_same${i}`, "source", { name: "Other" }),
    );
    const exact = node("n_exact", "other", { name: "Force" });
    const alias = node("n_alias", "other", { name: "Another", aliases: ["Force"] });
    const statement = node("n_statement", "other", { name: "X", statement: "Force" });
    const groups = auditCandidates(
      { nodes: [...unrelated, ...sameSource, exact, alias, statement], chains: [] },
      [fresh()],
      { perFinding: 8, sourceId: "source" },
    );
    expect(groups[0]?.nodes.slice(0, 3).map((n) => n.id)).toEqual([
      "n_exact",
      "n_alias",
      "n_statement",
    ]);
    for (const n of sameSource) expect(groups[0]?.nodes.map((n) => n.id)).toContain(n.id);
    expect(new Set(groups[0]?.nodes.map((n) => n.id)).size).toBe(groups[0]?.nodes.length);
  });
  it("uses per-finding source provenance and stable ties", () => {
    const nodes = [node("n_b", "source"), node("n_a", "other")];
    const groups = auditCandidates({ nodes, chains: [] }, [{ ...fresh(), sourceId: "source" }], {
      perFinding: 0,
    });
    expect(groups[0]?.nodes.map((n) => n.id)).toEqual(["n_b"]);
    expect(
      auditCandidates({ nodes, chains: [] }, [fresh()], { perFinding: 1 })[0]?.nodes[0]?.id,
    ).toBe("n_b");
  });
  it("validates identity-only links against the finding's actual candidates", () => {
    const findings = [fresh(), fresh("p2")];
    const candidates = [
      { findingId: "p1", nodes: [node("n_a")] },
      { findingId: "p2", nodes: [node("n_b")] },
    ];
    expect(
      validateAuditorSubmit({ links: [{ id: "p1", linkTo: "n_a" }] }, findings, candidates).ok,
    ).toBe(true);
    expect(validateAuditorSubmit({ links: [] }, findings, candidates).ok).toBe(true);
    expect(validateAuditorSubmit({}, findings, candidates).ok).toBe(false);
    for (const links of [
      [{ id: "unknown", linkTo: "n_a" }],
      [{ id: "p1", linkTo: "n_b" }],
      [
        { id: "p1", linkTo: "n_a" },
        { id: "p1", linkTo: "n_a" },
      ],
    ])
      expect(validateAuditorSubmit({ links }, findings, candidates).ok).toBe(false);
    expect(
      validateAuditorSubmit({ links: '[{"id":"p1","linkTo":"n_a"}]' }, findings, candidates).ok,
    ).toBe(true);
  });
  it("renders only findings and candidates, with equivalence bias and no source transcript", () => {
    const result = buildAuditorPrompt(
      [fresh()],
      [{ findingId: "p1", nodes: [node("n_a", "source", { statement: "Existing fact" })] }],
    );
    expect(result.prompt).toContain("p1 | Force | Force changes momentum.");
    expect(result.prompt).toContain("n_a | n_a | Existing fact");
    expect(result.systemPrompt).toContain("EQUIVALENCE BIAS");
    expect(result.systemPrompt).toContain("Decide from the candidates");
    expect(result.systemPrompt).not.toContain("call list_sessions");
  });
});
describe("digest-aware stretch prompts", () => {
  const graph = {
    nodes: [node("n_a", "source"), node("n_b", "other"), node("n_c", "source")],
    chains: [chain("arg_a", ["n_a", "n_b"], "n_c", "source")],
  };
  it("renders same-source ideas and chain ids verbatim, first stretch has no digest", () => {
    const digest = sourceDigest(graph, "source");
    expect(digest).toContain("THE GRAPH SO FAR");
    expect(digest).toContain("[n_a + n_b ⇒ n_c]");
    expect(digest).not.toContain("n_b | n_b |");
    expect(sourceDigest(graph, "missing")).toBe("");
  });
  it("shares extraction core across both doors and labels session passages identically to coverage", () => {
    const message = { id: "m1", text: " Teacher prose " };
    const session = buildExtractorPrompt({
      kind: "session",
      sourceId: "source",
      graph,
      title: "Mechanics",
      messages: [message],
      part: { i: 2, n: 3 },
    });
    const notes = buildExtractorPrompt({
      kind: "notes",
      sourceId: "notes:x",
      graph,
      text: "Notes text",
      filePath: "notes.md",
    });
    expect(session.systemPrompt).toBe(
      `${SESSION_PREAMBLE}\n\n${EXTRACTION_CORE}\n\n${SESSION_MESSAGE_ID_RULE}`,
    );
    expect(notes.systemPrompt).toBe(`${NOTES_PREAMBLE}\n\n${EXTRACTION_CORE}`);
    expect(session.prompt).toContain(messageViewLines(message).join("\n"));
    expect(session.prompt).toContain("THE GRAPH SO FAR");
    expect(session.prompt).toContain("Stretch 2/3");
    expect(notes.prompt).not.toContain("THE GRAPH SO FAR");
    expect(notes.prompt).toContain("notes.md\n\nNotes text");
  });
});
describe("primitive argument heal", () => {
  it("repairs encoded enums/arrays while preserving correct values and free text", () => {
    const schema = {
      properties: {
        type: { anyOf: [{ const: "recall" }, { const: "choice" }] },
        flag: { type: "boolean" },
        values: { type: "array" },
        text: { type: "string" },
      },
    };
    expect(
      healEncodedArguments(
        { type: '"recall"', flag: "true", values: "[1,2]", text: '"untouched"' },
        schema,
      ),
    ).toEqual({ type: "recall", flag: true, values: [1, 2], text: '"untouched"' });
    const valid = { type: "choice" };
    expect(healEncodedArguments(valid, schema)).toBe(valid);
  });
});
