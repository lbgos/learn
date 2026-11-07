import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useConnectedEnvironmentIds } from "../state/environments";
import { readLearnDraftModel } from "./state";
import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { toastManager } from "../components/ui/toast";
import { useLabProjectRef } from "./labProject";

export interface LearnDraftInput {
  kind: "teach" | "practice";
  graphContext?: { nodeIds: readonly string[]; text: string };
}

/** Learn intent stays with T3's draft identity across reload and promotion. */
export const useLearnDraftStore = create(
  persist<{
    drafts: Record<string, LearnDraftInput>;
    preferredKind: "teach" | "practice";
    set: (draftId: DraftId, input: LearnDraftInput) => void;
  }>(
    (set) => ({
      drafts: {},
      preferredKind: "teach",
      set: (draftId, input) =>
        set((state) => ({
          drafts: { ...state.drafts, [draftId]: input },
          preferredKind: input.kind,
        })),
    }),
    { name: "lbgos-learn-drafts" },
  ),
);

export function useStartLearnSession(): (input: {
  kind: "teach" | "practice";
  graphContext?: { nodeIds: readonly string[]; text: string };
}) => void {
  const projectRef = useLabProjectRef();
  const newThread = useNewThreadHandler();
  return useCallback(
    (input: LearnDraftInput) => {
      if (!projectRef) {
        toastManager.add({ type: "error", title: "The learning workspace is still connecting." });
        return;
      }
      void newThread(projectRef, { envMode: "local" })
        .then((draft) => {
          if (draft) useLearnDraftStore.getState().set(draft.draftId, input);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not open the session",
            description: error instanceof Error ? error.message : undefined,
          });
        });
    },
    [newThread, projectRef],
  );
}

/** Seeds native draft defaults; picker writes remain explicit and survive kind changes. */
export function useLearnDraftModel(
  environmentId: EnvironmentId,
  draftId: DraftId | null,
  kind: "teach" | "practice" | undefined,
) {
  const routes = useEnvironmentSettings(environmentId).learn.routes;
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  useEffect(() => {
    if (!connected || !draftId || !kind) return;
    let cancelled = false;
    void readLearnDraftModel(environmentId, kind)
      .then((model) => {
        if (cancelled) return;
        const store = useComposerDraftStore.getState();
        if (store.getComposerDraft(draftId)?.modelSelectionExplicit) return;
        store.setModelSelection(draftId, model, { replaceOptions: true });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          toastManager.add({
            type: "error",
            title: "Learning model unavailable",
            description: error instanceof Error ? error.message : undefined,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [connected, draftId, environmentId, kind, routes]);
}
