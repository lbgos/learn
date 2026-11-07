import { describe, expect, it } from "vite-plus/test";
import { Rating } from "ts-fsrs";
import { getGraph } from "../graph/derive.ts";
import { node } from "../graph/test-fixtures.ts";
import {
  buildAnswer,
  formatAnswerMessage,
  type ConcludeInput,
  type QuizInput,
  type SessionEvent,
} from "../session/index.ts";
import { practice, problem, quiz, teach } from "../session/fixtures.test-utils.ts";
import {
  calibration,
  dueReviews,
  learnerRecord,
  reviewGrade,
  reviewPropositions,
  reviewStatus,
  type RetrievalEvent,
} from "./index.ts";

const at = (minute: number) => `2026-11-02T12:${String(minute).padStart(2, "0")}:00.000Z`;
const call = (id: string, name: string, input: unknown, minute: number): SessionEvent => ({
  type: "tool-call",
  id,
  name,
  input,
  at: at(minute),
});
const answer = (
  id: string,
  input: QuizInput,
  request: Parameters<typeof buildAnswer>[2],
  minute: number,
): SessionEvent => ({
  type: "learner-message",
  id: `m-${id}-${minute}`,
  text: formatAnswerMessage(buildAnswer(id, { kind: "quiz", input }, request)),
  at: at(minute),
});
const conclude = (outcome: ConcludeInput["outcome"], rung: ConcludeInput["rung"] = null) => ({
  outcome,
  verdict: "Checked against the model solution.",
  rung,
  missClass: outcome === "solved" ? null : "execution",
  retest: false,
});

describe("learner record", () => {
  it("pairs targeted problems with their conclusion and skips dismissals", () => {
    const record = learnerRecord(
      [
        call("p1", "problem", { ...problem, target: ["n_a", "n_b", "n_a"] }, 0),
        call("c1", "conclude", conclude("solvedWithHints", "R2"), 5),
        call("p2", "problem", { ...problem, target: ["n_a"] }, 6),
        call("c2", "conclude", conclude("dismissed"), 7),
        call("p3", "problem", { ...problem, target: undefined }, 8),
        call("c3", "conclude", conclude("solved"), 9),
      ],
      { meta: practice },
    );
    expect(record.retrievals).toEqual(
      ["n_a", "n_b"].map((nodeId) => ({
        nodeId,
        at: at(5),
        outcome: "solvedWithHints",
        rung: "R2",
        missClass: "execution",
        confidence: null,
      })),
    );
    expect(record.answers).toEqual([]);
  });

  it("counts targeted graded answers as retrievals and every graded quiz for calibration", () => {
    const record = learnerRecord(
      [
        call("w1", "quiz", { ...quiz, target: ["n_a", "n_a"] }, 0),
        answer("w1", quiz, { values: ["4"], confidence: 30 }, 1),
        call("w2", "quiz", { ...quiz, target: ["n_b"] }, 2),
        answer("w2", quiz, { dontKnow: true }, 3),
        call("q3", "quiz", quiz, 4),
        answer("q3", quiz, { values: ["5"], confidence: 90 }, 5),
        answer("q3", quiz, { values: ["4"], confidence: 90 }, 6),
        call("x4", "explain", { question: "Why?", correctAnswer: "Pairs.", target: ["n_c"] }, 7),
        {
          type: "learner-message",
          id: "m-x4",
          text: formatAnswerMessage(
            buildAnswer(
              "x4",
              { kind: "explain", input: { question: "Why?", correctAnswer: "Pairs." } },
              { text: "pairs", confidence: 80 },
            ),
          ),
          at: at(8),
        },
        call(
          "grade-x4",
          "grade_answer",
          { questionId: "x4", verdict: "incorrect", reason: "Check the pairing." },
          9,
        ),
        call(
          "fix-x4",
          "correct_verdict",
          {
            questionId: "x4",
            verdict: "correct",
            reason: "The explanation identifies both pairs.",
          },
          10,
        ),
        call(
          "fix-q3",
          "correct_verdict",
          {
            questionId: "q3",
            verdict: "correct",
            reason: "The learner's reasoning establishes four.",
          },
          11,
        ),
      ],
      { meta: teach },
    );
    expect(
      record.retrievals.map(({ nodeId, outcome, confidence }) => [nodeId, outcome, confidence]),
    ).toEqual([
      ["n_a", "correct", 30],
      ["n_b", "dont-know", null],
      ["n_c", "correct", 80],
    ]);
    expect(record.answers).toEqual([
      { at: at(1), confidence: 30, correct: true },
      { at: at(5), confidence: 90, correct: true },
      { at: at(8), confidence: 80, correct: true },
    ]);
  });
});

