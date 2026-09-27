import {useCallback, useEffect, useState} from 'react';
import {t} from '../i18n';
import {page, useBoards} from './board';
import {call, UNAUTHORIZED} from './http';

export type User = {id: string; email: string; name: string};
export type Board = {id: string; name: string; personal: boolean; role: 'owner' | 'member'};
/** `local`: the desktop app's hub, one person who never signs in (see lib/app.ts). */
export type Session = {user: User | null; boards: Board[]; signup: {first: boolean; open: boolean}; local: boolean};

/** Personal boards have no name of their own: each reader sees theirs in their language. */
export const boardTitle = (board: {name: string}) => board.name || t('boards.personalName');

/** Fired when a board went away: the page asks who is signed in and to which boards. */
const REREAD = 'quotum:session';
export const rereadSession = () => window.dispatchEvent(new Event(REREAD));

/**
 * Who is signed in and to which boards. While the hub cannot be reached the page keeps
 * asking, sooner when the browser comes back online or the tab becomes visible. Every
 * session the page takes (asked for, or given by signing in or joining) tells the page's
 * state its boards.
 */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);

  const accept = useCallback((next: Session) => {
    page.dispatch({type: 'session-boards', boards: next.boards});
    setSession(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      accept(await call<Session>('GET', '/api/session'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [accept]);

  useEffect(() => {
    void refresh();
    const again = () => void refresh();
    window.addEventListener(UNAUTHORIZED, again);
    window.addEventListener(REREAD, again);
    return () => {
      window.removeEventListener(UNAUTHORIZED, again);
      window.removeEventListener(REREAD, again);
    };
  }, [refresh]);

  useEffect(() => {
    if (!failed) return;
    let delay = 2000;
    let timer: ReturnType<typeof setTimeout>;
    const retry = () => {
      timer = setTimeout(async () => {
        await refresh();
        delay = Math.min(30_000, delay * 2);
        retry();
      }, delay);
    };
    retry();
    const now = () => document.visibilityState === 'visible' && void refresh();
    window.addEventListener('online', now);
    document.addEventListener('visibilitychange', now);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', now);
      document.removeEventListener('visibilitychange', now);
    };
  }, [failed, refresh]);

  return {session, failed, refresh, setSession: accept};
}

const BOARD_KEY = 'quotum.board';

/** Opens this board next time the page is opened in this browser. */
export function rememberBoard(id: string) {
  try {
    localStorage.setItem(BOARD_KEY, id);
  } catch {
    /* no storage: the personal board opens */
  }
}

function remembered(): string | null {
  try {
    return new URLSearchParams(location.search).get('board') ?? localStorage.getItem(BOARD_KEY);
  } catch {
    return null;
  }
}

/**
 * The board on screen: the last one chosen in this browser, else the personal one. Of the
 * reader's boards as the page's state has them: one gone meanwhile gives way to the first.
 */
export function useBoard(): [Board | null, (id: string) => void] {
  const boards = useBoards();
  const [id, setId] = useState(remembered);
  const board = boards?.find(b => b.id === id) ?? boards?.[0] ?? null;
  const select = useCallback((next: string) => {
    setId(next);
    rememberBoard(next);
  }, []);
  return [board, select];
}
