import {known, t} from '../i18n';

/** Fired whenever the hub answers 401: the session ended, so the page asks again. */
export const UNAUTHORIZED = 'quotum:unauthorized';

/** An answer of the hub other than success, with its error code (`{error}` in the body). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * The one way the page talks to the hub: JSON in and out, no caching, a timeout, and a
 * 401 announced to whoever keeps the session.
 */
export async function call<T>(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, timeoutMs = 12_000): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
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

/** What went wrong, in the reader's language. Errors are kept as they are and put into words when shown. */
export function messageOf(error: unknown) {
  if (!(error instanceof ApiError)) return t('common.offline');
  const key = `api.${error.code}`;
  return t(known(key) ? key : 'api.unknown');
}
