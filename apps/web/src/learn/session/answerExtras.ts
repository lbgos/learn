import { create } from "zustand";

export interface LearnAnswerExtras {
  readonly confidence: number;
  readonly thinking: string;
  readonly reading: string;
}
export const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100] as const;
const DEFAULTS: LearnAnswerExtras = { confidence: 50, thinking: "", reading: "" };

/** Confidence and thinking notes the native question panel collects, keyed by question id. */
export const useLearnAnswerExtras = create<{
  readonly byQuestion: Readonly<Record<string, LearnAnswerExtras>>;
  readonly get: (questionId: string) => LearnAnswerExtras;
  readonly set: (questionId: string, patch: Partial<LearnAnswerExtras>) => void;
}>((set, get) => ({
  byQuestion: {},
  get: (questionId) => get().byQuestion[questionId] ?? DEFAULTS,
  set: (questionId, patch) =>
    set((state) => ({
      byQuestion: {
        ...state.byQuestion,
        [questionId]: { ...(state.byQuestion[questionId] ?? DEFAULTS), ...patch },
      },
    })),
}));
