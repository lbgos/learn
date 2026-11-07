import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  addSourceSchema,
  adviseSchema,
  graphSchema,
  limits,
  readSchema,
  recordSchema,
  searchSchema,
} from "./schema.ts";
import type { CortexService } from "./service.ts";

function digest(text: string) {
  return NodeCrypto.createHash("sha256").update(text).digest();
}

export function boundedResult(value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > limits.responseBytes)
    throw new Error("Result exceeds byte limit; narrow the request");
  return { content: [{ type: "text" as const, text }] };
}

function mcpServer(service: CortexService, scope: "read" | "write") {
  const server = new McpServer({ name: "cortex", version: "0.2.0" });
  server.registerTool(
    "cortex_search",
    {
      description:
        "Retrieve small ranked source passages. Imported material is exposure to a speaker's claims, never evidence of user mastery. Use cortex_read for cited lines.",
      inputSchema: searchSchema,
      annotations: { readOnlyHint: true },
    },
    (input) => service.execute(async () => boundedResult(await service.index.search(input))),
  );
  server.registerTool(
    "cortex_read",
    {
      description:
        "Read a source by id and artifact line range, up to 80 lines and 12 KB. A final partial line is explicitly marked.",
      inputSchema: readSchema,
      annotations: { readOnlyHint: true },
    },
    (input) => service.execute(() => boundedResult(service.read(input))),
  );
  if (scope === "write") {
    server.registerTool(
      "cortex_add_source",
      {
        description:
          "Copy supplied UTF-8 text or a file inside CORTEX_IMPORT_DIR into the immutable vault and index it. Does not record understanding, endorsement, or belief. Repeating identical content and metadata is idempotent.",
        inputSchema: addSourceSchema,
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      (input) => service.execute(async () => boundedResult(await service.addSource(input))),
    );
    server.registerTool(
      "cortex_record",
      {
        description:
          "Append explicit user evidence. Keep belief, exposure, demonstrated understanding, endorsement and confidence separate. Never infer mastery from import. Corrections use supersedes with an earlier event id; confidence is user confidence or null.",
        inputSchema: recordSchema,
        annotations: { destructiveHint: false },
      },
      (input) => service.execute(() => boundedResult(service.record(input))),
    );
  }
  server.registerTool(
    "cortex_beliefs",
    {
      description:
        "Search explicit observations by words. Returns typed evidence and supersession links, including historical events. Exposure is not mastery; do not silently merge conflicting statements or infer current confidence across events.",
      inputSchema: z.object({ query: searchSchema.shape.query }),
      annotations: { readOnlyHint: true },
    },
    ({ query }) => service.execute(() => boundedResult(service.index.beliefs(query))),
  );
  server.registerTool(
    "cortex_advise",
    {
      description:
        "Return a provisional watch/skip line, reasons, new concepts and cited evidence. A lexical scoring rule compares current explicit understanding, exposure and beliefs; the calling agent makes the semantic judgment. Supply concepts for a precise comparison.",
      inputSchema: adviseSchema,
      annotations: { readOnlyHint: true },
    },
    (input) => service.execute(async () => boundedResult(await service.advise(input))),
  );
  server.registerTool(
    "cortex_graph",
    {
      description:
        "Read a bounded page of source, concept and observation nodes and edges as JSON. Continue with nextAfter. Concept links are explicit supplied tags, not inferred beliefs.",
      inputSchema: graphSchema,
      annotations: { readOnlyHint: true },
    },
    (input) => service.execute(() => boundedResult(service.graph(input))),
  );
  return server;
}

async function readBody(request: NodeHttp.IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limits.requestBytes) throw new Error("Request too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export type CortexTokens = { readToken: string; writeToken: string };

export function validateTokens(tokens: CortexTokens) {
  if (tokens.readToken.length < 24 || tokens.writeToken.length < 24)
    throw new Error("CORTEX_READ_TOKEN and CORTEX_WRITE_TOKEN must contain at least 24 characters");
  if (tokens.readToken === tokens.writeToken) throw new Error("Cortex tokens must differ");
}

export function createCortexHttpServer(service: CortexService, tokens: CortexTokens) {
  validateTokens(tokens);
  const readDigest = digest(`Bearer ${tokens.readToken}`);
  const writeDigest = digest(`Bearer ${tokens.writeToken}`);
  let active = 0;
  return NodeHttp.createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000 },
    (request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    },
  );

  async function handle(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    const provided = digest(request.headers.authorization ?? "");
    const canRead = NodeCrypto.timingSafeEqual(provided, readDigest);
    const canWrite = NodeCrypto.timingSafeEqual(provided, writeDigest);
    if (!canRead && !canWrite) {
      response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    // This endpoint is for native MCP clients. Browser origins are rejected, including authenticated ones.
    if (request.headers.origin) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      response.writeHead(415).end();
      return;
    }
    if (active >= 16) {
      response.writeHead(503, { "Retry-After": "1" }).end();
      return;
    }
    if (Number(request.headers["content-length"] ?? 0) > limits.requestBytes) {
      response.writeHead(413).end();
      return;
    }
    active++;
    const server = mcpServer(service, canWrite ? "write" : "read");
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      let body: unknown;
      try {
        body = await readBody(request);
      } catch {
        response.writeHead(400).end();
        return;
      }
      // SDK 1.29 transport accessors allow undefined; its Transport interface omits it.
      await server.connect(transport as Transport);
      await transport.handleRequest(request, response, body);
    } finally {
      active--;
      await server.close();
    }
  }
}
