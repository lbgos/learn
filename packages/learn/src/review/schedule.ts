// @effect-diagnostics globalDate:off - ts-fsrs takes and returns Date values.
import { createEmptyCard, fsrs, generatorParameters, Rating, type Grade } from "ts-fsrs";
import type { GraphNode } from "../graph/model.ts";
import type { RetrievalEvent, RetrievalOutcome } from "./retrieval.ts";

// Default FSRS weights at 90% retention. Minute-level learning steps are off: the tutor owns
// in-session retests, and a proposition practised a minute ago should not come due again.
const scheduler = fsrs(generatorParameters({ request_retention: 0.9, enable_short_term: false }));
const DAY_MS = 86_400_000;

const succeeded = (outcome: RetrievalOutcome) =>
  outcome === "correct" || outcome === "solved" || outcome === "solvedWithHints";

/** Wrong is Again; right with hints or below 40 confidence is Hard; otherwise right is Good. */
export function reviewGrade(event: RetrievalEvent): Grade {
  if (!succeeded(event.outcome)) return Rating.Again;
  return event.outcome === "solvedWithHints" ||
    event.rung !== null ||
    (event.confidence ?? 100) < 40
    ? Rating.Hard
    : Rating.Good;
}

/** A miss at confidence 80 or more: a committed wrong model, which tends to return. */
export function isLapse(event: RetrievalEvent): boolean {
  return !succeeded(event.outcome) && (event.confidence ?? 0) >= 80;
}

export interface PropositionReview {
  readonly nodeId: string;
  /** When a teach session first established it; null for propositions only from notes. */
  readonly taughtAt: string | null;
  readonly last: RetrievalEvent | null;
  readonly lapse: boolean;
  /** Null until a teach session or a retrieval schedules it. */
  readonly due: string | null;
}

const time = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * One FSRS card per proposition. A teach exposure counts as a weak first repetition (Hard),
 * so taught material comes due about two days later; every retrieval after it is a review.
 */
export function reviewPropositions(
  nodes: readonly Pick<GraphNode, "id" | "createdAt" | "provenance">[],
  retrievals: readonly RetrievalEvent[],
): Map<string, PropositionReview> {
  const byNode = new Map<string, RetrievalEvent[]>();
  for (const event of retrievals) {
    if (time(event.at) === null) continue;
    const list = byNode.get(event.nodeId) ?? [];
    list.push(event);
    byNode.set(event.nodeId, list);
  }
  const reviews = new Map<string, PropositionReview>();
  for (const node of nodes) {
    const events = (byNode.get(node.id) ?? []).toSorted((a, b) => time(a.at)! - time(b.at)!);
    const firstTeaching = node.provenance
      .filter((point) => !point.chatId.startsWith("notes:"))
      .map((point) => point.at ?? node.createdAt)
      .filter((at) => time(at) !== null)
      .toSorted((a, b) => time(a)! - time(b)!)[0];
    const taughtMs = firstTeaching === undefined ? null : time(firstTeaching);
    const last = events.at(-1) ?? null;
    const firstMs = Math.min(taughtMs ?? Infinity, events[0] ? time(events[0].at)! : Infinity);
    let due: number | null = null;
    if (Number.isFinite(firstMs)) {
      let card = createEmptyCard(new Date(firstMs));
      if (taughtMs !== null) card = scheduler.next(card, new Date(firstMs), Rating.Hard).card;
      for (const event of events)
        card = scheduler.next(card, new Date(time(event.at)!), reviewGrade(event)).card;
      due = card.due.getTime();
      if (last && isLapse(last)) due = Math.min(due, time(last.at)! + DAY_MS);
    }
    reviews.set(node.id, {
      nodeId: node.id,
      taughtAt: firstTeaching ?? null,
      last,
      lapse: last !== null && isLapse(last),
      due: due === null ? null : new Date(due).toISOString(),
    });
  }
  return reviews;
}

/** Due propositions, most overdue first. */
export function dueReviews(
  reviews: Iterable<PropositionReview>,
  nowMs: number,
): readonly PropositionReview[] {
  return [...reviews]
    .filter((review) => review.due !== null && Date.parse(review.due) <= nowMs)
    .toSorted((a, b) => Date.parse(a.due!) - Date.parse(b.due!));
}

const outcomeLabels: Record<RetrievalOutcome, string> = {
  correct: "correct",
  incorrect: "wrong",
  "dont-know": "did not know",
  solved: "solved",
  solvedWithHints: "solved with hints",
  movedOn: "moved on",
  surrendered: "gave up",
};
const day = (iso: string) => new Date(Date.parse(iso)).toISOString().slice(0, 10);

/** One line for the tutor: taught or last retrieval, and when it is due. */
export function reviewStatus(review: PropositionReview | undefined, nowMs: number): string {
  if (!review?.due) return "notes only, never retrieved";
  const due = Date.parse(review.due) <= nowMs ? "due now" : `due ${day(review.due)}`;
  const last = review.last;
  if (!last) return `taught only (${day(review.taughtAt ?? review.due)}); ${due}`;
  const confidence = last.confidence === null ? "" : ` at confidence ${last.confidence}`;
  return `retrieved ${day(last.at)}: ${outcomeLabels[last.outcome]}${confidence}${review.lapse ? " (confident miss)" : ""}; ${due}`;
}
