/** Share of `gold` found in the first `k` of `ranked`; 1 when nothing is expected. */
export function recallAt(
  ranked: ReadonlyArray<string>,
  gold: ReadonlyArray<string>,
  k: number,
): number {
  if (gold.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  return gold.filter((id) => top.has(id)).length / gold.length;
}

/** Whether every gold note is among the notes a turn shows. */
export const allVisible = (visible: ReadonlySet<string>, gold: ReadonlyArray<string>) =>
  gold.every((id) => visible.has(id));

export const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Nearest-rank percentile, `p` from 0 to 100. */
export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ]!;
}
