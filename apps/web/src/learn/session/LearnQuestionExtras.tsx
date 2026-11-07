// What learnharness asks beyond T3's question panel: confidence, "I don't know", thinking notes
// and the practice hint/check/stuck actions. Rendered inside the native panel body.
import { ChevronRightIcon } from "lucide-react";
import { create } from "zustand";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { CONFIDENCE_STOPS, useLearnAnswerExtras } from "./answerExtras";
import type { LearnPending, LearnResponseExtras } from "./pending";

/** ChatView publishes the active learn request and how to answer it; the panel reads it. */
export const useLearnQuestionBridge = create<{
  readonly pending: LearnPending | null;
  readonly act: (extras: LearnResponseExtras, customAnswer: string) => void;
}>(() => ({ pending: null, act: () => {} }));

export function LearnQuestionExtras({
  requestId,
  customAnswer,
  disabled,
  onDismiss,
}: {
  readonly requestId: string;
  readonly customAnswer: string;
  readonly disabled: boolean;
  /** Where the panel has no dismiss button of its own (the reader), a problem offers one here. */
  readonly onDismiss?: () => void;
}) {
  const { pending, act } = useLearnQuestionBridge();
  if (!pending || pending.input.requestId !== requestId) return null;
  if (pending.kind === "paused") return null;
  if (pending.kind === "problem") {
    return (
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          size="compact"
          variant="outline"
          disabled={disabled}
          onClick={() => act({ action: "hint" }, customAnswer)}
        >
          Hint
        </Button>
        <Button
          size="compact"
          variant="outline"
          disabled={disabled || customAnswer.trim() === ""}
          onClick={() => act({ action: "check" }, customAnswer)}
        >
          Check my work
        </Button>
        <Button
          size="compact"
          variant="outline"
          disabled={disabled}
          onClick={() => act({ action: "stuck" }, customAnswer)}
        >
          I'm stuck
        </Button>
        {onDismiss ? (
          <Button size="compact" variant="ghost-muted" disabled={disabled} onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
    );
  }
  // An ask has no right answer: no confidence, thinking or "I don't know".
  if (pending.question.name === "ask") return null;
  return (
    <QuestionExtras
      key={pending.question.id}
      questionId={pending.question.id}
      disabled={disabled}
      onDontKnow={() => act({ dontKnow: true }, customAnswer)}
    />
  );
}

function QuestionExtras({
  questionId,
  disabled,
  onDontKnow,
}: {
  readonly questionId: string;
  readonly disabled: boolean;
  readonly onDontKnow: () => void;
}) {
  const extras = useLearnAnswerExtras((state) => state.byQuestion[questionId]);
  const set = useLearnAnswerExtras((state) => state.set);
  const confidence = extras?.confidence ?? 50;
  const [notesOpen, setNotesOpen] = useState(false);
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-secondary-label text-xs">Confidence</span>
        <ToggleGroup
          variant="default"
          size="compact"
          aria-label="Confidence"
          value={[String(confidence)]}
          disabled={disabled}
          onValueChange={(next) => {
            const value = Number(next[0]);
            if (CONFIDENCE_STOPS.some((stop) => stop === value))
              set(questionId, { confidence: value });
          }}
        >
          {CONFIDENCE_STOPS.map((stop) => (
            <Toggle
              key={stop}
              value={String(stop)}
              variant="segmented"
              aria-label={`${stop}% confident`}
            >
              {stop}%
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <Collapsible open={notesOpen} onOpenChange={setNotesOpen}>
        <CollapsibleTrigger
          render={<Button size="compact" variant="ghost-muted" className="-ms-2" />}
        >
          <ChevronRightIcon aria-hidden className={notesOpen ? "rotate-90" : undefined} />
          {notesOpen ? "Hide your thinking" : "Add your thinking"}
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <div className="mt-1.5 flex flex-col gap-2">
            <Textarea
              size="sm"
              aria-label="Your thinking"
              placeholder="Your thinking"
              value={extras?.thinking ?? ""}
              disabled={disabled}
              onChange={(event) => set(questionId, { thinking: event.target.value })}
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
      <div>
        <Button size="compact" variant="outline" disabled={disabled} onClick={onDontKnow}>
          I don't know
        </Button>
      </div>
    </div>
  );
}
