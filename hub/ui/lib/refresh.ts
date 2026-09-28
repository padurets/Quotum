import {countdown, countdownChangesAt, earliest, stamp} from './format';
import {known, t} from '../i18n';
import type {Refresh, RefreshRequest} from './types';
import {ApiError, call, messageOf} from './http';

export function refreshTime(state: Refresh): number | null {
  if (state.request?.status === 'queued') return state.request.notBefore;
  if (state.request?.status === 'waiting') return null;
  return state.retryAt ?? state.availableAt;
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
          : t('refresh.ready');
  const reason = status && status !== 'queued' && status !== 'waiting' && state.unavailable ? t(`refresh.${state.unavailable}`) : '';
  const at = refreshTime(state);
  return [
    main,
    reason,
    at !== null && at > now ? t(status === 'queued' ? 'refresh.after' : 'refresh.retry', {time: countdown(at - now)}) : '',
    at !== null ? stamp(at) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const refreshPending = (state: Refresh | null) => state?.request?.status === 'queued' || state?.request?.status === 'waiting';

export const requestRefresh = (board: string, id: string) =>
  call('POST', `/api/boards/${encodeURIComponent(board)}/sources/${encodeURIComponent(id)}/refresh`);

export type RefreshBatch = {total: number; accepted: number; failures: {id: string; error: unknown}[]};

export type RefreshRow = {
  id: string;
  before: number | null;
  status: RefreshRequest['status'] | 'sending' | 'refused' | 'unknown';
  state: Refresh | null;
  error: unknown;
};

export const refreshRowPending = (row: RefreshRow) => row.status === 'sending' || row.status === 'queued' || row.status === 'waiting';
const finishedRow = (row: RefreshRow) => ['updated', 'failed', 'unavailable', 'no_result'].includes(row.status);

/** A receipt starts afresh, except for subscriptions already waiting for their data. */
export const startRefreshRows = (ids: string[], states: Record<string, Refresh>): RefreshRow[] => [...new Set(ids)].map(id => {
  const state = states[id] ?? null;
  const pending = refreshPending(state);
  return {id, before: state?.request?.requestedAt ?? null, status: pending ? state!.request!.status : 'sending', state: pending ? state : null, error: null};
});

/** Keep each outcome after the hub retires its short-lived status, even with the popup closed. */
export function observeRefreshRows(rows: RefreshRow[], states: Record<string, Refresh>, snapshot = false): RefreshRow[] {
  const next = rows.map(row => {
    if (finishedRow(row)) return row;
    const state = states[row.id];
    const request = state?.request;
    const inherited = refreshRowPending(row) && row.state?.request?.requestedAt === row.before;
    if (request && (request.requestedAt !== row.before || inherited)) {
      return row.state === state && row.status === request.status && row.error === null ? row : {...row, status: request.status, state, error: null};
    }
    // A reconnect may arrive after the entire request, including its retained outcome.
    // No record of it is not evidence of success, nor a reason to show an endless loader.
    if (snapshot && row.status !== 'sending' && refreshRowPending(row) && !request) {
      return {...row, status: 'unknown' as const, state: null};
    }
    return row;
  });
  return next.every((row, index) => row === rows[index]) ? rows : next;
}

/** The HTTP reply cannot overwrite a request or outcome already received through events. */
export function answerRefreshRow(row: RefreshRow, state: Refresh | undefined, error: unknown = null): RefreshRow {
  const observed = observeRefreshRows([row], state ? {[row.id]: state} : {})[0];
  if (observed.state?.request && observed.status !== 'refused' && observed.status !== 'unknown') return observed;
  return {...row, state: error ? state ?? null : null, error, status: error ? error instanceof ApiError ? 'refused' : 'unknown' : 'waiting'};
}

/** Each subscription keeps its own checks; a refusal must not stop the other cards. */
export async function requestRefreshAll(
  board: string,
  ids: string[],
  request = requestRefresh,
  current: () => boolean = () => true,
): Promise<RefreshBatch> {
  const queue = [...new Set(ids)];
  const result: RefreshBatch = {total: queue.length, accepted: 0, failures: []};
  let next = 0;
  await Promise.all(Array.from({length: Math.min(4, queue.length)}, async () => {
    while (next < queue.length && current()) {
      const id = queue[next++];
      try {
        await request(board, id);
        result.accepted++;
      } catch (error) {
        result.failures.push({id, error});
      }
    }
  }));
  return result;
}

const refusalTime = (error: unknown, state: Refresh | null) => {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'refresh_too_soon') return state?.retryAt ?? null;
  if (error.code === 'refresh_unavailable') return state?.availableAt ?? null;
  return null;
};

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
