import { useSyncExternalStore } from "react";
import {
  applyLedgerPlan,
  emptyGraphLedgers,
  graphSnapshot,
  planSessionDeletion,
  type GraphLedgers,
} from "@t3tools/learn/graph";
import type { LearnReviewSummary } from "@t3tools/contracts";
import type { GraphEvidence, LearnGraphData } from "./data";

const createdAt = "2026-10-25T00:00:00Z";
export function fixtureLedgers(): GraphLedgers {
  return {
    ...emptyGraphLedgers(),
    nodes: [
      {
        id: "n_force",
        name: "Force",
        statement: "A net force changes momentum.",
        aliases: ["net force"],
        createdAt,
        provenance: [{ chatId: "session-mechanics", messageId: "m1" }],
      },
      {
        id: "n_mass",
        name: "Mass",
        statement: "Mass measures inertia.",
        aliases: [],
        createdAt,
        provenance: [{ chatId: "session-mechanics", messageId: "m2" }],
      },
      {
        id: "n_acceleration",
        name: "Acceleration",
        statement: "Newton's law gives $F = ma$.",
        aliases: ["Newton's second law"],
        createdAt,
        provenance: [{ chatId: "session-motion", messageId: "m3" }],
      },
    ],
    chains: [
      {
        id: "arg_newton",
        premises: ["n_force", "n_mass"],
        conclusion: "n_acceleration",
        provenance: [{ chatId: "session-motion", messageId: "m3" }],
        createdAt,
      },
    ],
    positions: {
      n_force: { x: -180, y: -80 },
      n_mass: { x: -180, y: 80 },
      arg_newton: { x: 0, y: 0 },
      n_acceleration: { x: 180, y: 0 },
    },
  };
}

/** In-memory transport for component tests. Extraction/import requests are recorded, not simulated. */
export function createFixtureLearnGraphData(
  initial = fixtureLedgers(),
  review: LearnReviewSummary | null = null,
) {
  let ledgers = initial;
  const sessions = [
    { id: "session-mechanics", title: "Mechanics", createdAt, updatedAt: createdAt },
    { id: "session-motion", title: "Motion", createdAt, updatedAt: createdAt },
  ];
  const artifacts: readonly GraphEvidence[] = [
    {
      sourceId: "session-mechanics",
      kind: "simulation",
      path: "sims/force.html",
      label: "Force simulation",
    },
    { sourceId: "session-mechanics", kind: "whiteboard", name: "Newton", label: "Newton board" },
  ];
  const calls = {
    layouts: new Array<GraphLedgers["positions"]>(),
    previews: new Array<string>(),
    deletions: new Array<{
      sourceId: string;
      mode: Parameters<LearnGraphData["deleteSource"]>[1];
    }>(),
    imports: new Array<File>(),
    extractions: new Array<string>(),
    sessions: new Array<string>(),
    evidence: new Array<GraphEvidence>(),
  };
  const listeners = new Set<() => void>();
  const publish = () => {
    data = {
      ...data,
      snapshot: graphSnapshot(ledgers, sessions),
      sources: sessions.map((session) => ({ id: session.id, label: session.title })),
    };
    for (const listener of listeners) listener();
  };
  let data: LearnGraphData = {
    snapshot: graphSnapshot(ledgers, sessions),
    loading: false,
    error: null,
    available: true,
    review,
    sources: sessions.map((session) => ({ id: session.id, label: session.title })),
    async saveLayout(positions) {
      calls.layouts.push(positions);
      ledgers = { ...ledgers, positions };
      publish();
    },
    async previewDeletion(sourceId) {
      calls.previews.push(sourceId);
      return planSessionDeletion(ledgers, sourceId, "delete-nodes").stats;
    },
    async deleteSource(sourceId, mode) {
      calls.deletions.push({ sourceId, mode });
      ledgers = applyLedgerPlan(ledgers, planSessionDeletion(ledgers, sourceId, mode));
      const index = sessions.findIndex((session) => session.id === sourceId);
      if (index >= 0) sessions.splice(index, 1);
      publish();
    },
    async importNotes(file) {
      calls.imports.push(file);
    },
    async extractNow(sourceId) {
      calls.extractions.push(sourceId);
    },
    async evidence(sourceIds) {
      return artifacts.filter((item) => sourceIds.includes(item.sourceId));
    },
    async openSession(sourceId) {
      calls.sessions.push(sourceId);
    },
    async openEvidence(item) {
      calls.evidence.push(item);
    },
  };
  return {
    calls,
    getSnapshot: () => data,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useFixtureLearnGraphData(fixture: ReturnType<typeof createFixtureLearnGraphData>) {
  return useSyncExternalStore(fixture.subscribe, fixture.getSnapshot, fixture.getSnapshot);
}
