// Ported from learnharness (AGPL-3.0-only) src/core/coverage.ts @ c549494.
import type { CoverageEntry, TeacherProseMessage } from "./model.ts";
export type HashText = (text: string) => string;
export function messageViewLines(message: TeacherProseMessage): string[] {
  return message.text.trim() ? [`TEACHER [${message.id}] ${message.text.trim()}`] : [];
}
export function teacherProseBlocks(messages: ReadonlyArray<TeacherProseMessage>): string[] {
  return messages.map((m) => m.text.trim()).filter(Boolean);
}
function viewTokens(lines: ReadonlyArray<string>): number {
  return Math.ceil(lines.join("\n").length / 4);
}
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
/** Hash exactly the labeled prose passed to extraction. The node entry supplies SHA-256. */
export function messageFingerprint(message: TeacherProseMessage, hash: HashText): string {
  return hash(JSON.stringify(["assistant", messageViewLines(message)]));
}
export interface CoverageSlot {
  message: TeacherProseMessage;
  fp: string;
  tokens: number;
}

export function coverageSlots(
  messages: ReadonlyArray<TeacherProseMessage>,
  hash: HashText,
): CoverageSlot[] {
  return messages.map((message) => ({
    message,
    fp: messageFingerprint(message, hash),
    tokens: viewTokens(messageViewLines(message)),
  }));
}

function coveredSet(entries: ReadonlyArray<CoverageEntry>, chatId: string): Set<string> {
  const out = new Set<string>();
  for (const e of entries) if (e.chatId === chatId) out.add(e.fp);
  return out;
}

export function coverageOf(
  messages: ReadonlyArray<TeacherProseMessage>,
  entries: ReadonlyArray<CoverageEntry>,
  chatId: string,
  hash: HashText,
): {
  slots: CoverageSlot[];
  uncovered: number[];
  coveredTokens: number;
  uncoveredTokens: number;
  coveredCount: number;
  uncoveredCount: number;
} {
  const covered = coveredSet(entries, chatId);
  const slots = coverageSlots(messages, hash);
  const uncovered: number[] = [];
  let coveredTokens = 0;
  let uncoveredTokens = 0;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (messageViewLines(slot.message).length === 0) continue; // invisible
    if (covered.has(slot.fp)) coveredTokens += slot.tokens;
    else {
      uncovered.push(i);
      uncoveredTokens += slot.tokens;
    }
  }
  const visibleCount =
    slots.length - slots.filter((s) => messageViewLines(s.message).length === 0).length;
  return {
    slots,
    uncovered,
    coveredTokens,
    uncoveredTokens,
    coveredCount: visibleCount - uncovered.length,
    uncoveredCount: uncovered.length,
  };
}

export function batchRuns(
  slots: ReadonlyArray<CoverageSlot>,
  uncovered: ReadonlyArray<number>,
  budget: number,
): CoverageSlot[][] {
  if (!Number.isFinite(budget) || budget <= 0 || uncovered.length === 0) return [];
  const runs: CoverageSlot[][] = [];
  let current: CoverageSlot[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (current.length > 0) runs.push(current);
    current = [];
    currentTokens = 0;
  };
  for (const i of uncovered) {
    const slot = slots[i];
    if (slot === undefined || slot.tokens === 0) continue;
    if (current.length > 0 && currentTokens + slot.tokens > budget) flush();
    current.push(slot);
    currentTokens += slot.tokens;
  }
  flush();
  return runs;
}

export function batchTag(batch: ReadonlyArray<CoverageSlot>, hash: HashText): string {
  return hash(batch.map((slot) => slot.fp).join("")).slice(0, 12);
}

/** Preserve line boundaries, including blank lines. Oversize lines ride alone. */
export function chunkNotes(text: string, budget: number): string[] {
  if (!text.trim() || !Number.isFinite(budget) || budget <= 0) return [];
  const chunks: string[] = [];
  let lines: string[] = [];
  for (const line of text.split("\n")) {
    if (lines.length > 0 && estimateTokens([...lines, line].join("\n")) > budget) {
      chunks.push(lines.join("\n"));
      lines = [];
    }
    lines.push(line);
  }
  if (lines.length) chunks.push(lines.join("\n"));
  return chunks;
}
