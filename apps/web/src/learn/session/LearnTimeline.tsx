// Behaviour ported from learnharness (AGPL-3.0-only) components/answered-card.tsx, components/plan-block.tsx, components/phase-divider.tsx, components/graph-context-card.tsx @ c549494.
// Rendered with T3's work-log row, the same one T3 shows for an answered agent question.
import {
  coerceCorrectAnswer,
  derivePlanStatuses,
  deriveSession,
  PARKED_AFTER_PLAN,
  type LearnerAnswer,
  type ParkedQuestion,
  type PendingQuestion,
  type PlanBlock,
  type SessionEvent,
  type ReplayOptions,
} from "@t3tools/learn/session";
import {
  CircleCheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  CircleIcon,
  MessageCircleIcon,
  MessageCircleQuestionIcon,
  NetworkIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { WorkLogBlock, WorkLogDetails, WorkLogRow } from "~/components/chat/WorkLog";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { SessionProse } from "./SessionProse";
import { learnPhase, type LearnTimelineItem, type SessionKind } from "./logic";

export function answerText(answer: LearnerAnswer): string {
  if (typeof answer === "string") return answer;
  if ("value" in answer) return `${answer.value}${answer.unit ? ` ${answer.unit}` : ""}`;
  if ("choices" in answer)
    return [...answer.choices.map((choice) => choice.label), answer.text]
      .filter(Boolean)
      .join(", ");
  return answer.map((option) => option.label).join(", ");
}
export function committedAnswerText(question: PendingQuestion): string {
  if (question.name === "ask") return "";
  if (question.name === "explain") return question.input.correctAnswer;
  const { correctAnswer, answer } = question.input;
  if (typeof correctAnswer === "number")
    return `${correctAnswer}${answer.kind === "number" && answer.unit ? ` ${answer.unit}` : ""}`;
  const keys = coerceCorrectAnswer(
    correctAnswer,
    answer.kind === "choice" ? answer.options.map((option) => option.value.trim()) : [],
  );
  return keys
    .map((key) =>
      answer.kind === "choice"
        ? (answer.options.find((option) => option.value.trim() === key.trim())?.label ?? key)
        : key,
    )
    .join(", ");
}
export const outcomeLabels = {
  solved: "Solved",
  solvedWithHints: "Solved with hints",
  movedOn: "Moved on",
  surrendered: "Surrendered",
  dismissed: "Dismissed",
};
export const verdictLabels = {
  correct: "Correct",
  incorrect: "Incorrect",
  "dont-know": "Didn't know",
  "pending-grade": "Awaiting tutor",
  ungraded: "Answered",
};
export const verdictTones = {
  correct: "text-success-foreground",
  incorrect: "text-error-foreground",
  "dont-know": "text-muted-foreground",
  "pending-grade": "text-muted-foreground",
  ungraded: "",
} satisfies Record<keyof typeof verdictLabels, string>;

/** A collapsed work-log style row that opens to show its details, like T3's answered questions. */
function DisclosureRow({
  label,
  trailing,
  icon,
  defaultOpen = false,
  children,
}: {
  readonly label: ReactNode;
  readonly trailing?: ReactNode;
  readonly icon?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => setOpen((value) => !value);
  return (
    <WorkLogBlock>
      <WorkLogRow
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " "))
            return;
          event.preventDefault();
          toggle();
        }}
        icon={
          <span className="flex size-4 items-center justify-center text-icon-muted">
            {icon ?? <MessageCircleIcon aria-hidden className="size-4 stroke-2" />}
          </span>
        }
        label={label}
        trailing={
          <>
            {trailing}
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              <ChevronRightIcon
                className={cn(
                  "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                  open && "rotate-90",
                )}
              />
            </span>
          </>
        }
      >
        {open ? (
          <WorkLogDetails>
            <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
              {children}
            </div>
          </WorkLogDetails>
        ) : null}
      </WorkLogRow>
    </WorkLogBlock>
  );
}

/** One labelled row of an expanded answer; the label sits beside the value. */
function Detail({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 text-sm leading-6">
      <p className="text-muted-foreground">{title}</p>
      <div className="min-w-0 max-w-[33rem] text-foreground">{children}</div>
    </div>
  );
}

