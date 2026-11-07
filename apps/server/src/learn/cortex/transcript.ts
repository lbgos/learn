// Shared by the command boundary and focused ingestion tests. The proofread file is sent as text.
function transcriptSource(relativePath: string, text: string) {
  const videoId = /^transcripts\/([\w-]{11})\.md$/.exec(relativePath)?.[1];
  if (!videoId) throw new Error("Expected transcripts/<videoId>.md, never a raw transcript");
  if (Buffer.byteLength(text) > 2_000_000) throw new Error("Transcript exceeds 2 MB");
  const header =
    /^# (.+)\r?\nchannel: (.+) \| url: (https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}) \| duration: ((?:\d+:)?\d+:\d{2})\r?\n/u.exec(
      text,
    );
  if (!header || new URL(header[3]!).searchParams.get("v") !== videoId)
    throw new Error("Preserve title, channel, canonical URL and duration in the proofread header");
  const parts = header[4]!.split(":").map(Number);
  if (parts.slice(1).some((part) => part > 59)) throw new Error("Invalid duration");
  const durationSeconds = parts.reduce((total, part) => total * 60 + part, 0);
  return {
    kind: "video" as const,
    title: header[1]!,
    channel: header[2]!,
    url: header[3]!,
    durationSeconds,
    text,
  };
}

export async function ingestTranscript(
  relativePath: string,
  text: string,
  connection: { url: string; writeBearerToken: string },
  request: typeof fetch = fetch,
) {
  const source = transcriptSource(relativePath, text);
  const url = new URL(connection.url);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password
  )
    throw new Error("Cortex must be configured on loopback at /mcp");
  if (connection.writeBearerToken.length < 24) throw new Error("Configure a Cortex write token");
  const response = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${connection.writeBearerToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cortex_add_source", arguments: source },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error("Cortex ingestion HTTP request failed");
  const reply: unknown = await response.json();
  if (!reply || typeof reply !== "object" || "error" in reply || !("result" in reply))
    throw new Error("Cortex ingestion failed");
  const result = reply.result;
  if (
    !result ||
    typeof result !== "object" ||
    ("isError" in result && result.isError) ||
    !("content" in result) ||
    !Array.isArray(result.content)
  )
    throw new Error("Cortex ingestion failed");
  const item: unknown = result.content[0];
  if (!item || typeof item !== "object" || !("text" in item) || typeof item.text !== "string")
    throw new Error("Missing Cortex receipt");
  const receipt: unknown = JSON.parse(item.text);
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("sourceId" in receipt) ||
    typeof receipt.sourceId !== "string" ||
    !("indexed" in receipt) ||
    typeof receipt.indexed !== "boolean"
  )
    throw new Error("Invalid Cortex receipt");
  // Never echo server errors, transcript text, or connection settings from this command.
  return { sourceId: receipt.sourceId, indexed: receipt.indexed };
}
