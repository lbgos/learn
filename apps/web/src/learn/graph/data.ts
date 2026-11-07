import { createContext, useContext } from "react";
import type { LearnReviewSummary } from "@t3tools/contracts";
import type {
  ChatDeleteMode,
  ChatDeletionStats,
  GraphLedgers,
  GraphSnapshot,
} from "@t3tools/learn/graph";

export type GraphEvidence =
  | { sourceId: string; kind: "simulation"; path: string; label: string }
  | { sourceId: string; kind: "whiteboard"; name: string; label: string };

/** The only transport boundary. Supply a subscribed snapshot and environment-scoped actions. */
export interface LearnGraphData {
  snapshot: GraphSnapshot | null;
  loading: boolean;
  error: string | null;
  available: boolean;
  /** Include teach sessions without extracted propositions so Extract now works on an empty graph. */
  sources?: readonly { id: string; label: string }[];
  review: LearnReviewSummary | null;
  saveLayout(positions: GraphLedgers["positions"]): Promise<void>;
  previewDeletion(sourceId: string): Promise<ChatDeletionStats>;
  deleteSource(sourceId: string, mode: ChatDeleteMode): Promise<void>;
  importNotes(file: File): Promise<void>;
  extractNow(sourceId: string): Promise<void>;
  evidence(sourceIds: readonly string[]): Promise<readonly GraphEvidence[]>;
  openSession(sourceId: string): Promise<void>;
  /** Navigate to the source thread, then openSimulation(ref, path) or openWhiteboard(ref, name). */
  openEvidence(evidence: GraphEvidence): Promise<void>;
}

async function unavailable(): Promise<never> {
  throw new Error("Graph connection is not configured.");
}

export const LearnGraphDataContext = createContext<LearnGraphData>({
  snapshot: null,
  loading: false,
  error: "Graph connection is not configured.",
  available: false,
  review: null,
  saveLayout: unavailable,
  previewDeletion: unavailable,
  deleteSource: unavailable,
  importNotes: unavailable,
  extractNow: unavailable,
  evidence: unavailable,
  openSession: unavailable,
  openEvidence: unavailable,
});

export function useLearnGraphData() {
  return useContext(LearnGraphDataContext);
}
