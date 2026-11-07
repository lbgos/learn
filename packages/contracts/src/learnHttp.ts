import * as Schema from "effect/Schema";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
} from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  LearnActivityList,
  LearnGraphCoverage,
  LearnGraphDeletionCounts,
  LearnGraphEvent,
  LearnGraphEvidence,
  LearnGraphExtractionResult,
  LearnGraphPositions,
  LearnReviewSummary,
} from "./learnGraph.ts";
import { LearnCreateSessionInput, LearnSessionSummary, LearnSessionState } from "./learnSession.ts";

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Any failure, including auth: a status code and this body. */
export const LearnErrorResponse = Schema.Struct({
  error: Schema.Struct({ message: Schema.String }),
});

const endpoint = <P extends Schema.Top, S extends Schema.Top>(
  name: string,
  payload: P,
  success: S,
  scope:
    | typeof AuthFilesystemReadScope
    | typeof AuthFilesystemWriteScope
    | typeof AuthOrchestrationOperateScope,
) => ({ path: `/api/learn/${name}` as const, payload, success, scope });
const source = Schema.Struct({ sourceId: TrimmedNonEmptyString });
const thread = Schema.Struct({ threadId: ThreadId });

/**
 * HTTP avoids the WebSocket RPC group's TypeScript instantiation limit (TS2589).
 * POST returns JSON success or LearnErrorResponse; graph/activity long-poll for changes.
 */
export const LEARN_ENDPOINTS = {
  createSession: endpoint(
    "sessions/create",
    LearnCreateSessionInput,
    Schema.Struct({ threadId: ThreadId }),
    AuthOrchestrationOperateScope,
  ),
  /** Stops a running tutor turn and marks the session paused; no model call. */
  pauseSession: endpoint(
    "sessions/pause",
    thread,
    Schema.Struct({ pausedAt: TrimmedNonEmptyString }),
    AuthOrchestrationOperateScope,
  ),
  sessionState: endpoint(
    "sessions/state",
    Schema.Struct({ threadId: ThreadId, beforeOrdinal: count }),
    LearnSessionState,
    AuthFilesystemReadScope,
  ),
  listSessions: endpoint(
    "sessions",
    Schema.Struct({}),
    Schema.Array(LearnSessionSummary),
    AuthFilesystemReadScope,
  ),
  graph: endpoint(
    "graph",
    Schema.Struct({ afterRevision: Schema.optional(count) }),
    LearnGraphEvent,
    AuthFilesystemReadScope,
  ),
  evidence: endpoint(
    "graph/evidence",
    Schema.Struct({ sourceIds: Schema.Array(TrimmedNonEmptyString) }),
    Schema.Array(LearnGraphEvidence),
    AuthFilesystemReadScope,
  ),
  deletionPreview: endpoint(
    "graph/deletion-preview",
    source,
    LearnGraphDeletionCounts,
    AuthFilesystemReadScope,
  ),
  deleteSource: endpoint(
    "graph/delete-source",
    source,
    LearnGraphDeletionCounts,
    AuthFilesystemWriteScope,
  ),
  importNotes: endpoint(
    "graph/import-notes",
    Schema.Struct({ relativePath: Schema.String, content: Schema.String }),
    LearnGraphExtractionResult,
    AuthOrchestrationOperateScope,
  ),
  extractNow: endpoint(
    "graph/extract-now",
    thread,
    LearnGraphExtractionResult,
    AuthOrchestrationOperateScope,
  ),
  coverage: endpoint("graph/coverage", thread, LearnGraphCoverage, AuthFilesystemReadScope),
  review: endpoint("graph/review", Schema.Struct({}), LearnReviewSummary, AuthFilesystemReadScope),
  putPositions: endpoint(
    "graph/positions",
    Schema.Struct({ positions: LearnGraphPositions }),
    Schema.Struct({}),
    AuthFilesystemWriteScope,
  ),
  activity: endpoint(
    "activity",
    Schema.Struct({ knownIds: Schema.optional(Schema.Array(Schema.String)) }),
    LearnActivityList,
    AuthFilesystemReadScope,
  ),
  activityStop: endpoint(
    "activity/stop",
    Schema.Struct({ id: Schema.String }),
    Schema.Struct({ stopped: Schema.Boolean }),
    AuthOrchestrationOperateScope,
  ),
};
export type LearnEndpoint = (typeof LEARN_ENDPOINTS)[keyof typeof LEARN_ENDPOINTS];
export const LEARN_LONG_POLL_SECONDS = 25;
