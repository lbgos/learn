import type { GradedAnswer } from "./retrieval.ts";

export interface CalibrationBucket {
  readonly from: number;
  readonly to: number;
  readonly answers: number;
  readonly correct: number;
}

/** Five confidence bands of 20 points against the share of answers that were right. */
export function calibration(answers: readonly GradedAnswer[]): CalibrationBucket[] {
  const buckets = [0, 20, 40, 60, 80].map((from) => ({
    from,
    to: from === 80 ? 100 : from + 19,
    answers: 0,
    correct: 0,
  }));
  for (const answer of answers) {
    const bucket = buckets[Math.min(4, Math.max(0, Math.floor(answer.confidence / 20)))]!;
    bucket.answers++;
    if (answer.correct) bucket.correct++;
  }
  return buckets;
}
