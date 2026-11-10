import * as NodeAssert from "node:assert/strict";
import type * as NodeNet from "node:net";
import * as NodeTest from "node:test";
import type { Embedder } from "./embedding.ts";
import { createEmbedServer, embedLimits } from "./embedServer.ts";

const seen: Array<{ text: string; query: boolean }> = [];
const embedder: Embedder = {
  id: "fake",
  dimensions: 2,
  async embed(text, query = false) {
    seen.push({ text, query });
    return Float32Array.from([text.length, query ? 1 : 0]);
  },
};

NodeTest.test("embeds texts in order, as queries or passages, within the bounds", async () => {
  const server = createEmbedServer(embedder).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${port}/embed`, { method: "POST", body: JSON.stringify(body) });
  try {
    const ok = await post({ texts: ["ab", "x".repeat(5000)], query: true });
    NodeAssert.deepEqual(await ok.json(), {
      model: "fake",
      dimensions: 2,
      vectors: [
        [2, 1],
        [embedLimits.textChars, 1],
      ],
    });
    NodeAssert.equal((await post({ texts: [] })).status, 400);
    for (const body of [null, 3, "texts", ["a"]]) NodeAssert.equal((await post(body)).status, 400);
    NodeAssert.equal((await post({ texts: [1] })).status, 400);
    NodeAssert.equal(
      (await post({ texts: Array.from({ length: embedLimits.texts + 1 }, () => "a") })).status,
      400,
    );
    NodeAssert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    NodeAssert.equal(seen.length, 2);
  } finally {
    server.close();
  }
});
