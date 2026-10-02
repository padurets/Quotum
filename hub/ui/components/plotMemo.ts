import {useRef} from 'react';

/** Keep the current and replacing strip's pure calculations across interrupted renders. */
export class PlotMemo<T> {
  private entries: {deps: readonly unknown[]; value: T}[] = [];

  get(calculate: () => T, deps: readonly unknown[]): T {
    const found = this.entries.findIndex(entry => entry.deps.length === deps.length && entry.deps.every((value, i) => Object.is(value, deps[i])));
    if (found >= 0) {
      const [entry] = this.entries.splice(found, 1);
      this.entries.unshift(entry);
      return entry.value;
    }
    const entry = {deps: [...deps], value: calculate()};
    this.entries.unshift(entry);
    if (this.entries.length > 2) this.entries.pop();
    return entry.value;
  }
}

export function usePlotMemo<T>(calculate: () => T, deps: readonly unknown[]): T {
  const memo = useRef<PlotMemo<T> | null>(null);
  memo.current ??= new PlotMemo<T>();
  return memo.current.get(calculate, deps);
}
