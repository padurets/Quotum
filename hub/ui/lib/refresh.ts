import {countdown, countdownChangesAt, earliest, stamp} from './format';
import {known, t} from '../i18n';
import type {Refresh} from './types';
import {ApiError, messageOf} from './http';

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
