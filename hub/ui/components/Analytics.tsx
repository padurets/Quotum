import {useRef, useState, useSyncExternalStore} from 'react';
import type {Kind} from '../lib/types';
import {HORIZONS, setPrefs, usePrefs} from '../lib/prefs';
import {PERIODS, periodLabel, periodOf, step, stepChangesAt} from '../lib/periods';
import {goTo, setTimeRange, timeRangeLabel, useTimeRange, type TimeRange} from '../lib/timeRange';
import {hubNow, useClock} from '../lib/clock';
import {useBudgetHistory, useHistoryBegins} from '../lib/history';
import {useNamed} from '../lib/board';
import type {Arrange} from '../lib/view';
import {QUOTA_WIDGETS, BUDGET_WIDGETS, ACTIVITY, QUOTA_HISTORY, BUDGET_HISTORY, SUBSCRIPTION_FUNDS} from '../../server/domain/widgets';
import {t, useLocale} from '../i18n';
import {pan} from '../lib/pan';
import {Segmented} from './Kit';
import {Popover, SlidersIcon} from './Popover';
import {MoneySettings,FundsSettings} from './MoneySettings';

/** Weekly or 5-hour windows. */
function KindSwitch({value, onChange}: {value: string; onChange: (kind: string) => void}) {
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
 * The period of the analytics (agent activity, the chart and the table): one of a list,
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

function BudgetFilters({arrange}: {arrange: Arrange}) {
  const prefs = usePrefs(), sources = useNamed(arrange.view.names,'budget'), {history} = useBudgetHistory();
  return <>
    <div className="popover-title">{t('widgets.budgetHistory')}</div>
    <div className="popover-pad"><Segmented value={prefs.money.view} onChange={view=>setPrefs({money:{...prefs.money,view}})} options={[["balance",t('money.balance')],["spending",t('money.spending')]]} label={t('money.value')}/></div>
    <MoneySettings sources={sources} hidden={arrange.view.hidden} series={history?.meterSeries ?? []}/>
  </>;
}

function FundsFilters({arrange}: {arrange:Arrange}) {
  const sources=useNamed(arrange.view.names,'funds');
  return <><div className="popover-title">{t('widgets.subscriptionFunds')}</div><FundsSettings sources={sources} hidden={arrange.view.hidden}/></>;
}

/** Shared filters stay accessible when either member of their widget pair is hidden. */
export function AnalyticsHead({arrange, widgets}: {arrange: Arrange; widgets: string[]}) {
  const prefs=usePrefs(),{kind}=prefs, [open,setOpen] = useState(false);
  const historyStart = useHistoryBegins();
  const quota = QUOTA_WIDGETS.some(id=>widgets.includes(id)), budget = BUDGET_WIDGETS.some(id=>widgets.includes(id));
  const funds=widgets.includes(SUBSCRIPTION_FUNDS);
  const charts = [ACTIVITY,QUOTA_HISTORY,BUDGET_HISTORY,SUBSCRIPTION_FUNDS].some(id=>widgets.includes(id));
  return (
    <div className="analytics-head">
      <PeriodSwitch historyStart={historyStart} />
      <div className="controls">
        {(quota || budget || funds || charts) && <Popover label={t('board.filters')} icon={<SlidersIcon/>} open={open} onOpenChange={setOpen}>
          {quota && <div className="popover-section"><div className="popover-title">{t('history.kind')}</div><div className="popover-pad"><KindSwitch value={kind} onChange={next => setPrefs({kind:next as Kind})}/></div></div>}
          {budget && open && <div className="popover-section"><BudgetFilters arrange={arrange}/></div>}
          {funds && open && <div className="popover-section"><FundsFilters arrange={arrange}/></div>}
          {(quota || budget || funds || charts) && <div className="popover-section"><div className="popover-title">{t('history.horizon')}</div><div className="popover-pad"><Segmented value={prefs.horizon} onChange={horizon=>setPrefs({horizon})} options={HORIZONS.map(h=>[h,h==='auto'?t('history.horizonAuto'):t('history.daysShort',{count:parseInt(h)})])} label={t('history.horizon')}/></div></div>}
        </Popover>}
      </div>
    </div>
  );
}
