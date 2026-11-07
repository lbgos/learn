import {
  LEARN_ENDPOINTS,
  AuthOrchestrationOperateScope,
  LearnCreateSessionInput,
  ModelSelection,
  ThreadId,
  type EnvironmentId,
  type LearnSessionSummary,
  type LearnSessionState,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { create } from "zustand";
import * as Schema from "effect/Schema";

import { learnRequest } from "./http";

/** Session meta (kind, mechanic) per environment; refreshed on mount and after creation. */
const useSessionsStore = create<{
  readonly byEnvironment: Readonly<Record<string, readonly LearnSessionSummary[]>>;
}>(() => ({ byEnvironment: {} }));

const inflight = new Map<EnvironmentId, Promise<void>>();

export function refreshLearnSessions(environmentId: EnvironmentId): Promise<void> {
  const running = inflight.get(environmentId);
  if (running) return running;
  const request = learnRequest(environmentId, LEARN_ENDPOINTS.listSessions, {})
    .then((sessions) =>
      useSessionsStore.setState((state) => ({
        byEnvironment: { ...state.byEnvironment, [environmentId]: sessions },
      })),
    )
    .catch(() => undefined)
    .finally(() => inflight.delete(environmentId));
  inflight.set(environmentId, request);
  return request;
}

export function useLearnSessions(environmentId: EnvironmentId | null): {
  readonly data: readonly LearnSessionSummary[] | undefined;
} {
  const data = useSessionsStore((state) =>
    environmentId === null ? undefined : state.byEnvironment[environmentId],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loads session metadata from the connected environment.
  useEffect(() => {
    if (environmentId !== null) void refreshLearnSessions(environmentId);
  }, [environmentId]);
  return { data };
}

/** The session meta for one thread; undefined for non-session threads and while loading. */
export function useLearnSession(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): LearnSessionSummary | undefined {
  const { data } = useLearnSessions(environmentId);
  return threadId === null ? undefined : data?.find((session) => session.threadId === threadId);
}

/** Pauses the session on the server, which also stops a running turn; the next message resumes it. */
export async function pauseLearnSession(environmentId: EnvironmentId, threadId: ThreadId) {
  const { pausedAt } = await learnRequest(environmentId, LEARN_ENDPOINTS.pauseSession, {
    threadId,
  });
  useSessionsStore.setState((state) => ({
    byEnvironment: {
      ...state.byEnvironment,
      [environmentId]: (state.byEnvironment[environmentId] ?? []).map((session) =>
        session.threadId === threadId ? { ...session, pausedAt } : session,
      ),
    },
  }));
}

/** First-send metadata preparation; thread creation remains T3's draft bootstrap. */
export async function prepareLearnDraft(
  environmentId: EnvironmentId,
  input: {
    threadId: ThreadId;
    session: LearnCreateSessionInput;
    modelSelection: ModelSelection;
    modelSelectionExplicit?: boolean;
  },
) {
  return learnRequest(
    environmentId,
    {
      path: "/api/learn/sessions/prepare-draft",
      payload: Schema.Struct({
        threadId: ThreadId,
        session: LearnCreateSessionInput,
        modelSelection: ModelSelection,
        modelSelectionExplicit: Schema.optional(Schema.Boolean),
      }),
      success: Schema.Struct({ modelSelection: ModelSelection, contextText: Schema.String }),
      scope: AuthOrchestrationOperateScope,
    },
    input,
  );
}

/** Read-only: resolve the same default used by first-send preparation. */
export function readLearnDraftModel(environmentId: EnvironmentId, kind: "teach" | "practice") {
  return learnRequest(
    environmentId,
    {
      path: "/api/learn/sessions/default-model",
      payload: Schema.Struct({ kind: Schema.Literals(["teach", "practice"]) }),
      success: ModelSelection,
      scope: LEARN_ENDPOINTS.listSessions.scope,
    },
    { kind },
  );
}

/**
 * Loads a compact replay checkpoint for the first loaded item, independent of history length.
 * A refetch for a new revision keeps the loaded state for the same window start, so a live turn
 * does not replay the window from probe while it runs.
 */
export function useLearnSessionState(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  beforeOrdinal: number,
  revision: string,
  enabled: boolean,
) {
  const scope = `${environmentId}:${threadId}:${beforeOrdinal}`;
  const key = `${scope}:${revision}`;
  const [loaded, setLoaded] = useState<{ scope: string; key: string; state: LearnSessionState }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronizes the server's history checkpoint.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void learnRequest(environmentId, LEARN_ENDPOINTS.sessionState, { threadId, beforeOrdinal })
      .then((state) => {
        if (!controller.signal.aborted) setLoaded({ scope, key, state });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [environmentId, threadId, beforeOrdinal, enabled, scope, key]);
  return loaded?.scope === scope ? loaded.state : undefined;
}
