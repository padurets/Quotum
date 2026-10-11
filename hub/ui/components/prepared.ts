import {useLayoutEffect, useRef, useState} from 'react';
import {prepare, preparations, type Preparation} from '../lib/prepare';

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
type Projection = {from: number; to: number; end: number};

/** Data owns its numeric basis; clock movement only reprojects the displayed model. */
export class PreparationBasis {
  private saved: {deps: readonly unknown[]; value: Projection} | null = null;
  get(value: Projection, deps: readonly unknown[], captured: boolean, enabled = true): Projection {
    if (enabled && (!this.saved || !same(this.saved.deps, deps) || captured && (value.from !== this.saved.value.from || value.to !== this.saved.value.to || value.end !== this.saved.value.end))) this.saved = {deps: [...deps], value: {from: value.from, to: value.to, end: value.end}};
    else if (enabled && !captured && this.saved) {
      const previous = this.saved.value, margin = Math.max(60_000, previous.to - previous.from) / 4;
      if (value.from < previous.from - margin || value.to > previous.to + margin) this.saved = {...this.saved, value: {from: value.from, to: value.to, end: previous.end}};
    }
    return this.saved?.value ?? value;
  }
}

export function usePreparationBasis(value: Projection, deps: readonly unknown[], captured: boolean, enabled = true, context: unknown = null): Projection {
  const basis = useRef<{context: unknown; value: PreparationBasis} | null>(null);
  if (!basis.current || !Object.is(basis.current.context, context)) basis.current = {context, value: new PreparationBasis()};
  return basis.current.value.get(value, deps, captured, enabled);
}

/** Numeric preparation starts after commit and replaces the displayed model whole. */
export function usePrepared<T>(work: () => Preparation<T>, deps: readonly unknown[], context: unknown = null, enabled = true) {
  const owner = useRef({});
  const lifetime = useRef({context});
  if (!Object.is(lifetime.current.context, context)) lifetime.current = {context};
  const scope = lifetime.current;
  const intent = useRef<{deps: readonly unknown[]; scope: typeof scope} | null>(null);
  const [saved, setSaved] = useState<{deps: readonly unknown[]; scope: typeof scope; value: T} | null>(null);
  // Returning to the same context text cannot revive a retired lifetime.
  if (saved && saved.scope !== scope) setSaved(null);
  useLayoutEffect(() => {
    if (!enabled) {
      intent.current = null;
      preparations()?.cancel(owner.current);
      return;
    }
    if (intent.current && intent.current.scope === scope && same(intent.current.deps, deps)) return;
    const current = {deps: [...deps], scope};
    intent.current = current;
    prepare(owner.current, work(), () => intent.current === current && lifetime.current === scope, value => setSaved({...current, value}));
  });
  useLayoutEffect(() => () => {intent.current = null; preparations()?.cancel(owner.current);}, []);
  return {value: saved && saved.scope === scope ? saved.value : null, ready: enabled && !!saved && saved.scope === scope && same(saved.deps, deps)};
}
