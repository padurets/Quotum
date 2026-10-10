/** A yield is one bounded unit of numeric preparation, shared by sync and UI readers. */
export type Preparation<T> = Generator<void, T, void>;

export function drain<T>(work: Preparation<T>): T {
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

const pendingStep: IteratorYieldResult<void> = Object.freeze({value: undefined, done: false});
const object = (value: unknown) => value !== null && (typeof value === 'object' || typeof value === 'function');

/** Stable merge sort never hides a whole frame's comparisons in one native sort. */
export function* ordered<T>(input: Iterable<T>, compare: (a: T, b: T) => number): Preparation<T[]> {
  // Delegation preserves the generator's lifecycle while forwarding one immutable
  // pending result instead of allocating an object for every numeric step.
  let iterator: Iterator<T> | undefined, read: Iterator<T>['next'] | undefined;
  let copying = true, rows: T[] = [], spare: T[] | undefined, next: T[] | undefined;
  let size = 1, start = 0, a = 0, b = 0, aEnd = 0, bEnd = 0, at = 0;
  function release() {iterator = undefined; read = undefined; rows = []; spare = next = undefined;}
  function closeInput() {
    if (!iterator) return;
    const close = iterator.return;
    if (close != null && !object(Reflect.apply(close, iterator, []))) throw new TypeError('Iterator return result is not an object');
  }
  const cursor: IterableIterator<void, T[], void> = {
    next() {
      try {
        if (copying) {
          if (!iterator) {
            iterator = input[Symbol.iterator]();
            if (!object(iterator)) throw new TypeError('Iterator is not an object');
            read = iterator.next;
          }
          const row = Reflect.apply(read!, iterator, []);
          if (!object(row)) throw new TypeError('Iterator result is not an object');
          if (!row.done) {
            const value = row.value;
            try {rows.push(value);} catch (error) {try {closeInput();} catch {} throw error;}
            return pendingStep;
          }
          copying = false; iterator = undefined; read = undefined;
        }
        for (;;) {
          if (size >= rows.length) {
            const value = rows; release();
            return {value, done: true};
          }
          if (!next) {
            next = spare ?? new Array<T>(rows.length); at = 0; start = 0;
            a = 0; b = Math.min(size, rows.length); aEnd = b; bEnd = Math.min(size * 2, rows.length);
          }
          if (a < aEnd || b < bEnd) {
            next[at++] = b >= bEnd || a < aEnd && compare(rows[a], rows[b]) <= 0 ? rows[a++] : rows[b++];
            return pendingStep;
          }
          start += size * 2;
          if (start >= rows.length) {spare = rows; rows = next; next = undefined; size *= 2;}
          else {a = start; b = Math.min(start + size, rows.length); aEnd = b; bEnd = Math.min(start + size * 2, rows.length);}
        }
      } catch (error) {release(); throw error;}
    },
    return(value) {
      try {closeInput();} finally {release();}
      return {value: value as T[], done: true};
    },
    throw(error) {
      try {closeInput();} catch {} finally {release();}
      throw error;
    },
    [Symbol.iterator]() {return this;},
  };
  return yield* cursor;
}
