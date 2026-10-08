import {flushLargeViews} from './view';
import {useSyncExternalStore} from 'react';

const listeners = new Set<() => void>();
const address = () => typeof location === 'undefined' ? '/' : location.pathname + location.search;
const changed = () => { for (const listener of [...listeners]) listener(); };
let guard:((proceed:()=>void)=>void)|null=null;
let position=0,synthetic=false,allowedPop=false;
let navigation=0;
let restored:(()=>void)|null=null;
const historyPosition=()=>typeof history.state?.quotumPosition==='number'?history.state.quotumPosition as number:null;
const leavesView=(path:string)=>{
  const target=path.split('?')[0];
  return target==='/compact'||target==='/device'||target.startsWith('/invite/');
};
const leave=(path:string,go:()=>void)=>{
  if(leavesView(path))void flushLargeViews().then(go).catch(()=>{});
  else go();
};
const popped=()=>{
  if(synthetic)return changed();
  const next=historyPosition();
  if(restored){const done=restored;restored=null;done();return;}
  if(allowedPop){allowedPop=false;position=next??position;changed();return;}
  const attempt=++navigation;
  const target=address();
  if((guard||leavesView(target))&&next!==null&&next!==position){
    const delta=position-next,ask=guard;
    // Keep the dashboard and its saver mounted until every queued edit is saved.
    // Restoration also keeps a failed save on the exact original history entry.
    restored=()=>{
      const proceed=()=>leave(target,()=>{if(attempt!==navigation)return;allowedPop=true;history.go(-delta);});
      if(ask)ask(proceed);else proceed();
    };history.go(delta);return;
  }
  position=next??position;changed();
};

/** A settings form can retain its draft across both links and native Back/Forward. */
export function guardNavigation(ask:(proceed:()=>void)=>void) {
  guard=ask;return ()=>{if(guard===ask)guard=null;};
}

/** All client navigation, including chart ranges, publishes the same location. */
export function navigate(path: string, replace = false) {
  const attempt=++navigation;
  const go=()=>{
    if(attempt!==navigation)return;
    if (replace) history.replaceState({...history.state,quotumPosition:position}, '', path);
    else history.pushState({quotumPosition:++position}, '', path);
    synthetic=true;try{window.dispatchEvent(new PopStateEvent('popstate'));}finally{synthetic=false;}
  };
  const proceed=()=>leave(path,go);
  if(guard&&path!==address())guard(proceed);else proceed();
}

export function onLocation(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    position=historyPosition()??0;history.replaceState({...history.state,quotumPosition:position},'',address());
    window.addEventListener('popstate', popped);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('popstate', popped);
  };
}

export function useLocation() {
  return useSyncExternalStore(onLocation, address, address);
}

const pathname = () => typeof location === 'undefined' ? '/' : location.pathname;
export function usePath() { return useSyncExternalStore(onLocation, pathname, pathname); }

/** Board controls do not render again when only the charts' range changes. */
export function selectedBoard() {
  if (typeof location === 'undefined') return null;
  return location.pathname.match(/^\/boards\/([^/?]+)\/settings(?:[/?]|$)/)?.[1]
    ?? new URLSearchParams(location.search).get('board');
}
export function useSelectedBoard() { return useSyncExternalStore(onLocation, selectedBoard, selectedBoard); }

/** Settings keep the board and its range as a return address, never as connect consent. */
export function settingsHref(path: string, boardId?: string) {
  const params = new URLSearchParams(location.search);
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
