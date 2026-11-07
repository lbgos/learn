import {
  LEARN_ENDPOINTS,
  type EnvironmentId,
  type LearnActivityEntry,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { learnRequest } from "./http";

const RETRY_MS = 5_000;

/** Running background work (extraction, notes import), long-polled. */
export function useLearnActivity(environmentId: EnvironmentId | null) {
  const [entries, setEntries] = useState<readonly LearnActivityEntry[]>([]);
  useEffect(() => {
    setEntries([]);
    if (environmentId === null) return;
    const controller = new AbortController();
    let known: readonly string[] | undefined;
    const loop = async () => {
      while (!controller.signal.aborted) {
        try {
          const next = await learnRequest(
            environmentId,
            LEARN_ENDPOINTS.activity,
            known === undefined ? {} : { knownIds: [...known] },
            controller.signal,
          );
          known = next.map((entry) => entry.id);
          setEntries(next);
        } catch {
          if (controller.signal.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
    };
    void loop();
    return () => controller.abort();
  }, [environmentId]);
  return entries;
}

export async function stopLearnActivity(environmentId: EnvironmentId, id: string) {
  await learnRequest(environmentId, LEARN_ENDPOINTS.activityStop, { id });
}

export interface LearnExtractionCoverage {
  readonly coveredTokens: number;
  readonly totalTokens: number;
}

/** Token coverage of a teach session's transcript in the graph, read when its menu opens. */
export async function readExtractionCoverage(
  target: ScopedThreadRef,
): Promise<LearnExtractionCoverage | undefined> {
  try {
    const summary = await learnRequest(target.environmentId, LEARN_ENDPOINTS.coverage, {
      threadId: target.threadId,
    });
    return {
      coveredTokens: summary.coveredTokens,
      totalTokens: summary.coveredTokens + summary.uncoveredTokens,
    };
  } catch {
    return undefined;
  }
}

export async function extractToGraph(target: ScopedThreadRef) {
  await learnRequest(target.environmentId, LEARN_ENDPOINTS.extractNow, {
    threadId: target.threadId,
  });
}
