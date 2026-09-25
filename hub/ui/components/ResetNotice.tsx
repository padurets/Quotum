import {duration, soon, stamp} from '../lib/format';
import {resetLabel, type ResetStatus} from '../lib/resets';
import {t} from '../i18n';

function Credit({status}: {status: ResetStatus}) {
  return (
    <a className="reset-credit" href={status.credit.url} target="_blank" rel="noopener noreferrer" title={t('reset.credit', {name: status.credit.name})}>
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
  const label = resetLabel(status, now);
  if (!status || label?.kind !== 'banner') return null;
  const {event, at} = label;
  const upcoming = at !== null && at > now;

  const lead =
    label.key === 'possible'
      ? `${t('reset.possible')}${label.chance !== null ? ` · ${label.chance}%` : ''}`
      : label.key === 'in' || label.key === 'bankedIn'
        ? t(`reset.${label.key}`, {time: duration(at! - now, true)})
        : t(`reset.${label.key}`);
  const when = at !== null && upcoming ? soon(at, now) : '';
  const scheduled = label.key !== 'possible';
  const hint = [t(scheduled ? 'reset.hintScheduled' : 'reset.hintWatch'), at !== null ? t('reset.until', {time: stamp(at)}) : '', event.text].filter(Boolean).join('. ');

  return (
    <div
      className={`reset-notice reset-announce ${scheduled ? 'is-scheduled' : 'is-watch'}`}
      title={hint}
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
  const label = resetLabel(status, now);
  if (!status || label?.kind !== 'notice') return null;
  const {event, key} = label;
  const detail = key === 'done' ? [stamp(event.at), label.scope].filter(Boolean).join(' · ') : stamp(event.at);

  return (
    <div className={`reset-notice is-${key}`} title={event.text}>
      <i className="reset-dot" />
      <a href={event.url} target="_blank" rel="noopener noreferrer">
        {t(`reset.${key}`)}
        <span> · {detail}</span>
      </a>
      <Credit status={status} />
    </div>
  );
}
