import type {Kind} from '../lib/types';
import {setPrefs, usePrefs} from '../lib/prefs';
import {setTimeRange, timeRangeLabel, useTimeRange} from '../lib/timeRange';
import {t} from '../i18n';
import {Segmented} from './Kit';

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

const PERIODS = ['24h', '7d', '30d'];

/**
 * The last 24 hours, 7 or 30 days, and a time range selected on the chart when there is
 * one: it is the period of both the chart and the table until it is cleared or a fixed
 * period is chosen.
 */
function PeriodSwitch({value, onChange}: {value: string; onChange: (range: string) => void}) {
  const selected = useTimeRange();
  const choose = (range: string) => {
    if (selected) setTimeRange(null);
    onChange(range);
  };
  return (
    <div className="segmented" role="group" aria-label={t('history.range')}>
      {PERIODS.map(range => (
        <button key={range} type="button" aria-pressed={!selected && range === value} onClick={() => choose(range)}>
          {range === '24h' ? t('history.hours', {count: 24}) : t('history.days', {count: parseInt(range)})}
        </button>
      ))}
      {selected && (
        <button type="button" className="segmented-range" aria-pressed="true" title={t('history.rangeClear')} onClick={() => setTimeRange(null)}>
          {timeRangeLabel(selected)}
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * The head of the board's analytics: the window type and the period that the chart and
 * the table both show. The cards above it are about now and show every window.
 */
export function AnalyticsHead() {
  const {kind, range} = usePrefs();
  return (
    <div className="analytics-head">
      <h2>{t('analytics.title')}</h2>
      <div className="controls">
        <KindSwitch value={kind} onChange={next => setPrefs({kind: next})} />
        <PeriodSwitch value={range} onChange={next => setPrefs({range: next})} />
      </div>
    </div>
  );
}