export function LearnTimelineCard({
  item,
  onOpenSimulation,
}: {
  readonly item: LearnTimelineItem;
  readonly onOpenSimulation?: (path: string) => void;
}) {
  if (item.kind === "problem")
    return item.active ? (
      <WorkLogBlock>
        <WorkLogRow
          icon={<MessageCircleIcon aria-hidden className="size-4 stroke-2 text-icon-muted" />}
          label="Problem posed"
        />
      </WorkLogBlock>
    ) : (
      <DisclosureRow label="Problem">
        <SessionProse text={item.statement} />
      </DisclosureRow>
    );
  if (item.kind === "conclusion") {
    return (
      <DisclosureRow label={outcomeLabels[item.input.outcome]} defaultOpen>
        {item.input.outcome === "dismissed" ? (
          <p className="text-sm text-muted-foreground">Problem dismissed.</p>
        ) : (
          <>
            <SessionProse text={item.input.verdict} />
            <Detail title="Solution">
              <SessionProse text={item.solution} />
            </Detail>
          </>
        )}
      </DisclosureRow>
    );
  }
  if (item.kind === "phase") return null;
  if (item.kind === "plan") return <LearnPlanView block={item.block} parked={item.parked} />;
  if (item.kind === "parked" || item.kind === "recalled")
    return (
      <WorkLogBlock>
        <WorkLogRow
          icon={
            <MessageCircleQuestionIcon aria-hidden className="size-4 stroke-2 text-icon-muted" />
          }
          label={
            <span className="flex min-w-0 gap-1.5">
              <span className="shrink-0">
                {item.kind === "recalled"
                  ? "You asked"
                  : `Saved for ${item.step ?? "after the plan"}`}
              </span>
              <span className="min-w-0 truncate text-foreground">
                <SessionProse
                  text={item.kind === "recalled" ? item.question : item.parked.input.question}
                  inline
                />
              </span>
            </span>
          }
        />
      </WorkLogBlock>
    );
  if (item.kind === "graph-context") return <LearnGraphContextCard text={item.text} />;
  const { question, answer } = item;
  const questionLabel = (
    <span className="min-w-0 truncate text-foreground">
      <SessionProse text={question.input.question} inline />
    </span>
  );
  if (!answer)
    return (
      <WorkLogBlock>
        <WorkLogRow
          icon={
            <span className="flex size-4 items-center justify-center text-icon-muted">
              <MessageCircleIcon aria-hidden className="size-4 stroke-2" />
            </span>
          }
          label={questionLabel}
        />
      </WorkLogBlock>
    );
  return (
    <DisclosureRow
      label={
        <span className="flex min-w-0 gap-1.5" aria-label="Answered question">
          {questionLabel}
          <span aria-hidden className="shrink-0 text-muted-foreground">
            →
          </span>
          <span className="min-w-0 max-w-1/2 shrink-0 truncate text-foreground">
            <SessionProse text={answerText(answer.answer)} inline />
          </span>
        </span>
      }
      trailing={
        <span className="shrink-0 text-xs text-muted-foreground">
          <span className={verdictTones[answer.verdict]}>{verdictLabels[answer.verdict]}</span>
          {answer.confidence !== undefined ? ` · ${answer.confidence}%` : ""}
        </span>
      }
    >
      <Detail title="Question">
        <SessionProse text={question.input.question} />
      </Detail>
      <Detail title="You">
        <SessionProse text={answerText(answer.answer)} />
      </Detail>
      {answer.thinkingWhileReading ? (
        <Detail title="Reading">
          <SessionProse text={answer.thinkingWhileReading} />
        </Detail>
      ) : null}
      {answer.thinking ? (
        <Detail title="Thinking">
          <SessionProse text={answer.thinking} />
        </Detail>
      ) : null}
      {question.name !== "ask" ? (
        <Detail title="Solution">
          <SessionProse text={committedAnswerText(question)} />
          {question.name === "quiz" ? <SessionProse text={question.input.explanation} /> : null}
        </Detail>
      ) : null}
      {question.name === "quiz" && question.input.simPath && onOpenSimulation ? (
        <div>
          <Button
            size="compact"
            variant="outline"
            onClick={(event) => {
              event.stopPropagation();
              if (question.input.simPath) onOpenSimulation(question.input.simPath);
            }}
          >
            Open simulation
          </Button>
        </div>
      ) : null}
    </DisclosureRow>
  );
}

function LearnPlanView({
  block,
  parked,
}: {
  readonly block: Pick<PlanBlock, "nodes" | "edges">;
  readonly parked: readonly ParkedQuestion[];
}) {
  const [open, setOpen] = useState(false);
  const visited = block.nodes.filter((node) => node.status === "visited").length;
  const current = block.nodes.find((node) => node.status === "current")?.title ?? "Plan";
  return (
    <div className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-1 text-left"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 text-icon-muted", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">{current}</span>
        <span className="text-xs tabular-nums">
          {visited}/{block.nodes.length}
        </span>
      </button>
      {open ? <LearnPlanList block={block} parked={parked} /> : null}
    </div>
  );
}

/** The learner's parked questions, one dense line each, under the step that answers them. */
function ParkedLines({ parked }: { readonly parked: readonly ParkedQuestion[] }) {
  return parked.map((question) => (
    <span key={question.id} className="mt-0.5 flex gap-1.5 text-xs font-normal text-foreground">
      <span aria-hidden>↳</span>
      <span className="sr-only">Your question: </span>
      <span className="min-w-0">
        <SessionProse text={question.input.question} inline />
      </span>
    </span>
  ));
}

