import * as NodeFSP from "node:fs/promises";

try {
  const settings = JSON.parse(
    await NodeFSP.readFile(
      process.argv[2] ?? "/var/lib/lbgos-learn/userdata/cortex-mcp.json",
      "utf8",
    ),
  );
  const response = await fetch(settings.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.bearerToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error();
  const reply = await response.json();
  const names = reply.result?.tools?.map((tool) => tool.name).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify([
      "cortex_advise",
      "cortex_beliefs",
      "cortex_graph",
      "cortex_read",
      "cortex_search",
    ])
  )
    throw new Error();
  console.log("Cortex HTTP reachable with the app's read-only token; five read tools, no writes.");
} catch {
  console.error(
    "Cortex connection check failed. Check service status and server-owned MCP config.",
  );
  process.exitCode = 1;
}
