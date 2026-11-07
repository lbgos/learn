/**
 * Fixed-capacity sample store for the live plots. The sim posts rows of `[t, ...observables]`;
 * the newest `capacity` rows are kept and `series` decimates them for drawing.
 */
export class SampleRing {
  private readonly data: Float64Array;
  private start = 0;
  private count = 0;

  constructor(
    readonly columns: number,
    readonly capacity = 2400,
  ) {
    this.data = new Float64Array(capacity * columns);
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }

  /** A row at t=0 or earlier than the last one means the sim restarted, so older rows are dropped first. */
  push(rows: ReadonlyArray<ReadonlyArray<number>>): void {
    for (const row of rows) {
      if (row.length !== this.columns) continue;
      if (this.count > 0 && (row[0] === 0 || row[0]! < this.at(this.count - 1, 0))) this.clear();
      const index = (this.start + this.count) % this.capacity;
      for (let c = 0; c < this.columns; c++) this.data[index * this.columns + c] = row[c]!;
      if (this.count < this.capacity) this.count++;
      else this.start = (this.start + 1) % this.capacity;
    }
  }

  private at(row: number, column: number): number {
    return this.data[((this.start + row) % this.capacity) * this.columns + column]!;
  }

  /**
   * Points of one observable (column 1..n) for at most `maxPoints` pixels of width. Longer
   * series keep each bucket's minimum and maximum in time order, so spikes survive decimation.
   */
  series(column: number, maxPoints: number): { x: number[]; y: number[] } {
    const x: number[] = [];
    const y: number[] = [];
    if (this.count <= maxPoints) {
      for (let i = 0; i < this.count; i++) {
        x.push(this.at(i, 0));
        y.push(this.at(i, column));
      }
      return { x, y };
    }
    const buckets = Math.max(1, Math.floor(maxPoints / 2));
    for (let b = 0; b < buckets; b++) {
      const from = Math.floor((b * this.count) / buckets);
      const to = Math.floor(((b + 1) * this.count) / buckets);
      let lo = from;
      let hi = from;
      for (let i = from; i < to; i++) {
        if (this.at(i, column) < this.at(lo, column)) lo = i;
        if (this.at(i, column) > this.at(hi, column)) hi = i;
      }
      for (const i of lo <= hi ? [lo, hi] : [hi, lo]) {
        x.push(this.at(i, 0));
        y.push(this.at(i, column));
        if (lo === hi) break;
      }
    }
    return { x, y };
  }
}
