import {countdown, day, stamp} from '../lib/format';
import type {ResetLabel, ResetStatus} from '../lib/resets';
import type {SourceState} from '../lib/types';
import {rich, t} from '../i18n';
import {Popover} from './Popover';

/**
 * One shape for each kind of news, so the marks differ without their colour: an announced
 * reset is two arrows round a circle, a possible one the same dashed, one that happened an
 * arrow round a tick, a change of limits a gauge.
 */
function NewsIcon({label}: {label: ResetLabel}) {
  return (
    <svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      {label.key === 'done' ? (
        <path d="M20 14.5a8.5 8.5 0 1 1-1.9-8.9L21 8.5M21 3.5v5h-5M8.5 12.5l2.5 2.5 4.5-5" />
      ) : label.key === 'policy' ? (
        <path d="M3.5 17.5a8.5 8.5 0 0 1 17 0M12 17.5l4-5.5" />
      ) : (
        <path
          d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"
          strokeDasharray={label.key === 'possible' ? '3 3.4' : undefined}
        />
      )}
    </svg>
  );
}

/** What the news is and when, in full: the mark's name and the panel's first line. */
function headline(label: ResetLabel, now: number) {
  switch (label.key) {
    case 'in':
    case 'bankedIn':
      return `${t(`reset.${label.key}`, {time: countdown(label.at - now)})} · ${stamp(label.at)}`;
    case 'announced':
      return t('reset.announced');
    case 'awaiting':
      return `${t('reset.awaiting')} · ${stamp(label.at)}`;
    case 'possible':
      return [t('reset.possible'), label.chance !== null ? `${label.chance}%` : '', label.at !== null ? t('reset.until', {time: stamp(label.at)}) : '']
        .filter(Boolean)
        .join(' · ');
    case 'done':
      return [t('reset.done'), stamp(label.event.at), label.scope].filter(Boolean).join(' · ');
    case 'policy':
      return `${t('reset.policy')} · ${stamp(label.event.at)}`;
  }
}

/** Only numbers make it onto the mark: how soon an announced reset comes, or how likely a possible one is. */
function markText(label: ResetLabel, now: number) {
  if (label.key === 'in' || label.key === 'bankedIn') return t('reset.mark', {time: countdown(label.at - now)});
  if (label.key === 'possible' && label.chance !== null) return `${label.chance}%`;
  return null;
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * News about resets for everyone, on the left of a card's tray: a mark that changes how
 * the remaining quota should be spent, in the accent colour while a reset is announced.
 * Its panel tells what and when, the tracker's words, where they come from and whose
 * data it is: the trackers are credited wherever their data is shown.
 */
export function ResetMark({label, credit, now}: {label: ResetLabel; credit: ResetStatus['credit']; now: number}) {
  const title = headline(label, now);
  const text = markText(label, now);
  const hint = label.tone === 'accent' ? t('reset.hintScheduled') : label.key === 'possible' ? t('reset.hintWatch') : '';
  return (
    <Popover
      label={title}
      triggerClass={`tray-pill reset-mark is-${label.tone}`}
      up
      align="left"
      trigger={
        <>
          <NewsIcon label={label} />
          {text && <span>{text}</span>}
        </>
      }
    >
      <div className="tray-panel">
        <p className="tray-panel-lead">{title}</p>
        {hint && <p>{hint}</p>}
        {label.event.text && <p className="tray-panel-quote">{label.event.text}</p>}
        <p className="tray-panel-links">
          {label.link && (
            <span>
              {rich('reset.source', {
                link: (
                  <a href={label.link} target="_blank" rel="noopener noreferrer">
                    {host(label.link)}
                  </a>
                ),
              })}
            </span>
          )}
          <span>
            {rich('reset.credit', {
              name: (
                <a href={credit.url} target="_blank" rel="noopener noreferrer">
                  {credit.name}
                </a>
              ),
            })}
          </span>
        </p>
      </div>
    </Popover>
  );
}

const TicketIcon = () => (
  <svg className="tray-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path d="M4 6h16a1 1 0 0 1 1 1v2.5a2.5 2.5 0 0 0 0 5V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2.5a2.5 2.5 0 0 0 0-5V7a1 1 0 0 1 1-1Z" />
    <path d="M14.5 6.5v11" strokeDasharray="2 2.5" />
  </svg>
);

/**
 * Free resets of the limits the account holds, in the tray by the agents: what the card
 * has now. A ticket, so it never reads as the news of a reset for everyone.
 */
export function FreeResets({resets}: {resets: NonNullable<SourceState['resets']>}) {
  const label = [t('card.freeResets', {count: resets.available}), resets.expiresAt ? t('card.freeResetsUntil', {date: day(resets.expiresAt)}) : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <Popover
      label={label}
      triggerClass="tray-pill"
      up
      trigger={
        <>
          <TicketIcon />
          <b>{resets.available}</b>
        </>
      }
    >
      <div className="tray-panel">
        <p className="tray-panel-lead">{label}</p>
      </div>
    </Popover>
  );
}
