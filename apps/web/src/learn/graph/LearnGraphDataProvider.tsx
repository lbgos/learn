import {
  LEARN_ENDPOINTS,
  ThreadId,
  type EnvironmentId,
  type LearnReviewSummary,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { GraphSnapshot } from "@t3tools/learn/graph";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { learnRequest } from "../http";
import { useLearnSessions } from "../state";
import { LearnGraphDataContext, type GraphEvidence, type LearnGraphData } from "./data";

const RETRY_MS = 5_000;

/** Keeps the graph snapshot current by long-polling the server, so GraphHome re-renders on extraction. */
function useGraphSnapshot(environmentId: EnvironmentId | null) {
  const [state, setState] = useState<{
    snapshot: GraphSnapshot | null;
    error: string | null;
  }>({ snapshot: null, error: null });
  useEffect(() => {
    if (environmentId === null) return;
    const controller = new AbortController();
    let revision: number | undefined;
    const loop = async () => {
      while (!controller.signal.aborted) {
        try {
          const event = await learnRequest(
            environmentId,
            LEARN_ENDPOINTS.graph,
            revision === undefined ? {} : { afterRevision: revision },
            controller.signal,
          );
          if (revision !== event.revision) {
            setState({ snapshot: event.snapshot, error: null });
          } else {
            setState((previous) =>
              previous.error === null ? previous : { ...previous, error: null },
            );
          }
          revision = event.revision;
        } catch (failure) {
          if (controller.signal.aborted) return;
          setState((previous) => ({
            ...previous,
            error: failure instanceof Error ? failure.message : "Graph unavailable.",
          }));
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
    };
    void loop();
    return () => controller.abort();
  }, [environmentId]);
  return state;
}

/** Due propositions and calibration, re-read whenever the graph changes. Failures leave review hidden. */
function useReviewSummary(environmentId: EnvironmentId | null, snapshot: GraphSnapshot | null) {
  const [review, setReview] = useState<LearnReviewSummary | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches server-derived review state for the current graph
  useEffect(() => {
    if (environmentId === null || snapshot === null) return;
    const controller = new AbortController();
    learnRequest(environmentId, LEARN_ENDPOINTS.review, {}, controller.signal).then(
      setReview,
      () => undefined,
    );
    return () => controller.abort();
  }, [environmentId, snapshot]);
  return review;
}

/** Supplies GraphHome with the environment's graph and its actions. */
export function LearnGraphDataProvider({
  environmentId,
  children,
}: {
  environmentId: EnvironmentId | null;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { snapshot, error } = useGraphSnapshot(environmentId);
  const review = useReviewSummary(environmentId, snapshot);
  const sessions = useLearnSessions(environmentId).data;

  const value = useMemo<LearnGraphData>(() => {
    const require = () => {
      if (environmentId === null) throw new Error("Not connected to the environment.");
      return environmentId;
    };
    const openThread = async (threadId: string) => {
      const ref = scopeThreadRef(require(), ThreadId.make(threadId));
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      return ref;
    };
    return {
      snapshot,
      loading: environmentId !== null && snapshot === null && error === null,
      error,
      available: environmentId !== null,
      review,
      sources: (sessions ?? [])
        .filter((session) => session.kind === "teach")
        .map((session) => ({ id: session.threadId, label: session.title })),
      saveLayout: async (positions) => {
        await learnRequest(require(), LEARN_ENDPOINTS.putPositions, { positions });
      },
      previewDeletion: (sourceId) =>
        learnRequest(require(), LEARN_ENDPOINTS.deletionPreview, { sourceId }),
      // Session deletion belongs to the sidebar; this action only removes graph traces.
      deleteSource: async (sourceId, mode) => {
        if (mode === "delete-nodes")
          await learnRequest(require(), LEARN_ENDPOINTS.deleteSource, { sourceId });
      },
      importNotes: async (file) => {
        await learnRequest(require(), LEARN_ENDPOINTS.importNotes, {
          relativePath: file.name,
          content: await file.text(),
        });
      },
      extractNow: async (sourceId) => {
        await learnRequest(require(), LEARN_ENDPOINTS.extractNow, {
          threadId: ThreadId.make(sourceId),
        });
      },
      evidence: async (sourceIds) => {
        const found = await learnRequest(require(), LEARN_ENDPOINTS.evidence, {
          sourceIds: [...sourceIds],
        });
        return found.flatMap((source): GraphEvidence[] => [
          ...source.sims.map((path) => ({
            sourceId: source.threadId,
            kind: "simulation" as const,
            path,
            label: `${source.title}: ${path}`,
          })),
          ...source.boards.map((name) => ({
            sourceId: source.threadId,
            kind: "whiteboard" as const,
            name,
            label: `${source.title}: board ${name}`,
          })),
        ]);
      },
      openSession: async (sourceId) => {
        await openThread(sourceId);
      },
      openEvidence: async (item) => {
        const ref = await openThread(item.sourceId);
        const panels = useRightPanelStore.getState();
        if (item.kind === "simulation") panels.openSimulation(ref, item.path);
        else panels.openWhiteboard(ref, item.name);
      },
    };
  }, [environmentId, error, navigate, review, sessions, snapshot]);

  return <LearnGraphDataContext.Provider value={value}>{children}</LearnGraphDataContext.Provider>;
}
