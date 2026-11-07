// Reader mode shows a learn session one slide at a time: each tutor run's prose, then what
// the run asked of the learner, each with the prose written after it. What the run showed
// (HTML explainers, sims, animations, board writes) sits on the slide the learner uses it
// from. Other tool calls stay in the chat view.
import type { RunId } from "@t3tools/contracts";
import type { ParkedQuestion } from "@t3tools/learn/session";
import type { TimelineEntry } from "../../session-logic";
import type { LearnTimelineItem } from "./logic";
import type { LearnPending } from "./pending";

export type LearnSlideItem = Extract<
  LearnTimelineItem,
  { readonly kind: "question" | "problem" | "conclusion" }
>;
type LearnPlanBlock = Extract<LearnTimelineItem, { readonly kind: "plan" }>["block"];
export type LearnSlideMedia = Extract<TimelineEntry, { readonly kind: "physics" | "html-render" }>;
export type LearnSlide =
  | {
      readonly kind: "answer";
      readonly id: string;
      readonly text: string;
      readonly generating: boolean;
      /** The plan the run set or revised, shown above its prose. */
      readonly plan: LearnPlanBlock | null;
      /** The plan's open parked questions. */
      readonly parked: readonly ParkedQuestion[];
      /** Parked questions this run answers, as the learner asked them, shown above its prose. */
      readonly recalled: readonly string[];
      readonly media: readonly LearnSlideMedia[];
    }
  | {
      readonly kind: "learn";
      readonly id: string;
      readonly item: LearnSlideItem;
      /** The run's prose written after the item, shown below it. */
      readonly text: string;
      /** The learner's open question, problem or paused practice; the composer answers it. */
      readonly pending: boolean;
      readonly media: readonly LearnSlideMedia[];
    };

export interface LearnSlides {
  readonly slides: readonly LearnSlide[];
  /** The first slide of the latest run, where the reader lands when it follows the session. */
  readonly landingIndex: number;
}

/** The tool call that owns the learner's pending input. */
export function learnPendingCallId(pending: LearnPending | null): string | null {
  if (!pending) return null;
  if (pending.kind === "question") return pending.question.id;
  if (pending.kind === "problem") return pending.problem.id;
  return pending.conclusionId;
}

interface RunGroup {
  readonly runId: RunId | null;
  /** Prose before the run's first learn item. */
  readonly texts: string[];
  readonly learn: { readonly item: LearnSlideItem; readonly after: string[] }[];
  readonly media: LearnSlideMedia[];
  readonly recalled: string[];
  plan: LearnPlanBlock | null;
  parked: readonly ParkedQuestion[];
  generating: boolean;
}

/**
 * One answer slide per tutor run (its prose and last plan), then its learn slides. Prose keeps its
 * place: what the run wrote after a learn item goes on that item's slide. The run's media
 * goes on its last learn slide, or on the answer slide when it asked nothing. `runningRunId` is the
 * live run, or null before it exists. The pending slide moves to the end so Next reaches it.
 */
