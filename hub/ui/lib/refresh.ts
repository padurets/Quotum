import {countdown, countdownChangesAt, earliest, stamp} from './format';
import {known, t} from '../i18n';
import type {Refresh, RefreshRequest} from './types';
import {ApiError, call, messageOf} from './http';
import {createStore, useSelect} from './store';
import {hubNow} from './clock';

/** When a new request may go: after the cooldown and after a pause, whichever ends later. */
const retryTime = (state: Refresh | null) => {
  const times = [state?.retryAt, state?.availableAt].filter((at): at is number => at != null);
  return times.length ? Math.max(...times) : null;
};

export function refreshTime(state: Refresh): number | null {
  if (state.request?.status === 'queued') return state.request.notBefore;
  if (state.request?.status === 'waiting') return null;
  return retryTime(state);
}

export const refreshChangesAt = (state: Refresh, now: number) => {
  const at = refreshTime(state);
  return at !== null && at > now ? earliest(at, countdownChangesAt(at, now)) : null;
};

export function refreshText(state: Refresh, now: number): string {
  const status = state.request?.status;
  const main =
    status === 'queued' && state.request!.notBefore <= now
      ? t('refresh.nextCheckin')
      : status
        ? t(`refresh.${status}`)
        : state.unavailable
          ? t(`refresh.${state.unavailable}`)
          : '';
  const reason = status && status !== 'queued' && status !== 'waiting' && state.unavailable ? t(`refresh.${state.unavailable}`) : '';
  const at = refreshTime(state);
  // A time already past says nothing about what comes next.
  const ahead = at !== null && at > now;
  return [main, reason, ahead ? t(status === 'queued' ? 'refresh.after' : 'refresh.retry', {time: countdown(at - now)}) : '', ahead ? stamp(at) : '']
    .filter(Boolean)
    .join('\n');
}

export const refreshPending = (state: Refresh | null) => state?.request?.status === 'queued' || state?.request?.status === 'waiting';

/** The cards this page is asking the hub to refresh, from a card's menu or the header, by board and card. */
const sent = new Map<string, Promise<unknown>>();
const sending = createStore<ReadonlySet<string>, ReadonlySet<string>>((_state, next) => next, new Set());
const sentKey = (board: string, id: string) => `${board}\n${id}`;

/** Whether this page is still waiting for the hub to take a card's request. */
export const isSending = (board: string, id: string) => sending.get().has(sentKey(board, id));
export const useSending = (board: string, id: string) => useSelect(sending, keys => keys.has(sentKey(board, id)));

/** One request per card at a time: asking again before the hub answers waits for the same answer. */
export function requestRefresh(board: string, id: string): Promise<unknown> {
  const key = sentKey(board, id);
  let request = sent.get(key);
  if (!request) {
    request = call('POST', `/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(id)}/refresh`).finally(() => {
      sent.delete(key);
      sending.dispatch(new Set(sent.keys()));
    });
    sent.set(key, request);
    sending.dispatch(new Set(sent.keys()));
  }
  return request;
}

/** `answeredAt`: when the hub's reply (or its failure) came, by the hub's clock as the page reads it. */
export type RefreshRow = {
  id: string;
  before: number | null;
  status: RefreshRequest['status'] | 'sending' | 'refused' | 'unknown';
  state: Refresh | null;
  error: unknown;
  answeredAt: number | null;
};

/**
 * How much later than its reply a request may still be the row's own: the page reads the hub's
 * clock only so well. One accepted blocks another for a minute, so a later one is someone else's.
 */
const REPLY_SLACK_MS = 30_000;

export const refreshRowPending = (row: RefreshRow) => row.status === 'sending' || row.status === 'queued' || row.status === 'waiting';
/**
 * Rows told what became of their request, and those whose request ended unseen (an unknown
 * row keeps the last it saw of it). A lost reply, or a request not seen yet, may still turn up.
 */
const settledRow = (row: RefreshRow) =>
  ['updated', 'failed', 'unavailable', 'no_result', 'refused'].includes(row.status) || (row.status === 'unknown' && row.error === null && row.state !== null);

