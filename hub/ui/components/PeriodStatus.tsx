import type {PeriodBasis} from '../../server/domain/period';
import {timeRangeLabel} from '../lib/timeRange';
import {boardPeriod} from '../lib/period';
import {t} from '../i18n';

/** Retained numbers keep their own label until the requested interval is complete. */
export function PeriodStatus({basis,loading,error}:{basis:PeriodBasis|null;loading:boolean;error:string|null}) {
  if(!loading&&!error)return null;
  return <div className="period-status" role="status">
    {basis&&<span>{timeRangeLabel(basis.range)}</span>}
    <span>{t(error==='history_limit'?'period.limit':error?'period.failed':'period.loading')}</span>
    {error&&<button type="button" className="link-button" onClick={boardPeriod.retry}>{t('period.retry')}</button>}
  </div>;
}
