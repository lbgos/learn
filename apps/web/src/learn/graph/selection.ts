// Ported from learnharness (AGPL-3.0-only) components/chain-table.tsx @ c549494.
import { chainsForSelection, type GraphSnapshot } from "@t3tools/learn/graph";
import { create } from "zustand";

/** Implication junctions select their propositions; session context never contains synthetic nodes. */
export function propositionIds(snapshot: GraphSnapshot, ids: Iterable<string>) {
  const selected = new Set(ids);
  for (const chain of snapshot.chains) {
    if (!selected.has(chain.id)) continue;
    for (const id of [...chain.premises, chain.conclusion]) selected.add(id);
  }
  return snapshot.propositions.filter((node) => selected.has(node.id)).map((node) => node.id);
}

export function selectionContext(snapshot: GraphSnapshot, ids: Iterable<string>) {
  const selected = new Set(propositionIds(snapshot, ids));
  const nodes = snapshot.propositions.filter((node) => selected.has(node.id));
  const line = (text: string) => text.replace(/\s+/g, " ").trim();
  const lines = nodes.map((node) => `${node.id}: ${line(node.name)}: ${line(node.statement)}`);
  for (const chain of chainsForSelection(nodes, snapshot.chains)) {
    if (chain.premises.length === 0) continue;
    lines.push(`${chain.id}: ${chain.premises.join(" ∧ ")} → ${chain.conclusion}`);
  }
  return ["[graph context]", ...lines].join("\n");
}

interface GraphSelectionState {
  current: { nodeIds: readonly string[]; contextText: string };
  set(nodeIds: readonly string[], contextText: string): void;
  clear(): void;
}

/** The chain table's picked propositions, shared with the home composer. */
export const useGraphSelectionStore = create<GraphSelectionState>((set) => ({
  current: { nodeIds: [], contextText: "" },
  set: (nodeIds, contextText) => set({ current: { nodeIds, contextText } }),
  clear: () => set({ current: { nodeIds: [], contextText: "" } }),
}));

/** The graph's current selection: ids plus the `[graph context]` block a new session carries. */
export function useGraphSelection(): { nodeIds: readonly string[]; contextText: string } {
  return useGraphSelectionStore((state) => state.current);
}
