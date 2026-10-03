import {useLayoutEffect, useRef, useState} from 'react';
import {prepare, preparations, type Preparation} from '../lib/prepare';

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
type Projection = {from: number; to: number; end: number};

/** Data owns its numeric basis; clock movement only reprojects the displayed model. */
export class PreparationBasis {
  private saved: {deps: readonly unknown[]; value: Projection} | null = null;
  get(value: Projection, deps: readonly unknown[], captured: boolean, enabled = true): Projection {
    if (enabled && (!this.saved || !same(this.saved.deps, deps) || captured && (value.from !== this.saved.value.from || value.to !== this.saved.value.to || value.end !== this.saved.value.end))) this.saved = {deps: [...deps], value: {from: value.from, to: value.to, end: value.end}};
    return this.saved?.value ?? value;
  }
}

export function usePreparationBasis(value: Projection, deps: readonly unknown[], captured: boolean, enabled = true): Projection {
  const basis = useRef<PreparationBasis | null>(null);
  basis.current ??= new PreparationBasis();
  return basis.current.get(value, deps, captured, enabled);
}

/** Numeric preparation starts after commit and replaces the displayed model whole. */
export function usePrepared<T>(work: () => Preparation<T>, deps: readonly unknown[], context: unknown = null, enabled = true) {
  const owner = useRef({});
  const intent = useRef<{deps: readonly unknown[]; context: unknown} | null>(null);
  const [saved, setSaved] = useState<{deps: readonly unknown[]; context: unknown; value: T} | null>(null);
  useLayoutEffect(() => {
    if (!enabled) {
      intent.current = null;
      preparations()?.cancel(owner.current);
      return;
    }
    if (intent.current && intent.current.context === context && same(intent.current.deps, deps)) return;
    const current = {deps: [...deps], context};
    intent.current = current;
    prepare(owner.current, work(), () => intent.current === current, value => setSaved({...current, value}));
  });
  useLayoutEffect(() => () => {intent.current = null; preparations()?.cancel(owner.current);}, []);
  return {value: saved && saved.context === context ? saved.value : null, ready: enabled && !!saved && saved.context === context && same(saved.deps, deps)};
}
