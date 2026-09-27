import {useRef, useState, useSyncExternalStore} from 'react';

/**
 * A store of the page's state that changes only by events: `dispatch` runs the reducer,
 * and whoever reads a part of the state (`useSelect`) renders only when that part changes.
 * `listen` is for services that act on events rather than show state (the history loader).
 */
export type Store<S, E> = {
  get(): S;
  dispatch(event: E): void;
  subscribe(listener: () => void): () => void;
  listen(onEvent: (event: E, state: S) => void): () => void;
};

export function createStore<S, E>(reducer: (state: S, event: E) => S, initial: S): Store<S, E> {
  let state = initial;
  const listeners = new Set<() => void>();
  const watchers = new Set<(event: E, state: S) => void>();
  return {
    get: () => state,
    dispatch(event) {
      const next = reducer(state, event);
      const changed = next !== state;
      state = next;
      if (changed) for (const listener of [...listeners]) listener();
      for (const watcher of [...watchers]) watcher(event, state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listen(onEvent) {
      watchers.add(onEvent);
      return () => watchers.delete(onEvent);
    },
  };
}

/**
 * What `useSelect` reads: the part `pick().select` takes of the store's state, and the
 * same value (the same object) as long as the part stays `equal`, however often the
 * store changes, so React renders nothing for it.
 */
export function selector<S, T>(store: Pick<Store<S, unknown>, 'get'>, pick: () => {select: (state: S) => T; equal: (a: T, b: T) => boolean}) {
  let memo: {value: T} | null = null;
  return () => {
    const {select, equal} = pick();
    const value = select(store.get());
    if (memo && equal(memo.value, value)) return memo.value;
    memo = {value};
    return value;
  };
}

/** A part of a store's state for a component: it renders when that part changes, and only then. */
export function useSelect<S, T>(store: Store<S, unknown>, select: (state: S) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  // The selector may be a new function every render (it closes over props): the latest is read.
  const latest = useRef({select, equal});
  latest.current = {select, equal};
  const [read] = useState(() => selector(store, () => latest.current));
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Arrays or objects with the same items or keys, each the same (`Object.is`). */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every(key => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** The same once written out: for parts rebuilt from JSON, where a new object may say the same. */
export const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
