import React from 'react';
import {duration, soon, stamp} from '../lib/format';
import type {ResetStatus} from '../lib/resets';

const RECENT_RESET_MS = 48 * 3_600_000;
const RECENT_POLICY_MS = 72 * 3_600_000;

function Credit({status}: {status: ResetStatus}) {
  return (
    <a className="reset-credit" href={status.credit.url} target="_blank" rel="noopener noreferrer" title={`Data from ${status.credit.name}`}>
      {status.credit.name}
    </a>
  );
}

/**
 * An announced or possible out-of-schedule reset: it changes how the remaining quota
 * should be spent, so it is highlighted in the accent colour — one line at the bottom of
 * the card, on the card's own background.
 */
export function ResetBanner({status, now}: {status: ResetStatus | undefined; now: number}) {
  const event = status?.scheduled ?? status?.watch;
  if (!status || !event) return null;
  const scheduled = status.scheduled;
  const at = scheduled ? scheduled.scheduledFor : status.watch!.expiresAt;
  const upcoming = at !== null && at > now;

  const lead = scheduled
    ? upcoming
      ? `${scheduled.kind === 'banked' ? 'Сброс из запаса' : 'Сброс'} через ${duration(at! - now, true)}`
      : at === null
        ? 'Объявлен сброс'
        : 'Сброс: ждём подтверждения'
    : `Возможен сброс${status.watch!.chance !== null ? ` · ${status.watch!.chance}%` : ''}`;
  const when = at !== null && upcoming ? soon(at, now) : '';
  const hint = [scheduled ? 'Объявлен внеплановый сброс' : 'Возможен внеплановый сброс', at !== null ? `до ${stamp(at)}` : '', event.text].filter(Boolean).join('. ');

  return (
    <div
      className={`reset-notice reset-announce ${scheduled ? 'is-scheduled' : 'is-watch'}`}
      title={status.preview ? `Пример (?preview=reset). ${hint}` : hint}
    >
      <svg className="reset-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5" />
      </svg>
      <a className="reset-main" href={event.url} target="_blank" rel="noopener noreferrer">
        <b>{lead}</b>
        {when && <span> · {when}</span>}
      </a>
      <Credit status={status} />
    </div>
  );
}

/** A reset that just happened, or a recent change of limits: one quiet line at the bottom. */
export function ResetNotice({status, now}: {status: ResetStatus | undefined; now: number}) {
  if (!status || status.scheduled || status.watch) return null;
  const {latest, policy} = status;
  let label: string;
  let detail: string;
  let event;
  let tone: string;
  if (latest && now - latest.at < RECENT_RESET_MS) {
    [label, event, tone] = ['Сброс прошёл', latest, 'done'];
    detail = [stamp(latest.at), latest.scope && latest.scope !== 'all' ? latest.scope : ''].filter(Boolean).join(' · ');
  } else if (policy && now - policy.at < RECENT_POLICY_MS) {
    [label, event, tone, detail] = ['Изменены лимиты', policy, 'policy', stamp(policy.at)];
  } else return null;

  return (
    <div className={`reset-notice is-${tone}`} title={event.text}>
      <i className="reset-dot" />
      <a href={event.url} target="_blank" rel="noopener noreferrer">
        {label}
        <span> · {detail}</span>
      </a>
      <Credit status={status} />
    </div>
  );
}
