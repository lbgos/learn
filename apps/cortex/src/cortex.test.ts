import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeCrypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Vault } from "./vault.ts";
import { chunkSource, parseSource, serializeSource, timestamp } from "./source.ts";
import { CortexIndex, reciprocalRankFusion } from "./index.ts";
import { CortexService } from "./service.ts";
import { boundedResult, createCortexHttpServer } from "./http.ts";
import { limits, searchSchema, truncateBytes } from "./schema.ts";
import type { Embedder } from "./embedding.ts";

const temporary = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cortex-test-"));
const metadata = {
  kind: "note" as const,
  title: 'A "quoted" title: Україна',
  added: "2026-10-26T00:00:00Z",
  language: "uk",
};
const embedder: Embedder = {
  id: "tiny-fixture-v1",
  dimensions: 3,
  async embed(text) {
    if (/round|gradient|округлен/iu.test(text)) return new Float32Array([1, 0, 0]);
    if (/git|commit/iu.test(text)) return new Float32Array([0, 1, 0]);
    return new Float32Array([0, 0, 1]);
  },
};

function fixture() {
  const directory = temporary();
  const vault = new Vault(directory);
  const index = new CortexIndex(vault, embedder);
  NodeTest.after(() => {
    index.close();
    vault.close();
  });
  return { directory, vault, index, service: new CortexService(vault, index) };
}

NodeTest.test("front matter round trips punctuation, Ukrainian, URLs and multiline bodies", () => {
  const markdown = serializeSource(
    { ...metadata, url: "https://example.org/video" },
    "# Title\nПривіт\n---\nbody",
  );
  const source = parseSource(markdown);
  NodeAssert.deepEqual(source.metadata, { ...metadata, url: "https://example.org/video" });
  NodeAssert.equal(source.body, "# Title\nПривіт\n---\nbody");
  NodeAssert.throws(() => parseSource("---\ntitle: x\n---\ny"));
  NodeAssert.throws(() => parseSource(markdown.replace("kind:", "title: 1\nkind:")));
});

NodeTest.test(
  "chunking overlaps one anchor and preserves artifact lines, revision, and known times",
  () => {
    const markdown = serializeSource(
      { ...metadata, kind: "video" },
      "# header\n[00:00] one two\n[00:15] three four\n[00:30] five six\n[00:45] seven eight",
    );
    const source = parseSource(markdown);
    const chunks = chunkSource("fixture", markdown, 4);
    NodeAssert.equal(chunks.length, 3);
    NodeAssert.equal(chunks[0]!.to, chunks[1]!.from);
    NodeAssert.equal(chunks[0]!.timeFrom, 0);
    NodeAssert.equal(chunks[0]!.timeTo, 30);
    NodeAssert.equal(chunks.at(-1)!.timeTo, null);
    for (const chunk of chunks) {
      NodeAssert.equal(chunk.body, source.lines.slice(chunk.from - 1, chunk.to).join("\n"));
      NodeAssert.equal(chunk.revision, source.revision);
    }
    NodeAssert.equal(timestamp("[01:02:03] words"), 3723);
    NodeAssert.equal(timestamp("[ON SCREEN 04:20] equation"), 260);
    NodeAssert.ok(
      chunkSource("fixture", serializeSource(metadata, "plain note\nmore text")).length,
    );
  },
);

NodeTest.test(
  "a writer lock left by an earlier boot or a dead process is replaced",
  { skip: !NodeFS.existsSync("/proc/sys/kernel/random/boot_id") },
  () => {
    const bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const deadPid = NodeChildProcess.spawnSync("true").pid;
    for (const owner of ["00000000-0000-0000-0000-000000000000 1\n", `${bootId} ${deadPid}\n`]) {
      const directory = temporary();
      NodeFS.writeFileSync(NodePath.join(directory, ".writer.lock"), owner);
      new Vault(directory).close();
    }
    const directory = temporary();
    NodeFS.writeFileSync(NodePath.join(directory, ".writer.lock"), `${bootId} ${process.pid}\n`);
    NodeAssert.throws(() => new Vault(directory), /EEXIST/);
  },
);

