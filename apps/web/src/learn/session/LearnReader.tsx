// Learn sessions open in reader mode: one slide at a time with the tutor's prose, then the
// question it asked. The composer below stays usable; the chat timeline is one toggle away.
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  GalleryHorizontalEndIcon,
  MessagesSquareIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { use, useEffect, useEffectEvent, useLayoutEffect, useState, type ReactNode } from "react";
import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
import { Button } from "~/components/ui/button";
import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import type { TimelineEntriesInput } from "~/session-logic";
import { useThreadVisibleTurnItems } from "~/state/entities";
import { AssistantReadAloud } from "~/voice/ReadAloudButton";
import {
  answerText,
  committedAnswerText,
  LearnPlanList,
  outcomeLabels,
  verdictLabels,
  verdictTones,
} from "./LearnTimeline";
import { LearnSlideMediaList } from "./LearnSlideMedia";
import type { LearnPending } from "./pending";
import { SessionProse } from "./SessionProse";
import {
  deriveLearnSlides,
  learnPendingCallId,
  learnReaderNext,
  learnReaderPendingInput,
  resolveLearnSlideIndex,
  type LearnSlide,
  type LearnSlideItem,
  type LearnSlideSelection,
} from "./slides";

const LearnSessionView = Schema.Literals(["reader", "chat"]);

/** Reader or chat for learn sessions, remembered per browser. */
export function useLearnSessionView() {
  return useLocalStorage("t3code:learn-session-view", "reader", LearnSessionView);
}

export function LearnViewToggle({
  view,
  onChange,
}: {
  readonly view: typeof LearnSessionView.Type;
  readonly onChange: (view: typeof LearnSessionView.Type) => void;
}) {
  const label = view === "reader" ? "Show chat" : "Show reader";
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={() => onChange(view === "reader" ? "chat" : "reader")}
    >
      {view === "reader" ? (
        <MessagesSquareIcon aria-hidden />
      ) : (
        <GalleryHorizontalEndIcon aria-hidden />
      )}
    </Button>
  );
}

/** Header control: Pause stops a running turn and marks the session paused on the server. */
export function LearnPauseToggle({
  paused,
  onPause,
  onResume,
}: {
  readonly paused: boolean;
  readonly onPause: () => Promise<void>;
  readonly onResume: () => void;
}) {
  const [pausing, setPausing] = useState(false);
  const label = paused ? "Resume" : "Pause";
  return (
    <Button
      size={paused ? "sm" : "icon-sm"}
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={pausing}
      onClick={() => {
        if (paused) return onResume();
        setPausing(true);
        void onPause().finally(() => setPausing(false));
      }}
    >
      {paused ? (
        <>
          <PlayIcon aria-hidden />
          {/* The phone header has no room beside the title. */}
          <span className="max-sm:sr-only">Resume</span>
        </>
      ) : (
        <PauseIcon aria-hidden />
      )}
    </Button>
  );
}

const READER_PROSE = "text-base leading-7 [&_p+p]:mt-4 [&_table]:w-full";
const READER_FIELDS = "grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm leading-6";
const READER_TOP_INSET =
  "calc(var(--workspace-topbar-height) - var(--workspace-titlebar-scroll-fade-height))";
/** The tutor gives its next chunk when the learner sends this. */
const CONTINUE_MESSAGE = "Continue";
/** Sent by Resume; the server tells the tutor how long the break was. */
export const RESUME_MESSAGE = "Resume";
const GENERATING = [..."Generating"];
/** Arrow keys stay with controls that use them. */
const ARROW_KEY_OWNERS =
  '[data-chat-composer-form], [data-learn-question-panel], [contenteditable]:not([contenteditable="false"]), input, textarea, select, [role="slider"], [role="menu"], [role="listbox"], [role="tablist"], [role="dialog"]';

