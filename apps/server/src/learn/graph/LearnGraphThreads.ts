import {
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { GraphSession, TeacherProseMessage } from "@t3tools/learn/graph";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Workspace from "../../physics/PhysicsWorkspaceService.ts";
import * as Kinds from "./LearnSessionKinds.ts";
import { flushRunIds } from "../memory/contextFlush.ts";
import { LearnGraphError } from "@t3tools/contracts";

const decodeJson = Schema.decodeExit(Schema.fromJsonString(Schema.Unknown));

export interface TeachSource {
  readonly session: GraphSession;
  readonly messages: ReadonlyArray<TeacherProseMessage>;
  readonly sims: ReadonlyArray<string>;
  readonly boards: ReadonlyArray<string>;
}
export class LearnGraphThreads extends Context.Service<
  LearnGraphThreads,
  {
    readonly load: (threadId: ThreadId) => Effect.Effect<TeachSource | undefined, LearnGraphError>;
    readonly events: Stream.Stream<OrchestrationV2DomainEvent, LearnGraphError>;
  }
>()("t3/learn/graph/LearnGraphThreads") {}

/** Full projections contain all message records; bounded visibleTurnItems are not a transcript. */
export function teacherProse(projection: OrchestrationV2ThreadProjection): TeacherProseMessage[] {
  const rolledBack = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const flush = flushRunIds(projection.messages);
  return projection.messages
    .filter(
      (message) =>
        message.threadId === projection.thread.id &&
        (message.runId === null || (!rolledBack.has(message.runId) && !flush.has(message.runId))) &&
        message.role === "assistant" &&
        !message.streaming &&
        !message.senderThreadId &&
        !message.notification &&
        !message.delegatedCompletion &&
        !/^\s*\[answer\b/i.test(message.text) &&
        message.text.trim().length > 0,
    )
    .map((message) => ({ id: message.id, text: message.text }));
}
export function threadEvidence(projection: OrchestrationV2ThreadProjection) {
  const rolledBack = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const sims = new Set<string>();
  const boards = new Set<string>();
  for (const item of projection.turnItems) {
    if (
      item.threadId !== projection.thread.id ||
      (item.runId !== null && rolledBack.has(item.runId)) ||
      item.type !== "dynamic_tool" ||
      item.status !== "completed"
    )
      continue;
    let input: unknown = item.input;
    if (typeof input === "string") {
      const decoded = decodeJson(input);
      if (decoded._tag === "Failure") continue;
      input = decoded.value;
    }
    if (typeof input !== "object" || input === null) continue;
    if (
      /(?:^|__|[.:/])sim_show$/.test(item.toolName ?? "") &&
      "path" in input &&
      typeof input.path === "string"
    )
      sims.add(input.path);
    if (/(?:^|__|[.:/])board_write$/.test(item.toolName ?? "")) {
      boards.add("board" in input && typeof input.board === "string" ? input.board : "main");
    }
  }
  return { sims: [...sims], boards: [...boards] };
}
const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const workspace = yield* Workspace.PhysicsWorkspaceService;
  const kinds = yield* Kinds.LearnSessionKinds;
  const lab = yield* workspace.ensureLab.pipe(
    Effect.mapError(
      (cause) => new LearnGraphError({ operation: "lab", reason: "unavailable", cause }),
    ),
  );
  return LearnGraphThreads.of({
    events: orchestrator.streamDomainEvents.pipe(
      Stream.mapError(
        (cause) => new LearnGraphError({ operation: "events", reason: "unavailable", cause }),
      ),
    ),
    load: Effect.fn("LearnGraphThreads.load")(function* (threadId) {
      if ((yield* kinds.kindOf(threadId)) !== "teach") return undefined;
      const projection = yield* orchestrator
        .getThreadProjection(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new LearnGraphError({ operation: "thread", reason: "unavailable", cause }),
          ),
        );
      if (
        projection.thread.projectId !== lab.projectId ||
        projection.thread.deletedAt !== null ||
        projection.thread.lineage.parentThreadId !== null
      )
        return undefined;
      return {
        session: {
          id: threadId,
          title: projection.thread.title,
          createdAt: DateTime.formatIso(projection.thread.createdAt),
          updatedAt: DateTime.formatIso(projection.thread.updatedAt),
        },
        messages: teacherProse(projection),
        ...threadEvidence(projection),
      };
    }),
  });
});
export const layer = Layer.effect(LearnGraphThreads, make);
