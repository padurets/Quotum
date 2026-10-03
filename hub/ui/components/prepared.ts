import {useLayoutEffect, useRef, useState} from 'react';
import {prepare, preparations, type Preparation} from '../lib/prepare';

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Numeric preparation starts after commit and replaces the displayed model whole. */
export function usePrepared<T>(work: () => Preparation<T>, deps: readonly unknown[], context: unknown = null) {
  const owner = useRef({});
  const intent = useRef<{deps: readonly unknown[]; context: unknown} | null>(null);
  const [saved, setSaved] = useState<{deps: readonly unknown[]; context: unknown; value: T} | null>(null);
  useLayoutEffect(() => {
    if (intent.current && intent.current.context === context && same(intent.current.deps, deps)) return;
    const current = {deps: [...deps], context};
    intent.current = current;
    prepare(owner.current, work(), () => intent.current === current, value => setSaved({...current, value}));
  });
  useLayoutEffect(() => () => {intent.current = null; preparations()?.cancel(owner.current);}, []);
  return {value: saved && saved.context === context ? saved.value : null, ready: !!saved && saved.context === context && same(saved.deps, deps)};
}
