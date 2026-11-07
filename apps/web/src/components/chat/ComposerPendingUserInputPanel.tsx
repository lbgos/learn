import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { memo, use, useEffect, useEffectEvent, useRef, useState } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import { Button } from "../ui/button";
import { CheckboxMark } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import ChatMarkdown from "../ChatMarkdown";
import {
  LearnQuestionExtras,
  useLearnQuestionBridge,
} from "../../learn/session/LearnQuestionExtras";
import { isLearnRequestId } from "../../learn/session/pending";
import { SessionProse } from "../../learn/session/SessionProse";

/** Option text; LaTeX in tutor questions renders, plain labels stay plain. */
function optionText(text: string) {
  return text.includes("$") || text.includes("\\(") || text.includes("\\[") ? (
    <SessionProse text={text} inline />
  ) : (
    text
  );
}

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  /** On the learn reader's question slide, which shows the question and scrolls with the options. */
  inLearnReader?: boolean;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  cwd,
  threadRef,
  disabled = false,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
  inLearnReader = false,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      cwd={cwd}
      threadRef={threadRef}
      disabled={disabled}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
      inLearnReader={inLearnReader}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  cwd,
  threadRef,
  disabled,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
  inLearnReader,
}: {
  prompt: PendingUserInput;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  inLearnReader: boolean;
}) {
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const advance = useStableCallback(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  // Keep question identity stable for its shortcut listener.
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  // Read before later hooks to preserve the question's compiler cache.
  const draftSelectedOptions = activeQuestion?.options.map(
    (option) =>
      !customAnswerActive && progress.selectedOptionValues.includes(option.value ?? option.label),
  );
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;
  // Between practice problems there is nothing to grade: picking "Next problem" sends it.
  const learnBetweenProblems = useLearnQuestionBridge(
    (state) =>
      state.pending?.kind === "paused" && state.pending.input.requestId === prompt.requestId,
  );

  if (
    optimisticSingleSelect &&
    activeQuestion &&
    !activeQuestion.multiSelect &&
    (optimisticSingleSelect.questionId !== activeQuestion.id ||
      (!customAnswerActive &&
        progress.selectedOptionValues.includes(optimisticSingleSelect.optionValue)))
  ) {
    setOptimisticSingleSelect(null);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the auto-advance timer when the question changes, input is disabled, or the panel unmounts
  useEffect(() => {
    const clearAutoAdvance = () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
    };
    if (disabled || activeQuestion?.id === undefined) clearAutoAdvance();
    return clearAutoAdvance;
  }, [activeQuestion?.id, disabled]);

  const handleOptionSelection = (questionId: string, optionValue: string) => {
    if (disabled || isResponding) return;
    // Graded answers commit with Submit, after confidence and thinking are set.
    if (
      activeQuestion?.multiSelect ||
      (isLearnRequestId(prompt.requestId) && !learnBetweenProblems)
    ) {
      onToggleOption(questionId, optionValue);
      return;
    }
    setOptimisticSingleSelect({ questionId, optionValue });
    onToggleOption(questionId, optionValue);
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      advance();
    }, 200);
  };

  const selectOptionFromShortcut = useEffectEvent(handleOptionSelection);
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for digit shortcuts while a question is answerable
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed || backgroundThread) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, backgroundThread, isCollapsed, responseDisabled]);

  if (!activeQuestion) {
    return null;
  }

  // Rows span the header row's width so the radios align with the question text and the shortcut column sits under the dismiss button.
  const optionList = (
    <div className="-ms-2 mt-2 sm:-ms-1.5">
      {activeQuestion.options.map((option, index) => {
        const optionValue = option.value ?? option.label;
        const isOptimisticallySelected =
          optimisticSingleSelect?.questionId === activeQuestion.id &&
          optimisticSingleSelect.optionValue === optionValue;
        const isSelected = isOptimisticallySelected || draftSelectedOptions?.[index] === true;
        const className = cn(
          "group flex w-full items-start gap-2 rounded-md bg-transparent py-2 ps-2 text-left sm:ps-1.5 outline-none transition-colors duration-150 text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          !isSelected && "hover:bg-muted/30",
          (disabled || isResponding) && "opacity-50 cursor-not-allowed",
          !disabled && !isResponding && "cursor-pointer",
        );
        // The h-5 slots match the label's line box, so the indicator and shortcut stay on its first line.
        const content = (
          <>
            <span className="pointer-events-none flex h-5 shrink-0 items-center">
              {activeQuestion.multiSelect ? (
                <CheckboxMark checked={isSelected} />
              ) : (
                <OptionRadio checked={isSelected} />
              )}
            </span>
            <div className="min-w-0 flex-1 flex flex-col gap-1">
              <span className="text-sm font-medium">{optionText(option.label)}</span>
              {option.description && option.description !== option.label ? (
                <span className="text-secondary-label text-xs">
                  {optionText(option.description)}
                </span>
              ) : null}
            </div>
            {index < 9 ? (
              <span className="flex h-5 w-7 shrink-0 items-center justify-center pointer-coarse:hidden sm:w-6">
                <Kbd>{index + 1}</Kbd>
              </span>
            ) : null}
          </>
        );
        return (
          <button
            key={`${activeQuestion.id}:${optionValue}`}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled || isResponding}
            onClick={() => {
              handleOptionSelection(activeQuestion.id, optionValue);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !responseDisabled &&
                isLearnRequestId(prompt.requestId) &&
                isSelected &&
                progress.canAdvance
              ) {
                event.preventDefault();
                onAdvance();
              }
            }}
            className={className}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
  const learnExtras = isLearnRequestId(prompt.requestId) ? (
    <LearnQuestionExtras
      requestId={prompt.requestId}
      customAnswer={answers[activeQuestion.id]?.customAnswer ?? ""}
      disabled={responseDisabled}
      {...(inLearnReader && prompt.dismissible
        ? { onDismiss: () => onDismiss(prompt.requestId) }
        : {})}
    />
  ) : null;
  // The reader's slide already shows the question: options and actions sit on the prose edge.
  // Between problems there is no answer to choose, only the step to take.
  if (inLearnReader)
    return (
      <div>
        {learnBetweenProblems ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {activeQuestion.options.map((option) => (
              <Button
                key={option.value ?? option.label}
                size="sm"
                variant="outline"
                disabled={disabled || isResponding}
                onClick={() =>
                  handleOptionSelection(activeQuestion.id, option.value ?? option.label)
                }
              >
                {optionText(option.label)}
              </Button>
            ))}
          </div>
        ) : (
          optionList
        )}
        {learnExtras}
      </div>
    );

  const card = (
    <Collapsible
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      <CollapsibleTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        title={
          isCollapsed ? "Show the question and its options" : "Hide the question and its options"
        }
        data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
        className="px-4 pt-1.5"
      >
        <ComposerBanner.Content>
          <span className="shrink-0 text-muted-foreground">{activeQuestion.header}</span>
          {isCollapsed ? (
            <>
              <ComposerBanner.Separator />
              <span className="min-w-0 flex-1 truncate text-secondary-label">
                {activeQuestion.question}
              </span>
            </>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="gap-0">
          {prompt.questions.length > 1 ? (
            <ComposerBanner.Count>
              {questionIndex + 1}/{prompt.questions.length}
            </ComposerBanner.Count>
          ) : null}
          <ComposerBanner.ToggleIcon expanded={!isCollapsed} />
          {prompt.dismissible ? (
            <ComposerBanner.Dismiss
              render={<span role="button" tabIndex={0} />}
              aria-label="Dismiss question without answering"
              title="Dismiss question without answering"
              disabled={isResponding}
              data-pending-user-input-dismiss
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
            />
          ) : null}
        </ComposerBanner.Actions>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ComposerBanner.Scroll
          className={isLearnRequestId(prompt.requestId) ? "max-h-[min(16rem,30dvh)]" : undefined}
        >
          <ComposerBanner.Body className="ps-6 pe-4 pb-1 wrap-anywhere sm:ps-5.5">
            {isLearnRequestId(prompt.requestId) ? (
              <div className="pt-2 text-foreground/85">
                <SessionProse text={activeQuestion.question} />
              </div>
            ) : (
              <ChatMarkdown
                text={activeQuestion.question}
                cwd={cwd}
                threadRef={threadRef}
                className="pt-2 text-foreground/85"
              />
            )}
            {optionList}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
        {learnExtras ? (
          <ComposerBanner.Body className="ps-6 pe-4 pb-3 sm:ps-5.5">
            {learnExtras}
          </ComposerBanner.Body>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
  return card;
});

// Drawn with ui/radio-group's look instead of using its Radio: Radio only checks inside a
// RadioGroup, whose arrow keys select options and would trip the single-select auto-advance.
function OptionRadio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/70 bg-background not-dark:bg-clip-padding sm:size-4 dark:bg-input/32",
        checked ? "shadow-none" : "shadow-xs/5",
      )}
    >
      {checked ? (
        <span className="-inset-px absolute flex items-center justify-center rounded-full bg-primary before:size-2 before:rounded-full before:bg-primary-foreground sm:before:size-1.5" />
      ) : null}
    </span>
  );
}
