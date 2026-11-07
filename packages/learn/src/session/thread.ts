import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { LearnSessionToolEvent } from "../../../contracts/src/learnSession.ts";
import type { SessionEvent } from "./contracts.ts";

type Timestamp = string | DateTime.Utc;
/** Common subset of full, JSON, bounded-client and history-page turn items. */
export interface SessionThreadItem {
  readonly id: string;
  readonly runId?: string | null;
  readonly threadId?: string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status?: string;
  readonly ordinal?: number;
  readonly startedAt?: Timestamp | null;
  /** Absent on bounded-client assistant and reasoning items, which carry no text either. */
  readonly updatedAt?: Timestamp;
  readonly messageId?: string;
  readonly text?: string;
  readonly toolName?: string | null;
  readonly input?: unknown;
  readonly output?: unknown;
}
interface SessionThreadRow {
  readonly position: number;
  readonly visibility: string;
  readonly sourceThreadId: string;
  readonly item: SessionThreadItem;
}
export interface SessionThreadProjection {
  readonly thread?: { readonly id: string };
  readonly runs?: readonly { readonly id: string; readonly status: string }[];
  readonly turnItems?: readonly SessionThreadItem[];
  readonly visibleTurnItems?: readonly SessionThreadRow[];
}
export interface SessionThreadHistory {
  readonly items: readonly SessionThreadRow[];
}

/** A provider tool name that is a session tool, captured bare: `mcp__t3-code__quiz`, `learn.quiz`. */
export const sessionToolNamePattern =
  /(?:^|__|[._:/\s-])(grade_answer|correct_verdict|ask|quiz|explain|probe_done|plan_init|problem|conclude|park_question|answer_parked)$/;
const decodeEvent = Schema.decodeUnknownOption(LearnSessionToolEvent);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Providers wrap MCP results as structuredContent, content text, or a JSON string. */
export function sessionToolEventFromResult(
  value: unknown,
  depth = 0,
): typeof LearnSessionToolEvent.Type | undefined {
  if (depth > 8) return undefined;
  if (typeof value === "string") {
    try {
      return sessionToolEventFromResult(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const found = sessionToolEventFromResult(block, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!record(value) || value.isError === true || value.is_error === true || value.error != null)
    return undefined;
  const decoded = decodeEvent(value.learnSession);
  if (decoded._tag === "Some") return decoded.value;
  for (const key of ["structuredContent", "content", "result", "text"] as const) {
    const found = sessionToolEventFromResult(value[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}
function iso(value: Timestamp): string {
  return typeof value === "string" ? value : DateTime.formatIso(value);
}

/** Map only successful learn results; an in-flight or refused call never changes derived state.
 * Pass loaded history pages as well as the latest bounded projection on clients.
 */
export function sessionEventsFromThread(
  source:
    | SessionThreadProjection
    | { readonly projection: SessionThreadProjection }
    | SessionThreadHistory,
  history: readonly SessionThreadHistory[] = [],
): SessionEvent[] {
  const projection = "projection" in source ? source.projection : "items" in source ? {} : source;
  const threadId = projection.thread?.id;
  const rolledBack = new Set(
    projection.runs?.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const rows = [
    ...history.flatMap((page) => page.items),
    ...("items" in source ? source.items : []),
    ...(projection.visibleTurnItems ?? []),
  ];
  const items = new Map<string, { item: SessionThreadItem; order: number }>();
  for (const row of rows) {
    if (row.visibility !== "local" || (threadId && row.sourceThreadId !== threadId)) continue;
    items.set(row.item.id, { item: row.item, order: row.item.ordinal ?? row.position });
  }
  for (const item of projection.turnItems ?? []) {
    if (threadId && item.threadId && item.threadId !== threadId) continue;
    const previous = items.get(item.id);
    // Full projection values win over wire summaries of the same item.
    items.set(item.id, { item, order: previous?.order ?? item.ordinal ?? items.size });
  }
  const events: SessionEvent[] = [];
  const seen = new Set<string>();
  for (const { item } of [...items.values()].sort((a, b) => a.order - b.order)) {
    if (item.runId && rolledBack.has(item.runId)) continue;
    if (item.type === "user_message" && item.text !== undefined) {
      const at = item.startedAt ?? item.updatedAt;
      if (at === undefined) continue;
      const id = item.messageId ?? item.id;
      if (seen.has(id)) continue;
      seen.add(id);
      events.push({
        type: "learner-message",
        id,
        text: item.text,
        at: iso(at),
      });
      continue;
    }
    if (item.type !== "dynamic_tool" || item.status !== "completed") continue;
    const name = item.toolName && sessionToolNamePattern.exec(item.toolName)?.[1];
    if (!name) continue;
    const event = sessionToolEventFromResult(item.output);
    if (!event || event.name !== name || seen.has(event.id)) continue;
    seen.add(event.id);
    events.push({ type: "tool-call", ...event });
  }
  return events;
}
