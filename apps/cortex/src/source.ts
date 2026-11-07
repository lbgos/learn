import * as NodeCrypto from "node:crypto";
import { sourceMetadataSchema, type SourceMetadata } from "./schema.ts";

export function hash(text: string) {
  return NodeCrypto.createHash("sha256").update(text).digest("hex");
}

// JSON scalar values are valid YAML. A flat, fixed header keeps parsing independent of YAML tags.
export function serializeSource(metadata: SourceMetadata, text: string) {
  const fields = Object.entries(sourceMetadataSchema.parse(metadata));
  return `---\n${fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${text}`;
}

export function parseSource(markdown: string) {
  const lines = markdown.split("\n");
  if (lines[0] !== "---") throw new Error("Missing source front matter");
  const end = lines.indexOf("---", 1);
  if (end < 1 || end > 12) throw new Error("Invalid source front matter");
  const fields: Record<string, unknown> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error("Invalid header field");
    const key = line.slice(0, separator);
    if (Object.hasOwn(fields, key)) throw new Error("Duplicate header field");
    const value = line.slice(separator + 1).trim();
    fields[key] = /^(?:["[0-9]|null$)/.test(value) ? JSON.parse(value) : value;
  }
  return {
    metadata: sourceMetadataSchema.strict().parse(fields),
    body: lines.slice(end + 1).join("\n"),
    bodyFrom: end + 2,
    lines,
    revision: hash(markdown),
  };
}

export function timestamp(line: string) {
  const match = /^\[(?:ON SCREEN )?(?:(\d+):)?(\d+):(\d{2})\]/.exec(line);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function chunkSource(sourceId: string, markdown: string, targetWords = 220) {
  const source = parseSource(markdown);
  const timestamped =
    ["video", "lecture"].includes(source.metadata.kind) &&
    source.lines.some((line, i) => i >= source.bodyFrom - 1 && timestamp(line) !== undefined);
  const items = source.lines.flatMap((body, index) => {
    if (index < source.bodyFrom - 1 || !body.trim()) return [];
    const time = timestamp(body);
    if (timestamped && time === undefined) return [];
    return [{ body, line: index + 1, time }];
  });
  const chunks = [];
  for (let start = 0; start < items.length;) {
    let stop = start;
    let words = 0;
    while (stop < items.length && words < targetWords) {
      const item = items[stop]!;
      const text = item.time === undefined ? item.body : item.body.replace(/^\[[^\]]*\]\s*/, "");
      words += text.split(/\s+/u).length;
      stop++;
    }
    const group = items.slice(start, stop);
    const first = group[0]!;
    const last = group.at(-1)!;
    // Last timestamp is an anchor, not a fabricated duration. timeTo is exclusive when known.
    chunks.push({
      sourceId,
      revision: source.revision,
      title: source.metadata.title,
      from: first.line,
      to: last.line,
      timeFrom: first.time ?? null,
      timeTo: items[stop]?.time ?? null,
      body: source.lines.slice(first.line - 1, last.line).join("\n"),
    });
    if (stop === items.length) break;
    start = Math.max(start + 1, stop - 1);
  }
  return chunks;
}
export type Passage = ReturnType<typeof chunkSource>[number];