NodeTest.test(
  "events append and replay without inferring mastery; corrections retain history",
  () => {
    const directory = temporary();
    const vault = new Vault(directory);
    const source = vault.addSource({
      text: "[00:00] topic\n[00:15] more",
      kind: "lecture",
      title: "Topic",
    });
    NodeAssert.equal(
      vault.addSource({ text: "[00:00] topic\n[00:15] more", kind: "lecture", title: "Topic" })
        .sourceId,
      source.sourceId,
    );
    NodeAssert.equal(vault.events.length, 1);
    NodeAssert.throws(() => new Vault(directory), /EEXIST/);
    const originalBytes = NodeFS.readFileSync(NodePath.join(directory, "events.jsonl"), "utf8");
    const event = vault.record({
      type: "belief",
      statement: "A belief",
      stance: "affirm",
      confidence: 0.8,
      sourceRef: { sourceId: source.sourceId, from: 7, to: 8 },
    });
    vault.record({
      type: "belief",
      statement: "A qualified belief",
      stance: "uncertain",
      confidence: null,
      supersedes: event.id,
    });
    NodeAssert.throws(
      () =>
        vault.record({ type: "belief", statement: "Branch", confidence: 1, supersedes: event.id }),
      /already superseded/,
    );
    NodeAssert.throws(() =>
      vault.record({
        type: "understanding",
        statement: "Wrong kind",
        confidence: 1,
        supersedes: event.id,
      }),
    );
    NodeAssert.throws(() =>
      vault.record({
        type: "exposure",
        statement: "Bad citation",
        confidence: null,
        sourceRef: { sourceId: source.sourceId, from: 999 },
      }),
    );
    NodeAssert.throws(() =>
      vault.record({
        type: "exposure",
        statement: "Bad time",
        confidence: null,
        sourceRef: { sourceId: source.sourceId, timeFrom: 999 },
      }),
    );
    NodeAssert.ok(
      NodeFS.readFileSync(NodePath.join(directory, "events.jsonl"), "utf8").startsWith(
        originalBytes,
      ),
    );
    const expected = [...vault.events];
    vault.close();
    const reopened = new Vault(directory);
    NodeAssert.deepEqual(reopened.events, expected);
    reopened.close();
    NodeFS.appendFileSync(NodePath.join(directory, "events.jsonl"), '{"partial":');
    NodeAssert.throws(() => new Vault(directory), /Incomplete event tail/);
  },
);

NodeTest.test("modified immutable artifacts fail replay rather than rewriting evidence", () => {
  const directory = temporary();
  const vault = new Vault(directory);
  const source = vault.addSource({ text: "original", kind: "note", title: "Original" });
  vault.close();
  NodeFS.appendFileSync(NodePath.join(directory, "sources", `${source.sourceId}.md`), "changed");
  NodeAssert.throws(() => new Vault(directory), /modified/);
});

NodeTest.test(
  "hybrid search ranks a tiny fixture and rebuild recovers files and events",
  async () => {
    const { vault, index, service } = fixture();
    const rounding = await service.addSource({
      text: "Stochastic rounding preserves a tiny gradient in expectation.",
      kind: "note",
      title: "Four bit training",
    });
    await service.addSource({
      text: "Git stores immutable commits on a central server.",
      kind: "note",
      title: "Version control",
    });
    const results = await index.search({ query: "tiny gradient rounding", k: 2 });
    NodeAssert.equal(results[0]!.sourceId, rounding.sourceId);
    NodeAssert.equal(results.length, 2);
    NodeAssert.equal(
      (await index.search({ query: "Як працює округлення?", k: 1 }))[0]!.sourceId,
      rounding.sourceId,
    );
    NodeAssert.deepEqual(
      reciprocalRankFusion([
        [1, 2],
        [2, 3],
      ]).map(([id]) => id),
      [2, 1, 3],
    );
    const belief = service.record({
      type: "belief",
      statement: "Rounding preserves expectation",
      confidence: 0.7,
    });
    service.record({
      type: "belief",
      statement: "Rounding may preserve expectation",
      confidence: 0.5,
      supersedes: belief.id,
    });
    NodeAssert.equal(
      index.beliefs("rounding").find((event) => event.id === belief.id)?.supersededBy !== null,
      true,
    );
    await index.synchronize(true);
    NodeAssert.equal(
      (await index.search({ query: "gradient", k: 1 }))[0]!.sourceId,
      rounding.sourceId,
    );
    NodeAssert.equal(index.beliefs("rounding").length, 2);
    NodeAssert.equal(vault.events.filter((event) => event.type === "source.added").length, 2);
  },
);