/** The plan in order with the current node marked, as the reader shows it on the run's slide. */
export function LearnPlanList({
  block,
  parked = [],
  className,
}: {
  readonly block: Pick<PlanBlock, "nodes" | "edges">;
  /** Open parked questions; one whose node left the plan shows after it. */
  readonly parked?: readonly ParkedQuestion[];
  readonly className?: string;
}) {
  const visited = block.nodes.filter((node) => node.status === "visited").length;
  const afterPlan = parked.filter(
    (question) =>
      question.input.nodeId === PARKED_AFTER_PLAN ||
      !block.nodes.some((node) => node.id === question.input.nodeId),
  );
  return (
    <section aria-label="Session plan" className={cn("text-sm sm:text-base", className)}>
      <h2 className="mb-2 font-medium">
        Plan <span className="ms-1 text-xs tabular-nums">{`${visited}/${block.nodes.length}`}</span>
      </h2>
      <ol className="space-y-1">
        {block.nodes.map((node, index) => (
          <li
            key={node.id}
            aria-current={node.status === "current" ? "step" : undefined}
            className={cn(
              "grid grid-cols-[1rem_1rem_minmax(0,1fr)] gap-x-2",
              node.status === "current" && "font-medium",
              node.status === "visited" && "text-muted-foreground",
            )}
          >
            <span aria-hidden className="flex h-lh items-center [&>svg]:size-3.5">
              {node.status === "visited" ? (
                <CircleCheckIcon />
              ) : node.status === "current" ? (
                <CircleDotIcon />
              ) : (
                <CircleIcon className="opacity-50" />
              )}
            </span>
            <span className="text-end tabular-nums text-muted-foreground">{index + 1}</span>
            <span>
              {node.status === "visited" ? <span className="sr-only">Done: </span> : null}
              {node.title}
              <PlanParents block={block} index={index} />
              <ParkedLines
                parked={parked.filter((question) => question.input.nodeId === node.id)}
              />
            </span>
          </li>
        ))}
        {afterPlan.length ? (
          <li className="grid grid-cols-[1rem_1rem_minmax(0,1fr)] gap-x-2">
            <span aria-hidden />
            <span aria-hidden />
            <span>
              After the plan
              <ParkedLines parked={afterPlan} />
            </span>
          </li>
        ) : null}
      </ol>
    </section>
  );
}

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Steps this one builds on, by number; a step that only follows the one above shows none. */
function PlanParents({
  block,
  index,
}: {
  readonly block: Pick<PlanBlock, "nodes" | "edges">;
  readonly index: number;
}) {
  const node = block.nodes[index];
  const parents = block.edges
    .filter((edge) => edge.to === node?.id)
    .map((edge) => block.nodes.findIndex((parent) => parent.id === edge.from) + 1)
    .filter((number) => number > 0)
    .toSorted((a, b) => a - b);
  if (parents.length === 0 || (parents.length === 1 && parents[0] === index)) return null;
  return (
    <span className="ms-2 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
      <span aria-hidden>← </span>
      <span className="sr-only">builds on step </span>
      {parents.join(", ")}
    </span>
  );
}

export function LearnPhaseChip({
  events,
  kind,
  state,
  paused,
}: {
  readonly events: readonly SessionEvent[];
  readonly kind: SessionKind;
  readonly state?: ReplayOptions["state"];
  /** The learner paused the session; between practice problems is not a pause. */
  readonly paused: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { plan, parked } = deriveSession(events, { state });
  const derived = learnPhase(events, kind, { state });
  const phase = paused
    ? "Paused"
    : derived === "paused"
      ? "Practice"
      : derived === "problem active"
        ? "Problem"
        : sentenceCase(derived);
  if (!plan || kind === "practice") return <span className="shrink-0 px-2 text-xs">{phase}</span>;
  const statuses = derivePlanStatuses(plan, events, { state });
  const block = {
    edges: plan.edges,
    nodes: plan.nodes.map(
      (node) =>
        ({
          ...node,
          status:
            statuses.current === node.id
              ? "current"
              : statuses.visited.has(node.id)
                ? "visited"
                : "upcoming",
        }) satisfies PlanBlock["nodes"][number],
    ),
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button size="compact" variant="ghost" />}
        aria-label={`${phase}, open plan`}
      >
        <span className="max-sm:hidden">{phase} · </span>Plan
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        width="lg"
        padding="compact"
        collisionPadding={12}
        aria-label="Session plan"
      >
        <LearnPlanList block={block} parked={[...parked.values()]} />
      </PopoverPopup>
    </Popover>
  );
}

function LearnGraphContextCard({ text }: { readonly text: string }) {
  return (
    <DisclosureRow
      icon={<NetworkIcon aria-hidden className="size-4 stroke-2" />}
      label="Graph context"
    >
      <p className="whitespace-pre-wrap text-sm">
        {text.replace(/^\[graph context\]\r?\n?/, "").replace(/\r?\n\[\/graph context\]\s*$/, "")}
      </p>
    </DisclosureRow>
  );
}
