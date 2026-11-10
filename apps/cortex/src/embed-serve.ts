// Runs Cortex's embedder as a loopback service for the learner memory's hybrid search.
// Usage: pnpm embed   (EMBED_HOST, EMBED_PORT, EMBED_MODEL_CACHE); point LEARN_MEMORY_EMBED_URL at it.
import { createEmbedder } from "./embedding.ts";
import { createEmbedServer } from "./embedServer.ts";

const host = process.env.EMBED_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "::1"].includes(host)) throw new Error("The embedder must listen on loopback");
const port = Number(process.env.EMBED_PORT ?? "3982");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid EMBED_PORT");
const embedder = await createEmbedder(process.env.EMBED_MODEL_CACHE);
const server = createEmbedServer(embedder);
server.listen(port, host, () => console.log(`Embedder ${embedder.id} http://${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