export function deriveLearnSlides(
  entries: readonly TimelineEntry[],
  options: {
    readonly working: boolean;
    readonly runningRunId: RunId | null;
    readonly pendingCallId: string | null;
  },
): LearnSlides {
  const groups: RunGroup[] = [];
  const groupFor = (runId: RunId | null) => {
    const last = groups.at(-1);
    if (last && last.runId === runId) return last;
    const group: RunGroup = {
      runId,
      texts: [],
      learn: [],
      media: [],
      recalled: [],
      plan: null,
      parked: [],
      generating: false,
    };
    groups.push(group);
    return group;
  };
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "assistant") {
      const text = entry.message.text.trim();
      if (text) {
        const group = groupFor(entry.message.runId);
        (group.learn.at(-1)?.after ?? group.texts).push(text);
      }
    } else if (entry.kind === "physics" || entry.kind === "html-render") {
      groupFor(entry.runId).media.push(entry);
    } else if (entry.kind === "learn" && entry.learn.kind === "plan") {
      const group = groupFor(entry.runId);
      group.plan = entry.learn.block;
      group.parked = entry.learn.parked;
    } else if (entry.kind === "learn" && entry.learn.kind === "recalled") {
      groupFor(entry.runId).recalled.push(entry.learn.question);
    } else if (
      entry.kind === "learn" &&
      (entry.learn.kind === "question" ||
        entry.learn.kind === "problem" ||
        entry.learn.kind === "conclusion")
    ) {
      groupFor(entry.runId).learn.push({ item: entry.learn, after: [] });
    }
  }
  if (options.working) {
    const last = groups.at(-1);
    if (last && options.runningRunId !== null && last.runId === options.runningRunId)
      last.generating = true;
    else
      groups.push({
        runId: options.runningRunId,
        texts: [],
        learn: [],
        media: [],
        recalled: [],
        plan: null,
        parked: [],
        generating: true,
      });
  }

  const slides: LearnSlide[] = [];
  let landingId: string | null = null;
  groups.forEach((group, index) => {
    const start = slides.length;
    const mediaOnAnswer = group.learn.length === 0 ? group.media : [];
    if (
      group.texts.length > 0 ||
      group.generating ||
      group.plan ||
      group.recalled.length > 0 ||
      mediaOnAnswer.length > 0
    )
      slides.push({
        kind: "answer",
        id: `answer:${group.runId ?? `live:${index}`}`,
        text: group.texts.join("\n\n"),
        generating: group.generating,
        plan: group.plan,
        parked: group.parked,
        recalled: group.recalled,
        media: mediaOnAnswer,
      });
    group.learn.forEach(({ item, after }, position) =>
      slides.push({
        kind: "learn",
        id: item.id,
        item,
        text: after.join("\n\n"),
        pending: item.anchorId === options.pendingCallId,
        media: position === group.learn.length - 1 ? group.media : [],
      }),
    );
    if (slides.length > start) landingId = slides[start]!.id;
  });
  const pendingIndex = slides.findIndex((slide) => slide.kind === "learn" && slide.pending);
  if (pendingIndex >= 0) slides.push(...slides.splice(pendingIndex, 1));
  return {
    slides,
    landingIndex: Math.max(
      0,
      slides.findIndex((slide) => slide.id === landingId),
    ),
  };
}

/**
 * How the composer shows the pending input on slide `index`: only its answer controls on its own
 * slide, held elsewhere so the composer sends plain messages, and in full when no slide owns it.
 */
export function learnReaderPendingInput(
  slides: readonly LearnSlide[],
  index: number,
): "held" | "answer" | undefined {
  if (!slides.some((slide) => slide.kind === "learn" && slide.pending)) return undefined;
  const slide = slides[index];
  return slide?.kind === "learn" && slide.pending ? "answer" : "held";
}

/**
 * What Next does on slide `index`: move to the next slide, or on the last one ask the tutor for
 * its next chunk. Continue waits for an idle tutor and for nothing open for the learner to answer.
 */
export function learnReaderNext(
  slides: readonly LearnSlide[],
  index: number,
  options: { readonly working: boolean; readonly pendingCallId: string | null },
): "next" | "continue" | null {
  if (index < slides.length - 1) return "next";
  return slides.length > 0 && !options.working && options.pendingCallId === null
    ? "continue"
    : null;
}

/** A slide the learner navigated to; it holds until a newer run moves the landing slide. */
export interface LearnSlideSelection {
  readonly id: string;
  readonly landingId: string;
}

export function resolveLearnSlideIndex(
  { slides, landingIndex }: LearnSlides,
  selection: LearnSlideSelection | null,
): number {
  if (!selection || selection.landingId !== slides[landingIndex]?.id) return landingIndex;
  const index = slides.findIndex((slide) => slide.id === selection.id);
  return index >= 0 ? index : landingIndex;
}
