import {useSyncExternalStore} from 'react';

const listeners = new Set<() => void>();
const address = () => typeof location === 'undefined' ? '/' : location.pathname + location.search;
const changed = () => { for (const listener of [...listeners]) listener(); };

/** All client navigation, including chart ranges, publishes the same location. */
export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function onLocation(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('popstate', changed);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('popstate', changed);
  };
}

export function useLocation() {
  return useSyncExternalStore(onLocation, address, address);
}

export function usePath() { return useLocation().split('?')[0]; }

/** Settings keep the board and its range as a return address, never as connect consent. */
export function settingsHref(path: string, boardId?: string) {
  const params = new URLSearchParams(location.search);
  const query = new URLSearchParams();
  const board = boardId ?? params.get('board');
  if (board) query.set('board', board);
  for (const key of ['from', 'to']) if (params.has(key)) query.set(key, params.get(key)!);
  return path + (query.size ? '?' + query : '');
}