describe("spaced review", () => {
  const event = (overrides: Partial<RetrievalEvent>): RetrievalEvent => ({
    nodeId: "n_a",
    at: at(0),
    outcome: "correct",
    rung: null,
    missClass: null,
    confidence: 70,
    ...overrides,
  });

  it.each([
    [{ outcome: "incorrect" }, Rating.Again],
    [{ outcome: "dont-know", confidence: null }, Rating.Again],
    [{ outcome: "surrendered", confidence: null }, Rating.Again],
    [{ outcome: "correct", confidence: 30 }, Rating.Hard],
    [{ outcome: "solvedWithHints", confidence: null }, Rating.Hard],
    [{ outcome: "solved", rung: "R1", confidence: null }, Rating.Hard],
    [{ outcome: "solved", confidence: null }, Rating.Good],
    [{ outcome: "correct", confidence: 40 }, Rating.Good],
  ] as const)("grades %o as %i", (overrides, grade) => {
    expect(reviewGrade(event(overrides))).toBe(grade);
  });

  it("schedules taught propositions, pushes clean retrievals out and pulls confident misses in", () => {
    const taught = node("n_a", "thread-1", { createdAt: "2026-11-01T10:00:00.000Z" });
    const notes = node("n_b", "notes:physics.md", { createdAt: "2026-11-01T10:00:00.000Z" });
    const now = Date.parse("2026-11-05T00:00:00.000Z");
    const first = reviewPropositions([taught, notes], []);
    expect(first.get("n_b")?.due).toBeNull();
    const firstDue = Date.parse(first.get("n_a")!.due!);
    expect(firstDue - Date.parse(taught.createdAt)).toBeGreaterThanOrEqual(86_400_000);
    expect(reviewStatus(first.get("n_a"), now)).toBe("taught only (2026-11-01); due now");
    expect(dueReviews(first.values(), now).map((review) => review.nodeId)).toEqual(["n_a"]);

    const recalled = reviewPropositions(
      [taught],
      [event({ at: "2026-11-03T10:00:00.000Z", outcome: "correct", confidence: 90 })],
    ).get("n_a")!;
    expect(Date.parse(recalled.due!)).toBeGreaterThan(Date.parse("2026-11-06T10:00:00.000Z"));
    expect(dueReviews([recalled], now)).toEqual([]);

    const missed = reviewPropositions(
      [taught],
      [
        event({ at: "2026-11-03T10:00:00.000Z", outcome: "correct", confidence: 90 }),
        event({ at: "2026-11-04T10:00:00.000Z", outcome: "incorrect", confidence: 85 }),
      ],
    ).get("n_a")!;
    expect(missed.lapse).toBe(true);
    expect(Date.parse(missed.due!)).toBeLessThanOrEqual(Date.parse("2026-11-05T10:00:00.000Z"));
    expect(reviewStatus(missed, now)).toBe(
      "retrieved 2026-11-04: wrong at confidence 85 (confident miss); due 2026-11-05",
    );
  });

  it("schedules an imported proposition from its first teaching provenance", () => {
    const graph = getGraph({
      nodes: [
        node("n_imported", "notes:physics.md", { createdAt: "2026-01-01T00:00:00Z" }),
        node("n_imported", "session-first", { createdAt: "2026-11-01T00:00:00Z" }),
        node("n_imported", "session-later", { createdAt: "2026-11-03T00:00:00Z" }),
      ],
      chains: [],
    });
    const review = reviewPropositions(graph.nodes, []).get("n_imported")!;
    expect(review.taughtAt).toBe("2026-11-01T00:00:00Z");
    expect(Date.parse(review.due!)).toBeGreaterThan(Date.parse("2026-11-02T00:00:00Z"));
  });

  it("buckets graded answers by confidence", () => {
    const answers = [
      { confidence: 10, correct: false },
      { confidence: 50, correct: true },
      { confidence: 55, correct: false },
      { confidence: 100, correct: true },
    ].map((entry) => ({ ...entry, at: at(0) }));
    expect(
      calibration(answers).map(({ from, answers, correct }) => [from, answers, correct]),
    ).toEqual([
      [0, 1, 0],
      [20, 0, 0],
      [40, 2, 1],
      [60, 0, 0],
      [80, 1, 1],
    ]);
  });
});
