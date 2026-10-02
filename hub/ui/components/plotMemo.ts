import {useLayoutEffect, useRef} from 'react';

type Calculation<T> = {deps: readonly unknown[]; value: T};
const matches = (saved: readonly unknown[], deps: readonly unknown[]) => saved.length === deps.length && saved.every((value, i) => Object.is(value, deps[i]));

/** Keep the current and replacing strip's pure calculations across interrupted renders. */
export class PlotMemo<T> {
  private current: Calculation<T> | null = null;
  private replacing: Calculation<T> | null = null;

  get(calculate: () => T, deps: readonly unknown[]): T {
    if (this.current && matches(this.current.deps, deps)) return this.current.value;
    if (this.replacing && matches(this.replacing.deps, deps)) return this.replacing.value;
    const entry = {deps: [...deps], value: calculate()};
    this.replacing = entry;
    return entry.value;
  }

  commit(deps: readonly unknown[], value: T) {
    if (this.current && matches(this.current.deps, deps) && Object.is(this.current.value, value)) return;
    const entry = this.replacing && matches(this.replacing.deps, deps) && Object.is(this.replacing.value, value) ? this.replacing : {deps: [...deps], value};
    this.current = entry;
    if (this.replacing === entry) this.replacing = null;
  }
}

export function usePlotMemo<T>(calculate: () => T, deps: readonly unknown[]): T {
  const memo = useRef<PlotMemo<T> | null>(null);
  memo.current ??= new PlotMemo<T>();
  const value = memo.current.get(calculate, deps);
  useLayoutEffect(() => {memo.current!.commit(deps, value);});
  return value;
}
