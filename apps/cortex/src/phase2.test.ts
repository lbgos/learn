import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { Vault } from "./vault.ts";
import { CortexIndex } from "./index.ts";
import { CortexService } from "./service.ts";
import { createCortexHttpServer, validateTokens } from "./http.ts";
import { ingestTranscript, transcriptSource } from "../../server/src/learn/cortex/transcript.ts";

function fixture(t: NodeTest.TestContext) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cortex-phase2-"));
  const vault = new Vault(directory);
  const index = new CortexIndex(vault, {
    id: "fixture-phase2",
    dimensions: 3,
    async embed() {
      return new Float32Array([1, 0, 0]);
    },
  });
  t.after(() => {
    index.close();
    vault.close();
  });
  return { vault, index, service: new CortexService(vault, index) };
}

const transcript =
  "# Gradient lecture\nchannel: Fixture channel | url: https://www.youtube.com/watch?v=abcdefghijk | duration: 12:34\nsource: youtube captions (manual, en)\n\n[00:00] Gradient descent follows the negative gradient.\n[00:15] Curvature affects convergence.\n";

NodeTest.test(
  "path imports fail closed, including traversal and symlinks outside the allowed directory",
  (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cortex-path-"));
    const allowed = NodePath.join(root, "allowed");
    NodeFS.mkdirSync(allowed);
    const inside = NodePath.join(allowed, "ok.md");
    const outside = NodePath.join(root, "outside.md");
    NodeFS.writeFileSync(inside, "Allowed text");
    NodeFS.writeFileSync(outside, "Fixture outside allowed directory");
    NodeFS.symlinkSync(outside, NodePath.join(allowed, "link.md"));
    NodeFS.symlinkSync(root, NodePath.join(allowed, "parent"));
    const disabled = new Vault(NodePath.join(root, "disabled"));
    const restricted = new Vault(NodePath.join(root, "restricted"), { importDirectory: allowed });
    t.after(() => {
      disabled.close();
      restricted.close();
    });
    const metadata = { kind: "note", title: "Fixture" };
    NodeAssert.throws(() => disabled.addSource({ ...metadata, path: inside }), /disabled/);
    for (const file of [
      outside,
      NodePath.join(allowed, "../outside.md"),
      NodePath.join(allowed, "link.md"),
      NodePath.join(allowed, "parent/outside.md"),
    ])
      NodeAssert.throws(() => restricted.addSource({ ...metadata, path: file }), /outside/);
    const receipt = restricted.addSource({ ...metadata, path: inside });
    NodeAssert.equal(restricted.source(receipt.sourceId).body, "Allowed text");
    NodeAssert.equal(disabled.events.length, 0);
    NodeAssert.equal(restricted.events.length, 1);
  },
);

NodeTest.test(
  "advisor uses explicit current understanding, keeps exposure distinct, and exports tagged graph links",
  async (t) => {
    const { service, vault } = fixture(t);
    const source = await service.addSource({
      text: transcript,
      kind: "video",
      title: "Gradient lecture",
      concepts: ["gradient descent", "curvature"],
    });
    const input = { text: transcript, concepts: ["gradient descent", "curvature"] };
    NodeAssert.equal((await service.advise(input)).recommendation, "watch");
    service.record({ type: "exposure", statement: "gradient descent curvature", confidence: 1 });
    NodeAssert.equal((await service.advise(input)).score, 0);
    const records = input.concepts.map((concept) =>
      service.record({
        type: "understanding",
        statement: concept,
        concepts: [concept],
        stance: "affirm",
        confidence: 0.9,
        sourceRef: { sourceId: source.sourceId },
      }),
    );
    for (let i = 0; i < 4; i++)
      service.record({ type: "endorsement", statement: "gradient descent", confidence: 1 });
    let advice = await service.advise(input);
    NodeAssert.ok(advice.evidence[0]!.observations.some((item) => item.id === records[0]!.id));
    NodeAssert.equal(advice.recommendation, "skip");
    NodeAssert.equal(advice.newConcepts.length, 0);
    NodeAssert.equal(advice.reasons.length, 3);
    NodeAssert.ok(advice.line.startsWith("skip:"));
    NodeAssert.ok(advice.evidence[0]!.passages[0]!.revision);
    service.record({
      type: "understanding",
      statement: "curvature",
      stance: "uncertain",
      confidence: null,
      supersedes: records[1]!.id,
    });
    advice = await service.advise(input);
    NodeAssert.equal(advice.recommendation, "watch");
    NodeAssert.deepEqual(advice.newConcepts, ["curvature"]);
    service.record({
      type: "belief",
      statement: "gradient descent",
      stance: "reject",
      confidence: 0.8,
      concepts: ["gradient descent"],
    });
    NodeAssert.equal(
      (await service.advise({ text: transcript, concepts: ["gradient descent"] })).recommendation,
      "watch",
    );
    const graph = service.graph({ limit: 5 });
    NodeAssert.ok(graph.nodes.some((node) => node.kind === "concept"));
    NodeAssert.ok(
      graph.edges.some((edge) => edge.from === source.sourceId && edge.to.startsWith("concept:")),
    );
    NodeAssert.ok(
      graph.edges.some((edge) => edge.from === records[0]!.id && edge.to.startsWith("concept:")),
    );
    NodeAssert.equal(graph.nextAfter, 5);
    let cursor: number | null = graph.nextAfter;
    let foundBelief = false;
    while (cursor !== null) {
      const page = service.graph({ after: cursor });
      foundBelief ||= page.nodes.some((node) => node.kind === "belief");
      cursor = page.nextAfter;
    }
    NodeAssert.ok(foundBelief);
    NodeAssert.equal(vault.events.filter((event) => event.type === "source.added").length, 1);
  },
);

