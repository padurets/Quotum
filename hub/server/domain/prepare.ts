/** A yield is one bounded unit of numeric preparation, shared by sync and UI readers. */
export type Preparation<T> = Generator<void, T, void>;

export function drain<T>(work: Preparation<T>): T {
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

/** Stable merge sort never hides a whole frame's comparisons in one native sort. */
export function* ordered<T>(input: Iterable<T>, compare: (a: T, b: T) => number): Preparation<T[]> {
  let rows: T[] = [];
  for (const row of input) {rows.push(row); yield;}
  for (let size = 1; size < rows.length; size *= 2) {
    const next: T[] = [];
    for (let start = 0; start < rows.length; start += size * 2) {
      let a = start, b = Math.min(start + size, rows.length);
      const aEnd = b, bEnd = Math.min(start + size * 2, rows.length);
      while (a < aEnd || b < bEnd) {
        next.push(b >= bEnd || a < aEnd && compare(rows[a], rows[b]) <= 0 ? rows[a++] : rows[b++]);
        yield;
      }
    }
    rows = next;
  }
  return rows;
}