export function LearnReader({
  threadDetailRef,
  entriesInput,
  activeThreadKey,
  working,
  runningRunId,
  latestRunId,
  latestRunSettled,
  paused,
  pending,
  bottomInset,
  onPendingInputChange,
  questionSlotRef,
  onOpenSimulation,
  onSendMessage,
  banner,
}: {
  readonly threadDetailRef: ScopedThreadRef | null;
  readonly entriesInput: Omit<TimelineEntriesInput, "visibleTurnItems">;
  readonly activeThreadKey: string | null;
  readonly working: boolean;
  readonly runningRunId: RunId | null;
  readonly latestRunId: RunId | null;
  readonly latestRunSettled: boolean;
  /** The session is paused: the reader shows only Resume until the next message. */
  readonly paused: boolean;
  readonly pending: LearnPending | null;
  /** Height of the composer overlay drawn over the bottom of the conversation area. */
  readonly bottomInset: number;
  readonly onPendingInputChange: (mode: ReturnType<typeof learnReaderPendingInput>) => void;
  /** Where the composer renders the answer controls when the slide shows the open question. */
  readonly questionSlotRef: (element: HTMLElement | null) => void;
  readonly onOpenSimulation: (path: string) => void;
  readonly onSendMessage: (text: string) => Promise<void>;
  /** Thread error and provider status banners, above the slide so they never cover it. */
  readonly banner?: ReactNode;
}) {
  // Live turn items, like ThreadTimeline, so streamed prose reaches the slide.
  const visibleTurnItems = useThreadVisibleTurnItems(threadDetailRef);
  const entries = useIncrementalTimelineEntries(activeThreadKey, {
    ...entriesInput,
    visibleTurnItems,
  });
  // A sent Continue or Resume shows Generating until the server starts its run.
  const [continued, setContinued] = useState<{ readonly from: RunId | null } | null>(null);
  const busy = working || continued?.from === latestRunId;
  const showPaused = paused && continued?.from !== latestRunId;
  const pendingCallId = learnPendingCallId(pending);
  // A run that has finished its work but not settled has no active run id; it is still the live
  // run, so its slide keeps generating instead of a new one appearing for a frame.
  const liveRunId = runningRunId ?? (latestRunSettled ? null : latestRunId);
  const deck = deriveLearnSlides(entries, {
    working: busy,
    runningRunId: liveRunId,
    pendingCallId,
  });
  const [selection, setSelection] = useState<LearnSlideSelection | null>(null);
  const index = resolveLearnSlideIndex(deck, selection);
  const slide = deck.slides[index];
  const count = deck.slides.length;
  const go = (target: number) => {
    const next = deck.slides[target];
    const landing = deck.slides[deck.landingIndex];
    if (next && landing) setSelection({ id: next.id, landingId: landing.id });
  };
  const readerNext = learnReaderNext(deck.slides, index, { working: busy, pendingCallId });
  // Paused, the learner pages through slides; where Continue would be, Resume restarts the tutor.
  const nextAction = showPaused && readerNext === "continue" ? "resume" : readerNext;
  const send = (text: string) => {
    setContinued({ from: latestRunId });
    onSendMessage(text).catch(() => setContinued(null));
  };
  const advance = () => {
    if (nextAction === "next") go(index + 1);
    else if (nextAction === "continue") send(CONTINUE_MESSAGE);
    else if (nextAction === "resume") send(RESUME_MESSAGE);
  };
  const slidePendingInput = learnReaderPendingInput(deck.slides, index);
  // While paused an open question waits in the deck; the composer stays a plain message box.
  const pendingInput = showPaused && slidePendingInput ? "held" : slidePendingInput;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the slide's pending-input mode to the composer before paint, so an unread question never flashes
  useLayoutEffect(() => {
    onPendingInputChange(pendingInput);
  }, [pendingInput, onPendingInputChange]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives the composer its full question panel back when the reader closes
  useLayoutEffect(() => () => onPendingInputChange(undefined), [onPendingInputChange]);

  const step = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") go(index - 1);
    // A held arrow pages through the slides but never sends Continue.
    else if (!event.repeat || nextAction === "next") advance();
  });
  const backgroundThread = use(BackgroundThreadContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for slide navigation
  useEffect(() => {
    if (backgroundThread) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      // An empty composer, focused on open, lends the arrows to the slides.
      const emptyComposer =
        target?.closest('[data-chat-composer-form] [contenteditable="true"]')?.textContent === "";
      if (!emptyComposer && target?.closest(ARROW_KEY_OWNERS)) return;
      event.preventDefault();
      step(event);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [backgroundThread]);

  return (
    // The thread header floats over the reader's top. The scroller starts one fade height above
    // its bottom edge, so text rests under the controls and fades out before reaching the title.
    // The lane insets keep the slide over the composer when a preview sits beside the chat.
    <div
      className="flex min-h-0 flex-1 flex-col ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end) [--workspace-titlebar-scroll-fade-height:1rem]"
      style={{ paddingTop: READER_TOP_INSET, paddingBottom: bottomInset }}
    >
      {banner}
      {/* Keyed by position: the live slide's id changes once its run starts; it must not re-enter. */}
      <div
        key={index}
        data-learn-slide={slide?.kind === "learn" ? slide.item.kind : slide?.kind}
        className="learn-slide-in learn-slide-fade flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain scrollbar-gutter-both"
      >
        {/* Every block stops at one 33rem edge, about 70 characters of prose a line. */}
        <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-1 flex-col px-5 pt-(--workspace-titlebar-scroll-fade-height) pb-6 sm:px-6 [&>*]:max-w-[33rem]">
          {slide ? (
            <SlideBody
              slide={slide}
              threadRef={threadDetailRef}
              onOpenSimulation={onOpenSimulation}
            />
          ) : null}
          {/* Inside the slide, so leaving it stops playback; auto mode reads a run that finishes here. */}
          {slide?.kind === "answer" ? (
            <div className="mt-6 empty:hidden">
              <AssistantReadAloud
                key={slide.id}
                markdown={slide.text}
                streaming={slide.generating}
                environmentId={threadDetailRef?.environmentId}
              />
            </div>
          ) : null}
          {slide?.kind === "learn" && slide.text ? (
            <SessionProse text={slide.text} className={cn("mt-8", READER_PROSE)} />
          ) : null}
          {pendingInput === "answer" ? (
            <div ref={questionSlotRef} data-learn-question-panel className="mt-6" />
          ) : null}
        </div>
      </div>
      {count > 1 || nextAction === "continue" || nextAction === "resume" ? (
        <nav
          aria-label="Slides"
          className="mx-auto grid w-full max-w-(--chat-content-max-width) grid-cols-[1fr_auto_1fr] items-center px-3 py-1 [&>:first-child]:justify-self-start [&>:last-child]:justify-self-end"
        >
          <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => go(index - 1)}>
            <ChevronLeftIcon aria-hidden />
            Back
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {index + 1}/{count}
          </span>
          <Button variant="ghost" size="sm" disabled={nextAction === null} onClick={advance}>
            {nextAction === "continue" ? "Continue" : nextAction === "resume" ? "Resume" : "Next"}
            <ChevronRightIcon aria-hidden />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function SlideBody({
  slide,
  threadRef,
  onOpenSimulation,
}: {
  readonly slide: LearnSlide;
  readonly threadRef: ScopedThreadRef | null;
  readonly onOpenSimulation: (path: string) => void;
}) {
  const media = <LearnSlideMediaList media={slide.media} threadRef={threadRef} />;
  if (slide.kind === "answer") {
    if (!slide.text && !slide.plan && slide.recalled.length === 0 && slide.media.length === 0)
      return (
        <Generating className="my-auto self-center pb-16 text-lg font-medium text-foreground" />
      );
    return (
      <div className="space-y-8">
        {slide.plan ? <LearnPlanList block={slide.plan} parked={slide.parked} /> : null}
        {slide.recalled.length ? (
          <dl className={READER_FIELDS}>
            {slide.recalled.map((question, position) => (
              // oxlint-disable-next-line react/no-array-index-key -- a run's recalled questions never reorder
              <Field key={position} label="You asked">
                <SessionProse text={question} />
              </Field>
            ))}
          </dl>
        ) : null}
        {slide.text ? (
          <SessionProse text={slide.text} streaming={slide.generating} className={READER_PROSE} />
        ) : null}
        {media}
        {slide.generating ? <Generating className="text-sm text-muted-foreground" /> : null}
      </div>
    );
  }
  const { item } = slide;
  if (item.kind === "problem")
    return (
      <div className="space-y-8">
        <SessionProse text={item.statement} className={READER_PROSE} />
        {media}
      </div>
    );
  if (item.kind === "conclusion") return <ConclusionSlide item={item} />;
  return <QuestionSlide item={item} media={media} onOpenSimulation={onOpenSimulation} />;
}

/** Letters rise in once, then the word holds still; streamed text carries the motion after. */
function Generating({ className }: { readonly className: string }) {
  return (
    <div role="status" aria-label="Generating" className={cn("flex w-fit flex-col", className)}>
      <span aria-hidden>
        {GENERATING.map((letter, index) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- a fixed word; letters never reorder
            key={index}
            className="learn-generating-letter"
            style={{ animationDelay: `${index * 55}ms` }}
          >
            {letter}
          </span>
        ))}
      </span>
      <span
        aria-hidden
        className="learn-generating-rule mt-1.5 h-px w-full bg-current opacity-40"
      />
    </div>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function QuestionSlide({
  item,
  media,
  onOpenSimulation,
}: {
  readonly item: Extract<LearnSlideItem, { readonly kind: "question" }>;
  /** What the question's run showed, for the learner to use while answering. */
  readonly media: ReactNode;
  readonly onOpenSimulation: (path: string) => void;
}) {
  const { question, answer } = item;
  const simPath = question.name === "quiz" ? question.input.simPath : undefined;
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <SessionProse text={question.input.question} className={READER_PROSE} />
        {question.name === "ask" && question.input.details ? (
          <SessionProse text={question.input.details} className={READER_PROSE} />
        ) : null}
      </div>
      {media}
      {answer ? (
        <dl className={READER_FIELDS}>
          <Field label="You">
            <SessionProse text={answerText(answer.answer)} />
          </Field>
          <Field label="Verdict">
            <span className={verdictTones[answer.verdict]}>{verdictLabels[answer.verdict]}</span>
            {answer.confidence !== undefined ? (
              <span className="text-muted-foreground"> · {answer.confidence}%</span>
            ) : null}
          </Field>
          {answer.verdictReason ? (
            <Field label="Reason">
              <SessionProse text={answer.verdictReason} />
            </Field>
          ) : null}
          {answer.thinkingWhileReading ? (
            <Field label="Reading">
              <SessionProse text={answer.thinkingWhileReading} />
            </Field>
          ) : null}
          {answer.thinking ? (
            <Field label="Thinking">
              <SessionProse text={answer.thinking} />
            </Field>
          ) : null}
          {question.name !== "ask" ? (
            <Field label="Solution">
              <div className="space-y-2">
                <SessionProse text={committedAnswerText(question)} />
                {question.name === "quiz" ? (
                  <SessionProse text={question.input.explanation} />
                ) : null}
              </div>
            </Field>
          ) : null}
        </dl>
      ) : null}
      {answer && simPath ? (
        <Button size="sm" variant="ghost" onClick={() => onOpenSimulation(simPath)}>
          Open simulation
        </Button>
      ) : null}
    </div>
  );
}

function ConclusionSlide({
  item,
}: {
  readonly item: Extract<LearnSlideItem, { readonly kind: "conclusion" }>;
}) {
  return (
    <div className="space-y-6">
      <p className="text-lg font-medium">{outcomeLabels[item.input.outcome]}</p>
      {item.input.outcome === "dismissed" ? null : (
        <>
          <SessionProse text={item.input.verdict} className={READER_PROSE} />
          <dl className={READER_FIELDS}>
            <Field label="Solution">
              <SessionProse text={item.solution} />
            </Field>
          </dl>
        </>
      )}
    </div>
  );
}
