import * as NodeHttp from "node:http";
import type { Embedder } from "./embedding.ts";

/** Bounds per request, so a caller cannot hold the model for long. */
export const embedLimits = { texts: 64, textChars: 2000, bodyBytes: 256 * 1024 } as const;

/**
 * A stateless loopback HTTP server over `embedder` for the learner memory's hybrid search.
 * `POST /embed` takes `{ texts, query }` and answers `{ model, dimensions, vectors }`; `GET /health`
 * answers `{ model }`. Requests run one at a time, so bursts stay within the unit's memory cap.
 */
export function createEmbedServer(embedder: Embedder) {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <A>(task: () => Promise<A>) => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  return NodeHttp.createServer((request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && request.url === "/health")
      return reply(200, { model: embedder.id });
    if (request.method !== "POST" || request.url !== "/embed")
      return reply(404, { error: "not found" });
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > embedLimits.bodyBytes) {
        reply(413, { error: "body too large" });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", async () => {
      if (response.headersSent) return;
      let input: { texts?: unknown; query?: unknown };
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(400, { error: "invalid JSON" });
      }
      const texts = input.texts;
      if (
        !Array.isArray(texts) ||
        texts.length === 0 ||
        texts.length > embedLimits.texts ||
        !texts.every((text) => typeof text === "string")
      )
        return reply(400, { error: `texts must be 1 to ${embedLimits.texts} strings` });
      try {
        const vectors = await serialized(async () => {
          const out: number[][] = [];
          for (const text of texts as string[])
            out.push(
              Array.from(
                await embedder.embed(text.slice(0, embedLimits.textChars), input.query === true),
              ),
            );
          return out;
        });
        reply(200, { model: embedder.id, dimensions: embedder.dimensions, vectors });
      } catch {
        reply(500, { error: "embedding failed" });
      }
    });
  });
}
