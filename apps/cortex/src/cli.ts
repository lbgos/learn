import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createEmbedder } from "./embedding.ts";
import { createCortexHttpServer, validateTokens } from "./http.ts";
import { CortexIndex } from "./index.ts";
import { CortexService } from "./service.ts";
import { Vault } from "./vault.ts";

const command = process.argv[2] ?? "serve";
if (!["serve", "rebuild"].includes(command))
  throw new Error("Usage: node src/cli.ts [serve|rebuild]");
const tokens = {
  readToken: process.env.CORTEX_READ_TOKEN ?? "",
  writeToken: process.env.CORTEX_WRITE_TOKEN ?? "",
};
if (command === "serve") validateTokens(tokens);
const host = process.env.CORTEX_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "::1"].includes(host)) throw new Error("Cortex must listen on loopback");
const port = Number(process.env.CORTEX_PORT ?? "3981");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CORTEX_PORT");
const vault = new Vault(
  NodePath.resolve(process.env.CORTEX_VAULT ?? NodePath.join(NodeOS.homedir(), "Cortex")),
  process.env.CORTEX_IMPORT_DIR === undefined
    ? {}
    : { importDirectory: process.env.CORTEX_IMPORT_DIR },
);
let index: CortexIndex | undefined;
try {
  const embedder = await createEmbedder(process.env.CORTEX_MODEL_CACHE);
  index = new CortexIndex(vault, embedder, { rebuild: command === "rebuild" });
  await index.synchronize();
  if (command === "rebuild") {
    console.log(JSON.stringify({ ...index.stats(), embedding: embedder.id }));
    index.close();
    vault.close();
  } else {
    const server = createCortexHttpServer(new CortexService(vault, index), tokens);
    server.on("error", () => {
      index?.close();
      vault.close();
      process.exitCode = 1;
    });
    server.listen(port, host, () => console.log(`Cortex MCP http://${host}:${port}/mcp`));
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () =>
        server.close(() => {
          index?.close();
          vault.close();
        }),
      );
    }
  }
} catch (error) {
  index?.close();
  vault.close();
  throw error;
}