/** Opening the header's list shows the last attempt; only with none yet does it start one. */
export const refreshAllStarts = (rows: RefreshRow[]) => rows.length === 0;

/** A receipt starts afresh, except for subscriptions already waiting for their data. */
export const startRefreshRows = (ids: string[], states: Record<string, Refresh>): RefreshRow[] => [...new Set(ids)].map(id => {
  const state = states[id] ?? null;
  const pending = refreshPending(state);
  return {id, before: state?.request?.requestedAt ?? null, status: pending ? state!.request!.status : 'sending', state: pending ? state : null, error: null, answeredAt: null};
});

/** Keep each outcome after the hub retires its short-lived status, even with the popup closed. */
export function observeRefreshRows(rows: RefreshRow[], states: Record<string, Refresh>, snapshot = false): RefreshRow[] {
  const next = rows.map(row => {
    if (settledRow(row)) return row;
    const state = states[row.id];
    const request = state?.request;
    const followed = refreshRowPending(row) ? row.state?.request : null;
    if (followed) {
      if (request?.requestedAt === followed.requestedAt) {
        return row.state === state && row.status === request.status ? row : {...row, status: request.status, state, error: null};
      }
      // Its request is gone or replaced, and no event told how it ended: say so rather than
      // follow someone else's request or wait for ever.
      return {...row, status: 'unknown' as const, error: null};
    }
    // Not seen yet: its own request, made before the reply, not one made later by someone else.
    const own = request && request.requestedAt !== row.before && (row.answeredAt === null || request.requestedAt <= row.answeredAt + REPLY_SLACK_MS);
    if (own) return {...row, status: request.status, state, error: null};
    // A reconnect may arrive after the entire request, including its retained outcome.
    // No record of it is not evidence of success, nor a reason to show an endless loader.
    if (snapshot && row.status !== 'sending' && refreshRowPending(row) && !request) return {...row, status: 'unknown' as const, state: null, error: null};
    return row;
  });
  return next.every((row, index) => row === rows[index]) ? rows : next;
}

/** The HTTP reply cannot overwrite a request or outcome already received through events. */
export function answerRefreshRow(row: RefreshRow, state: Refresh | undefined, error: unknown = null, now = hubNow()): RefreshRow {
  const observed = observeRefreshRows([row], state ? {[row.id]: state} : {})[0];
  if (observed.state?.request && observed.status !== 'refused' && observed.status !== 'unknown') return observed;
  return {...row, state: error ? state ?? null : null, error, status: error ? error instanceof ApiError ? 'refused' : 'unknown' : 'waiting', answeredAt: now};
}

/** Each subscription keeps its own checks; a refusal must not stop the other cards. */
export async function requestRefreshAll(
  board: string,
  ids: string[],
  request: (board: string, id: string) => Promise<unknown> = requestRefresh,
  current: () => boolean = () => true,
): Promise<void> {
  const queue = [...new Set(ids)];
  let next = 0;
  await Promise.all(Array.from({length: Math.min(4, queue.length)}, async () => {
    while (next < queue.length && current()) {
      const id = queue[next++];
      await request(board, id).catch(() => {});
    }
  }));
}

const refusalTime = (error: unknown, state: Refresh | null) =>
  error instanceof ApiError && (error.code === 'refresh_too_soon' || error.code === 'refresh_unavailable') ? retryTime(state) : null;

/** A refused action explains what prevents it and what the reader can do. */
export function refreshErrorText(error: unknown, state: Refresh | null, now: number): string {
  if (!(error instanceof ApiError)) return t('refresh.uncertain');
  const at = refusalTime(error, state);
  const reason =
    error.code === 'refresh_unavailable' && state?.unavailable
      ? t(`refresh.${state.unavailable}`)
      : known(`api.${error.code}`)
        ? messageOf(error)
        : t('refresh.failed');
  return [reason, ...(at !== null && at > now ? [t('refresh.retry', {time: countdown(at - now)}), stamp(at)] : [])].join('\n');
}

export function refreshErrorChangesAt(error: unknown, state: Refresh | null, now: number): number | null {
  const at = refusalTime(error, state);
  return at !== null && at > now ? earliest(at, countdownChangesAt(at, now)) : null;
}
