// Ported from learnharness (AGPL-3.0-only) src/store/graph.ts @ c549494.
import * as Schema from "effect/Schema";
import { Position, CURRENT_GRAPH_FORMAT_VERSION } from "./model.ts";
/** Decode independently so a torn append cannot discard valid neighboring lines. */
export function decodeLedger<T>(schema: Schema.Codec<T>, contents: string): T[] {
  const decode = Schema.decodeUnknownSync(schema);
  const out: T[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(decode(JSON.parse(line)));
    } catch {
      /* corrupt lines are dropped */
    }
  }
  return out;
}
export function encodeLedger<T>(schema: Schema.Codec<T>, lines: ReadonlyArray<T>): string {
  const encode = Schema.encodeSync(schema);
  return lines.map((line) => JSON.stringify(encode(line)) + "\n").join("");
}
export function decodePositions(raw: unknown): Record<string, Position> {
  const out: Record<string, Position> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const decode = Schema.decodeUnknownSync(Position);
  for (const [id, value] of Object.entries(raw)) {
    try {
      Object.defineProperty(out, id, {
        value: decode(value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch {
      /* invalid position */
    }
  }
  return out;
}
/** A missing/corrupt sidecar is v1; newer formats must never be rewritten. */
export function assertGraphFormat(raw: unknown): void {
  const stamp = Schema.Struct({ version: Schema.Number.check(Schema.isInt()) });
  let version: number;
  try {
    version = Schema.decodeUnknownSync(stamp)(raw).version;
  } catch {
    return;
  }
  if (version > CURRENT_GRAPH_FORMAT_VERSION)
    throw new Error(
      `Graph data format ${version} is newer than supported format ${CURRENT_GRAPH_FORMAT_VERSION}.`,
    );
}