NodeTest.test("a corrupt disposable database rebuilds from authoritative files", async () => {
  const directory = temporary();
  const vault = new Vault(directory);
  const source = vault.addSource({
    text: "Stochastic rounding preserves gradients",
    kind: "note",
    title: "Rounding",
  });
  const first = new CortexIndex(vault, embedder);
  await first.synchronize();
  first.close();
  NodeFS.writeFileSync(NodePath.join(directory, "index.sqlite"), "corrupt database");
  const rebuilt = new CortexIndex(vault, embedder, { rebuild: true });
  try {
    await rebuilt.synchronize();
    NodeAssert.equal(
      (await rebuilt.search({ query: "rounding", k: 1 }))[0]!.sourceId,
      source.sourceId,
    );
    NodeAssert.equal(vault.events.length, 1);
  } finally {
    rebuilt.close();
    vault.close();
  }
});

NodeTest.test("result, input, byte, and excerpt caps hold for multibyte text", async () => {
  const { service, index } = fixture();
  const source = await service.addSource({
    text: Array.from({ length: 100 }, () => "ї".repeat(1000)).join("\n"),
    kind: "note",
    title: "Big source",
  });
  const excerpt = service.read({ sourceId: source.sourceId });
  NodeAssert.ok(excerpt.to < limits.excerptLines);
  NodeAssert.ok(Buffer.byteLength(excerpt.excerpt) <= limits.excerptBytes);
  NodeAssert.equal(excerpt.truncated, true);
  NodeAssert.equal(truncateBytes("її", 3), "ї");
  NodeAssert.throws(() => searchSchema.parse({ query: "a", k: 9 }));
  NodeAssert.throws(() => service.read({ sourceId: "../../etc/passwd" }));
  NodeAssert.throws(() => boundedResult("x".repeat(limits.responseBytes)));
  NodeAssert.throws(() =>
    service.vault.addSource({
      text: "я".repeat(limits.sourceBytes),
      kind: "note",
      title: "oversize",
    }),
  );
  NodeAssert.ok(
    (await index.search({ query: "ї", k: 8 })).every(
      (item) => item.snippet.length <= limits.snippetChars,
    ),
  );
});

NodeTest.test(
  "HTTP MCP SDK client exercises auth, tools, explicit events, and bounded errors",
  async () => {
    const { service } = fixture();
    const token = NodeCrypto.randomBytes(32).toString("hex");
    const server = createCortexHttpServer(service, {
      readToken: `${token}-read`,
      writeToken: token,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    NodeTest.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    NodeAssert.ok(address && typeof address === "object");
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    NodeAssert.equal((await fetch(url, { method: "POST" })).status, 401);
    NodeAssert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    NodeAssert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "x".repeat(limits.requestBytes + 1),
        })
      ).status,
      413,
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "cortex-test", version: "1" });
    await client.connect(transport as Transport);
    NodeTest.after(() => client.close());
    NodeAssert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      "cortex_add_source",
      "cortex_advise",
      "cortex_beliefs",
      "cortex_graph",
      "cortex_read",
      "cortex_record",
      "cortex_search",
    ]);
    const added = await client.callTool({
      name: "cortex_add_source",
      arguments: {
        text: "Stochastic rounding preserves small gradients.",
        kind: "note",
        title: "Rounding",
      },
    });
    const content = added.content;
    NodeAssert.ok(Array.isArray(content));
    const text = content[0];
    NodeAssert.ok(text && text.type === "text" && typeof text.text === "string");
    const receipt = JSON.parse(text.text) as { sourceId: string };
    NodeAssert.equal(service.vault.events.length, 1);
    NodeAssert.ok(
      !(await client.callTool({ name: "cortex_search", arguments: { query: "rounding" } })).isError,
    );
    NodeAssert.ok(
      !(await client.callTool({ name: "cortex_read", arguments: { sourceId: receipt.sourceId } }))
        .isError,
    );
    NodeAssert.ok(
      !(
        await client.callTool({
          name: "cortex_record",
          arguments: {
            type: "exposure",
            statement: "Read about rounding",
            confidence: null,
            sourceRef: { sourceId: receipt.sourceId },
          },
        })
      ).isError,
    );
    NodeAssert.ok(
      !(await client.callTool({ name: "cortex_beliefs", arguments: { query: "rounding" } }))
        .isError,
    );
    NodeAssert.equal(
      (await client.callTool({ name: "cortex_search", arguments: { query: "rounding", k: 99 } }))
        .isError,
      true,
    );
  },
);
