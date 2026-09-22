import {useCallback, useEffect, useState} from 'react';

export type User = {id: string; email: string; name: string; role: 'admin' | 'user'};
export type Board = {id: string; name: string; personal: boolean; role: 'owner' | 'member'};
export type Session = {user: User | null; boards: Board[]; signup: {first: boolean; open: boolean}};

/** Fired whenever the hub answers 401: the session ended, so the page asks again. */
export const UNAUTHORIZED = 'agent-limits:unauthorized';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function call<T>(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED));
    throw new ApiError(response.status, data.error ?? String(response.status));
  }
  return data as T;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Неверная почта или пароль',
  email_taken: 'Эта почта уже зарегистрирована — войдите',
  signup_closed: 'Регистрация только по приглашению',
  invalid_input: 'Проверьте поля: почта, имя и пароль не короче 8 символов',
  invalid_invite: 'Приглашение недействительно или истекло',
  too_many_attempts: 'Слишком много попыток, попробуйте позже',
  invalid_code: 'Код не найден или истёк',
  board_not_found: 'Доска не найдена',
};

export const messageOf = (error: unknown) =>
  error instanceof ApiError ? (MESSAGES[error.code] ?? 'Что-то пошло не так') : 'Нет связи с сервисом';

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSession(await call<Session>('GET', '/api/session'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const again = () => void refresh();
    window.addEventListener(UNAUTHORIZED, again);
    return () => window.removeEventListener(UNAUTHORIZED, again);
  }, [refresh]);

  return {session, failed, refresh, setSession};
}

const BOARD_KEY = 'agent-limits.board';

function remembered(): string | null {
  try {
    return new URLSearchParams(location.search).get('board') ?? localStorage.getItem(BOARD_KEY);
  } catch {
    return null;
  }
}

/** The board on screen: the last one chosen in this browser, else the personal one. */
export function useBoard(boards: Board[]): [Board | null, (id: string) => void] {
  const [id, setId] = useState(remembered);
  const board = boards.find(b => b.id === id) ?? boards[0] ?? null;
  const select = useCallback((next: string) => {
    setId(next);
    try {
      localStorage.setItem(BOARD_KEY, next);
    } catch {}
  }, []);
  return [board, select];
}

/** Moves to another page of the client without a reload. */
export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return path;
}
