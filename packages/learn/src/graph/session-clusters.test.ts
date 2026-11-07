// Ported from learnharness (AGPL-3.0-only) tests/session-clusters.test.ts @ c549494.
import { describe, it, expect } from "vite-plus/test";
import {
  birthSessionOf,
  birthSessionPartition,
  impClusterKey,
  attachImpToCommunities,
} from "./session-clusters.ts";
import type { GraphNode, GraphChain } from "./model.ts";
const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });

const attachable = (
  c: GraphChain,
): Pick<GraphChain, "id" | "premises" | "conclusion" | "provenance"> => c;
const node = (
  id: string,
  name: string,
  provenance: Array<{ chatId: string; messageId: string }>,
): GraphNode => ({
  id,
  name,
  statement: `${name} statement`,
  aliases: [],
  createdAt: "2026-09-23T00:00:00.000Z",
  provenance,
});

describe("birthSessionPartition", () => {
  it("groups by the first provenance point, dedupes repeated lines, sorts deterministically", () => {
    const nodes = [
      node("a", "A", [pt("chat1")]),
      node("b", "B", [pt("chat1")]),
      node("c", "C", [pt("chat2")]),
      node("a", "A-linked", [pt("chat2")]), // link-append line for "a": ignored (first defines)
      node("d", "D", [pt("chat1")]),
    ];
    expect(birthSessionPartition(nodes)).toEqual([
      { id: "chat1", members: ["a", "b", "d"] },
      { id: "chat2", members: ["c"] },
    ]);
  });

  it("a SHARED node belongs to its birth session only — later contributors never claim it", () => {
    const nodes = [
      node("born-1", "X", [pt("chat1")]),
      node("born-1", "X-linked", [pt("chat2")]), // chat2 re-encountered it
      node("born-2", "Y", [pt("chat2")]),
    ];
    expect(
      birthSessionPartition(nodes),
      "chat2 holds only what it BIRTHED — sizes tie (1/1), id order breaks it",
    ).toEqual([
      { id: "chat1", members: ["born-1"] },
      { id: "chat2", members: ["born-2"] },
    ]);
  });

  it("deletion re-attribution: a stripped birth falls to the earliest remaining contributor; no provenance = unclustered", () => {
    const reattributed = node("survivor", "S", [pt("chat2"), pt("chat3")]);
    expect(birthSessionOf(reattributed)).toBe("chat2");
    const naked = node("naked", "N", []);
    expect(birthSessionOf(naked)).toBe(null);
    const partition = birthSessionPartition([reattributed, naked]);
    expect(partition, "the naked node joins nothing").toEqual([
      { id: "chat2", members: ["survivor"] },
    ]);
  });
});

describe("impClusterKey (majority among PREMISES' births)", () => {
  const chainOf = (
    premises: string[],
    provenance: Array<{ chatId: string; messageId: string }> = [],
  ) =>
    ({
      id: "arg_t",
      premises,
      conclusion: "c",
      provenance,
      createdAt: "2026-09-30T00:00:00.000Z",
    }) satisfies GraphChain;

  it("unanimous premises → that session", () => {
    const key = impClusterKey(chainOf(["p1", "p2", "p3"]), () => "chatA");
    expect(key).toBe("chatA");
  });

  it("cross-session majority wins (2 of 3 premises born in chatA)", () => {
    const births: Record<string, string | null> = { p1: "chatA", p2: "chatA", p3: "chatB" };
    const key = impClusterKey(chainOf(["p1", "p2", "p3"]), (id) => births[id] ?? null);
    expect(key).toBe("chatA");
  });

  it("tie → the chain's OWN birth (the asserting session), not the conclusion's", () => {
    const births: Record<string, string | null> = { p1: "chatA", p2: "chatB", c: "chatC" };
    const key = impClusterKey(chainOf(["p1", "p2"], [pt("chatT")]), (id) => births[id] ?? null);
    expect(key, "the chain's first provenance point breaks the tie").toBe("chatT");
  });

  it("no birth info at all → null is honest", () => {
    expect(impClusterKey(chainOf(["p1", "p2"]), () => null)).toBe(null);
  });
});

describe("attachImpToCommunities (the shared seam for pull + hulls)", () => {
  it("a multi-premise live chain's imp id joins its home community, members stay sorted", () => {
    const props = [
      node("p1", "P1", [pt("chatA")]),
      node("p2", "P2", [pt("chatA")]),
      node("p3", "P3", [pt("chatA")]),
    ];
    const communities = birthSessionPartition(props);
    attachImpToCommunities(communities, props, [
      attachable({
        id: "arg_t",
        premises: ["p1", "p2"],
        conclusion: "p3",
        provenance: [pt("chatA")],
        createdAt: "2026-09-30T00:00:00.000Z",
      }),
    ]);
    expect(communities[0]!.members).toEqual(["arg_t", "p1", "p2", "p3"]);
  });

  it("single-premise chains attach NOTHING (no imp node exists — the collapse)", () => {
    const props = [node("p1", "P1", [pt("chatA")]), node("p2", "P2", [pt("chatA")])];
    const communities = birthSessionPartition(props);
    attachImpToCommunities(communities, props, [
      attachable({
        id: "arg_t",
        premises: ["p1"],
        conclusion: "p2",
        provenance: [pt("chatA")],
        createdAt: "2026-09-30T00:00:00.000Z",
      }),
    ]);
    expect(communities[0]!.members).toEqual(["p1", "p2"]);
  });

  it("dangling chains mint nothing; a home community ABSENT from the list stays unattached", () => {
    const props = [
      node("p1", "P1", [pt("chatA")]),
      node("p1b", "P1b", [pt("chatA")]),
      node("p1c", "P1c", [pt("chatA")]),
    ];
    const elsewhere = [{ id: "chatB", members: ["q1"] }];
    attachImpToCommunities(elsewhere, props, [
      attachable({
        id: "arg_gone",
        premises: ["p1", "p1b"],
        conclusion: "ghost",
        provenance: [pt("chatA")],
        createdAt: "2026-09-30T00:00:00.000Z",
      }),
      attachable({
        id: "arg_home",
        premises: ["p1", "p1b"],
        conclusion: "p1c",
        provenance: [pt("chatA")],
        createdAt: "2026-09-30T00:00:00.000Z",
      }),
    ]);
    expect(elsewhere[0]!.members).toEqual(["q1"]);
  });
});
