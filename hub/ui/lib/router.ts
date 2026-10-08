import {flushLargeViews} from './view';
import {useSyncExternalStore} from 'react';

type Route = {pathname: string; search: string; hash: string};
type Entry = {path: string; position: number};
type Transition = {
  stage: 'restoring' | 'confirming' | 'saving' | 'replaying';
  path: string;
  target?: Entry;
  replace: boolean;
};
const listeners = new Set<() => void>();
const browserRoute = (): Route => typeof location === 'undefined' ? {pathname: '/', search: '', hash: ''}
  : {pathname: location.pathname, search: location.search, hash: location.hash ?? ''};
const href = (route: Route) => route.pathname + route.search + route.hash;
let committed: Route | null = null;
/** The route the UI has accepted, even while native history is being restored. */
export const routeLocation = () => committed ?? browserRoute();
const address = () => {const route = routeLocation(); return route.pathname + route.search;};
const changed = () => {for (const listener of [...listeners]) listener();};
let guard: ((proceed: () => void) => void) | null = null;
let position = 0;
let transition: Transition | null = null;
const historyPosition = () => typeof history.state?.quotumPosition === 'number' ? history.state.quotumPosition as number : null;
const leavesView = (path: string) => {
  const target = path.split(/[?#]/)[0];
  return target === '/compact' || target === '/device' || target.startsWith('/invite/');
};
const at = (entry: Entry) => historyPosition() === entry.position && href(browserRoute()) === entry.path;
const publish = () => {
  position = historyPosition() ?? position;
  committed = browserRoute();
  transition = null;
  changed();
};

function reconcile(pending: Transition) {
  if (transition !== pending) return;
  const origin = {position, path: href(routeLocation())};
  const destination = pending.stage === 'replaying' && pending.target ? pending.target : origin;
  if (!at(destination)) {
    const current = historyPosition();
    // A burst of native traversals can supersede our previous go. Only the expected
    // entry acknowledges it; another pop recalculates the move from the actual entry.
    if (current !== null && current !== destination.position) history.go(destination.position - current);
    return;
  }
  if (pending.stage === 'restoring') {
    pending.stage = 'confirming';
    const proceed = () => {
      if (transition !== pending || pending.stage !== 'confirming') return;
      pending.stage = 'saving';
      const saved = () => {
        if (transition !== pending) return;
        pending.stage = 'replaying';
        reconcile(pending);
      };
      if (leavesView(pending.path)) void flushLargeViews().then(saved).catch(() => {
        if (transition === pending) transition = null;
      });
      else saved();
    };
    if (guard && pending.path !== origin.path) guard(proceed); else proceed();
  } else if (pending.stage === 'replaying') {
    if (!pending.target) {
      if (pending.replace) history.replaceState({...history.state, quotumPosition: position}, '', pending.path);
      else history.pushState({quotumPosition: ++position}, '', pending.path);
    }
    publish();
  }
}
const popped = () => {
  if (transition) {
    // A fresh attempt after a cancelled confirmation may choose another destination.
    if (transition.stage !== 'confirming' || at({position, path: href(routeLocation())})) return reconcile(transition);
    transition = null;
  }
  const next = historyPosition(), path = href(browserRoute());
  if ((guard || leavesView(path)) && next !== null && next !== position) {
    transition = {stage: 'restoring', path, target: {path, position: next}, replace: false};
    reconcile(transition);
  } else publish();
};

/** A settings form can retain its draft across both links and native Back/Forward. */
export function guardNavigation(ask: (proceed: () => void) => void) {
  guard = ask; return () => {if (guard === ask) guard = null;};
}

/** All client navigation, including chart ranges, publishes the same location. */
export function navigate(path: string, replace = false) {
  transition = {stage: 'restoring', path, replace};
  reconcile(transition);
}

export function onLocation(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    committed = browserRoute();
    position = historyPosition() ?? 0;
    history.replaceState({...history.state, quotumPosition: position}, '', href(committed));
    window.addEventListener('popstate', popped);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener('popstate', popped);
      committed = null;
      transition = null;
    }
  };
}

export function useLocation() {
  return useSyncExternalStore(onLocation, address, address);
}
const pathname = () => routeLocation().pathname;
export function usePath() {return useSyncExternalStore(onLocation, pathname, pathname);}

/** Board controls do not render again when only the charts' range changes. */
export function selectedBoard() {
  const route = routeLocation();
  return route.pathname.match(/^\/boards\/([^/?]+)\/settings(?:[/?]|$)/)?.[1]
    ?? new URLSearchParams(route.search).get('board');
}
export function useSelectedBoard() {return useSyncExternalStore(onLocation, selectedBoard, selectedBoard);}

/** Settings keep the board and its range as a return address, never as connect consent. */
export function settingsHref(path: string, boardId?: string) {
  const params = new URLSearchParams(routeLocation().search);
  const query = new URLSearchParams();
  const board = boardId ?? params.get('board');
  if (board) query.set('board', board);
  for (const key of ['from', 'to']) if (params.has(key)) query.set(key, params.get(key)!);
  return path + (query.size ? '?' + query : '');
}

/** Returning to the selected board keeps its range; another destination starts live. */
export function boardHref(boardId: string) {
  const selected = selectedBoard();
  return selected === null || selected === boardId
    ? settingsHref('/', boardId)
    : '/?board=' + encodeURIComponent(boardId);
}