NodeTest.test(
  "HTTP scoped tokens and the tutor ingestion path preserve metadata and idempotence",
  async (t) => {
    const { service, vault } = fixture(t);
    const tokens = {
      readToken: NodeCrypto.randomBytes(32).toString("hex"),
      writeToken: NodeCrypto.randomBytes(32).toString("hex"),
    };
    NodeAssert.throws(() =>
      validateTokens({ readToken: tokens.readToken, writeToken: tokens.readToken }),
    );
    NodeAssert.throws(() => validateTokens({ readToken: "short", writeToken: tokens.writeToken }));
    const server = createCortexHttpServer(service, tokens);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    NodeAssert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const rpc = async (token: string, method: string, params: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      NodeAssert.equal(response.status, 200);
      return (await response.json()) as {
        result?: { tools?: Array<{ name: string }>; isError?: boolean };
        error?: unknown;
      };
    };
    const catalogue = await rpc(tokens.readToken, "tools/list", {});
    NodeAssert.deepEqual(catalogue.result?.tools?.map((tool) => tool.name).sort(), [
      "cortex_advise",
      "cortex_beliefs",
      "cortex_graph",
      "cortex_read",
      "cortex_search",
    ]);
    for (const name of ["cortex_add_source", "cortex_record"]) {
      const denied = await rpc(tokens.readToken, "tools/call", {
        name,
        arguments:
          name === "cortex_add_source"
            ? { text: "x", kind: "note", title: "No" }
            : { type: "belief", statement: "No", confidence: null },
      });
      NodeAssert.ok(denied.error || denied.result?.isError);
    }
    NodeAssert.equal(vault.events.length, 0);
    await NodeAssert.rejects(
      ingestTranscript("transcripts/abcdefghijk.md", transcript, {
        url,
        writeBearerToken: tokens.readToken,
      }),
    );
    const connection = { url, writeBearerToken: tokens.writeToken };
    const receipt = await ingestTranscript("transcripts/abcdefghijk.md", transcript, connection);
    NodeAssert.equal(receipt.indexed, true);
    NodeAssert.deepEqual(
      await ingestTranscript("transcripts/abcdefghijk.md", transcript, connection),
      receipt,
    );
    NodeAssert.deepEqual(vault.source(receipt.sourceId).metadata, {
      kind: "video",
      title: "Gradient lecture",
      channel: "Fixture channel",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      durationSeconds: 754,
      language: "und",
      added: vault.source(receipt.sourceId).metadata.added,
    });
    NodeAssert.equal(vault.source(receipt.sourceId).body, transcript);
    NodeAssert.equal(vault.events.length, 1);
    NodeAssert.throws(() => transcriptSource("transcripts/abcdefghijk.raw.md", transcript));
    NodeAssert.throws(() => transcriptSource("transcripts/lmnopqrstuv.md", transcript));
    const restricted = await rpc(tokens.writeToken, "tools/call", {
      name: "cortex_add_source",
      arguments: { path: "/etc/passwd", kind: "note", title: "Denied" },
    });
    NodeAssert.ok(restricted.result?.isError);
  },
);
