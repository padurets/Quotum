import {useRef, useState} from 'react';
import type {Kind} from '../lib/types';
import {MINUTE, useNow} from '../lib/api';
import {setPrefs, usePrefs} from '../lib/prefs';
import {PERIODS, periodLabel, periodOf, step} from '../lib/periods';
import {goTo, setTimeRange, timeRangeLabel, useTimeRange, type TimeRange} from '../lib/timeRange';
import {t} from '../i18n';
import {Segmented} from './Kit';
import {Popover} from './Popover';

/** Weekly or 5-hour windows. */
function KindSwitch({value, onChange}: {value: Kind; onChange: (kind: Kind) => void}) {
  return (
    <Segmented
      value={value}
      onChange={onChange}
      options={[
        ['weekly', t('history.weekly')],
        ['session', t('history.session')],
      ]}
      label={t('history.kind')}
    />
  );
}

const Arrow = ({back}: {back: boolean}) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d={back ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5'} />
  </svg>
);

const ChevronIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </svg>
);

/**
 * The period of both the chart and the table: one of a list, ending now, or a time range
 * in the past, dragged across the chart or stepped back to with ‹. ‹ and › move either by
 * half its length; › up to now brings the chosen period back, as clearing a range does.
 * The button of the list is named by what it shows. The arrows stand together at the end,
 * where a label of any length leaves them in place for the next click.
 */
function PeriodSwitch({historyStart}: {historyStart: number}) {
  const {range} = usePrefs();
  const selected = useTimeRange();
  const now = useNow(MINUTE);
  const [open, setOpen] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  // A choice closes the list, or takes away the range's own button: focus goes to the list's button.
  const refocus = () => requestAnimationFrame(() => group.current?.querySelector<HTMLButtonElement>('.picker > button')?.focus());
  const choose = (id: string) => {
    setOpen(false);
    if (selected) setTimeRange(null);
    setPrefs({range: id});
    refocus();
  };
  const back = step(selected, range, -1, now, historyStart);
  const forward = step(selected, range, 1, now, historyStart);
  // An arrow that has taken the chart as far as it goes turns off, and focus would fall to
  // the page: it goes to the list's button instead.
  const go = (next: TimeRange | 'live' | null, direction: -1 | 1) => {
    goTo(next);
    if (next && !step(next === 'live' ? null : next, range, direction, now, historyStart)) refocus();
  };
  return (
    <div className="period" role="group" aria-label={t('history.range')} ref={group}>
      <Popover
        label={t('history.range')}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <span className="period-name">
            <span>{selected ? timeRangeLabel(selected) : periodLabel(periodOf(range))}</span>
            <ChevronIcon />
          </span>
        }
      >
        {PERIODS.map(period => (
          <button key={period.id} type="button" className="popover-row" aria-current={!selected && period.id === range} onClick={() => choose(period.id)}>
            <i className={`check ${!selected && period.id === range ? 'on' : ''}`} />
            <span>{periodLabel(period)}</span>
          </button>
        ))}
        {selected && (
          <div className="popover-section">
            <button
              type="button"
              className="popover-row"
              aria-current
              onClick={() => {
                setOpen(false);
                refocus();
              }}
            >
              <i className="check on" />
              <span>{timeRangeLabel(selected)}</span>
            </button>
          </div>
        )}
      </Popover>
      {selected && (
        <button
          type="button"
          className="icon-button"
          aria-label={t('history.rangeClear')}
          title={t('history.rangeClear')}
          onClick={() => {
            setTimeRange(null);
            refocus();
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
      <button type="button" className="icon-button" aria-label={t('history.back')} title={t('history.back')} disabled={!back} onClick={() => go(back, -1)}>
        <Arrow back />
      </button>
      <button type="button" className="icon-button" aria-label={t('history.forward')} title={t('history.forward')} disabled={!forward} onClick={() => go(forward, 1)}>
        <Arrow back={false} />
      </button>
    </div>
  );
}

/**
 * The head of the board's analytics: the window type and the period that the chart and
 * the table both show. The cards above it are about now and show every window.
 */
export function AnalyticsHead({historyStart}: {historyStart: number}) {
  const {kind} = usePrefs();
  return (
    <div className="analytics-head">
      <h2>{t('analytics.title')}</h2>
      <div className="controls">
        <KindSwitch value={kind} onChange={next => setPrefs({kind: next})} />
        <PeriodSwitch historyStart={historyStart} />
      </div>
    </div>
  );
}
