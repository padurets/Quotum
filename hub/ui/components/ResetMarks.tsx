import {countdown, stamp} from '../lib/format';
import {freeResetExpiry, type ResetLabel, type ResetStatus} from '../lib/resets';
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

/**
 * What the news is, a detail that sets it apart (a chance, a scope) and when: the panel's
 * head, a part of it each, never run together into one line.
 */
function headline(label: ResetLabel, now: number): {what: string; detail: string; when: string} {
  switch (label.key) {
    case 'in':
    case 'bankedIn':
      return {what: t(`reset.${label.key}`, {time: countdown(label.at - now)}), detail: '', when: stamp(label.at)};
    case 'announced':
      return {what: t('reset.announced'), detail: '', when: ''};
    case 'awaiting':
      return {what: t('reset.awaiting'), detail: '', when: stamp(label.at)};
    case 'possible':
      return {what: t('reset.possible'), detail: label.chance !== null ? `${label.chance}%` : '', when: label.at !== null ? t('reset.until', {time: stamp(label.at)}) : ''};
    case 'done':
      return {what: t('reset.done'), detail: label.scope, when: stamp(label.event.at)};
    case 'policy':
      return {what: t('reset.policy'), detail: '', when: stamp(label.event.at)};
  }
}

/** The same in plain text, for the mark's name and tooltip: a line each. */
const nameOf = ({what, detail, when}: ReturnType<typeof headline>) => [detail ? `${what} (${detail})` : what, when].filter(Boolean).join('\n');

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
  const head = headline(label, now);
  const text = markText(label, now);
  const hint = label.tone === 'accent' ? t('reset.hintScheduled') : label.key === 'possible' ? t('reset.hintWatch') : '';
  return (
    <Popover
      label={nameOf(head)}
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
        <div className="tray-panel-head">
          <p className="tray-panel-lead">
            {head.what}
            {head.detail && <span className="tray-panel-tag">{head.detail}</span>}
          </p>
          {head.when && <p className="tray-panel-when">{head.when}</p>}
        </div>
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
 * When free resets expire, a line each: all of them at one time is said once; how many
 * expire when, when they differ; from an older agent, when the first one does.
 */
function expiryLines(resets: NonNullable<SourceState['resets']>): string[] {
  const expiry = freeResetExpiry(resets);
  if (!expiry) return [];
  if (expiry.kind === 'first') return [t('card.freeResetsFirst', {date: stamp(expiry.at)})];
  const [only] = expiry.groups;
  if (expiry.groups.length === 1) return only.expiresAt !== null ? [t('card.freeResetsUntil', {date: stamp(only.expiresAt)})] : [];
  return expiry.groups.map(group =>
    group.expiresAt !== null ? t('card.freeResetsBy', {count: group.count, date: stamp(group.expiresAt)}) : t('card.freeResetsNoDate', {count: group.count}),
  );
}

/**
 * Free resets of the limits the account holds, in the tray by the agents: what the card
 * has now. A ticket, so it never reads as the news of a reset for everyone.
 */
export function FreeResets({resets}: {resets: NonNullable<SourceState['resets']>}) {
  const count = t('card.freeResets', {count: resets.available});
  const lines = expiryLines(resets);
  const label = [count, ...lines].join('\n');
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
        <div className="tray-panel-head">
          <p className="tray-panel-lead">{count}</p>
          {lines.map(line => (
            <p key={line} className="tray-panel-when">
              {line}
            </p>
          ))}
        </div>
      </div>
    </Popover>
  );
}
