import {useRef, useState, useSyncExternalStore} from 'react';
import type {Kind} from '../lib/types';
import {HORIZONS, setPrefs, usePrefs} from '../lib/prefs';
import {PERIODS, periodLabel, periodOf, step, stepChangesAt} from '../lib/periods';
import {goTo, setTimeRange, timeRangeLabel, useTimeRange, type TimeRange} from '../lib/timeRange';
import {hubNow, useClock} from '../lib/clock';
import {useHistoryBegins} from '../lib/history';
import {QUOTA_WIDGETS, ACTIVITY, QUOTA_HISTORY, BUDGET_HISTORY, SUBSCRIPTION_FUNDS} from '../../server/domain/widgets';
import {t, useLocale} from '../i18n';
import {pan} from '../lib/pan';
import {Segmented} from './Kit';
import {Popover} from './Popover';

/** Weekly or 5-hour windows. */
function KindSwitch() {
  const {kind} = usePrefs();
  return (
    <Segmented
      value={kind}
      onChange={next => setPrefs({kind: next as Kind})}
      options={[
        ['weekly', t('history.weekly')],
        ['session', t('history.session')],
      ]}
      label={t('history.kind')}
    />
  );
}

/** The same filter is available beside either member of the quota pair. */
export function QuotaSettings() {
  return <div className="popover-section">
    <div className="popover-title">{t('history.kind')}</div>
    <div className="popover-pad"><KindSwitch /></div>
  </div>;
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

/** Subscribe to the words shown, so unchanged dates do not interrupt strip preparation. */
function PeriodName({selected, range}: {selected: TimeRange | null; range: string}) {
  const locale = useLocale();
  const caption = useRef<{frame: ReturnType<typeof pan.get>; locale: typeof locale; label: string | null} | null>(null);
  const preview = useSyncExternalStore(pan.subscribe, () => {
    const frame = pan.get();
    if (!caption.current || caption.current.frame !== frame || caption.current.locale !== locale) caption.current = {frame, locale, label: frame ? timeRangeLabel(frame) : null};
    return caption.current.label;
  }, () => null);
  return <span>{preview ?? (selected ? timeRangeLabel(selected) : periodLabel(periodOf(range)))}</span>;
}

/**
 * The viewing period of the whole board: one of a list,
 * ending now, or a time range in the past, dragged across a chart or stepped back to with
 * ‹. ‹ and › move either by half its length; › up to now brings the chosen period back,
 * as clearing a range does.
 * The button of the list is named by what it shows. The arrows stand together at the end,
 * where a label of any length leaves them in place for the next click. Where they go is
 * reckoned at the click; the clock renders them only when ‹ turns on or off.
 */
function PeriodSwitch({historyStart}: {historyStart: number}) {
  const {range} = usePrefs();
  const selected = useTimeRange();
  const now = useClock(now => stepChangesAt(selected, range, now, historyStart));
  const [open, setOpen] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  // A choice closes the list, or takes away the range's own button: focus goes to the list's button.
  const refocus = () => requestAnimationFrame(() => group.current?.querySelector<HTMLButtonElement>('.picker > button')?.focus());
  const choose = (id: string) => {
    pan.cancel();
    setOpen(false);
    if (selected) setTimeRange(null);
    setPrefs({range: id});
    refocus();
  };
  const back = step(selected, range, -1, now, historyStart);
  const forward = step(selected, range, 1, now, historyStart);
  // An arrow that has taken the chart as far as it goes turns off, and focus would fall to
  // the page: it goes to the list's button instead.
  const go = (direction: -1 | 1) => {
    pan.cancel();
    const at = hubNow();
    const next = step(selected, range, direction, at, historyStart);
    goTo(next);
    if (next && !step(next === 'live' ? null : next, range, direction, at, historyStart)) refocus();
  };
  return (
    <div className="period" role="group" aria-label={t('history.range')} ref={group} data-time="period">
      <Popover
        label={t('history.range')}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <span className="period-name">
            <PeriodName selected={selected} range={range} />
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
            pan.cancel();
            setTimeRange(null);
            refocus();
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
      <button type="button" className="icon-button" aria-label={t('history.back')} title={t('history.back')} disabled={!back} onClick={() => go(-1)}>
        <Arrow back />
      </button>
      <button type="button" className="icon-button" aria-label={t('history.forward')} title={t('history.forward')} disabled={!forward} onClick={() => go(1)}>
        <Arrow back={false} />
      </button>
    </div>
  );
}

/** Only controls shared across widgets belong above the board. */
export function AnalyticsHead({widgets}: {widgets: string[]}) {
  const {horizon} = usePrefs();
  const historyStart = useHistoryBegins();
  const quota = QUOTA_WIDGETS.some(id=>widgets.includes(id));
  const charts = [ACTIVITY,QUOTA_HISTORY,BUDGET_HISTORY,SUBSCRIPTION_FUNDS].some(id=>widgets.includes(id));
  const horizonName = (value: typeof horizon) => value === 'auto' ? t('history.horizonAuto') : t('history.daysShort', {count: parseInt(value)});
  return (
    <div className="analytics-head">
      <PeriodSwitch historyStart={historyStart} />
      <div className="controls">
        {quota && <KindSwitch />}
        {charts && <Popover label={t('history.horizon')} trigger={<span className="period-name">{t('history.horizon')}: {horizonName(horizon)}<ChevronIcon /></span>}>
          <div className="popover-section">
            <div className="popover-title">{t('history.horizon')}</div>
            <div className="popover-pad"><Segmented value={horizon} onChange={horizon => setPrefs({horizon})} options={HORIZONS.map(h => [h, horizonName(h)])} label={t('history.horizon')} /></div>
          </div>
        </Popover>}
      </div>
    </div>
  );
}
