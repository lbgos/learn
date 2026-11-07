import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

/** A tutor command can seek an already open visual; learner seeks stay local to its host. */
export const useVisualSelection = create<{
  byPath: Record<string, { step: number; command: string }>;
  select: (ref: ScopedThreadRef, path: string, step: number, command: string) => void;
}>((set) => ({
  byPath: {},
  select: (ref, path, step, command) =>
    set((state) => ({
      byPath: { ...state.byPath, [visualSelectionKey(ref, path)]: { step, command } },
    })),
}));
export const visualSelectionKey = (ref: ScopedThreadRef, path: string) =>
  JSON.stringify([ref.environmentId, ref.threadId, path]);
