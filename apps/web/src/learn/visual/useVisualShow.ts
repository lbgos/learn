import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import type { PhysicsToolResult } from "~/physics/payloads";
import { useRightPanelStore } from "~/rightPanelStore";
import { useVisualSelection } from "./selection";

/** Observe completed tool results outside virtualized transcript rows. Historical calls don't seek again. */
export function useVisualShow(
  ref: ScopedThreadRef | null,
  entries: readonly {
    readonly id: string;
    readonly kind: string;
    readonly physics?: PhysicsToolResult;
  }[],
  loading: boolean,
) {
  const seen = useRef<{ key: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!ref || loading) return;
    const key = JSON.stringify([ref.environmentId, ref.threadId]);
    const calls = entries.filter(
      (entry) => entry.kind === "physics" && entry.physics?.kind === "visual",
    );
    if (seen.current?.key !== key) {
      seen.current = { key, ids: new Set(calls.map((entry) => entry.id)) };
      return;
    }
    const fresh = calls.filter((entry) => !seen.current?.ids.has(entry.id));
    calls.forEach((entry) => seen.current?.ids.add(entry.id));
    const latest = fresh.at(-1);
    if (latest?.physics?.kind !== "visual") return;
    const { visual } = latest.physics;
    useVisualSelection.getState().select(ref, visual.path, visual.step, latest.id);
    useRightPanelStore.getState().openSimulation(ref, visual.path);
  }, [ref, entries, loading]);
}
