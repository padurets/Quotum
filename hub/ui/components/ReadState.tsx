/** @jsxRuntime automatic */
import type {ReactNode} from 'react';
import {t} from '../i18n';
import {timeRangeLabel,type TimeRange} from '../lib/timeRange';
import {Popover} from './Popover';
import {useRemovalFocus} from './focusReturn';

/** Reader evidence and recovery live in existing chrome, never above the data. */
export function ReadState({loading=false,error,range,retained=false,retry,children}:{loading?:boolean;error?:string|null;range?:TimeRange|null;retained?:boolean;retry:()=>void;children?:ReactNode}) {
  const scope=useRemovalFocus<HTMLSpanElement>(),action=useRemovalFocus<HTMLButtonElement>();
  if(!loading&&!error&&!retained&&!children)return null;
  const label=t(error==='filters_limit'?'api.filters_limit':error==='history_limit'?'period.limit':error?'period.failed':loading?'period.loading':'analytics.details');
  return <span className="reader-state" ref={scope}><Popover label={label} icon={<span className={error?'reader-error':'reader-pending'} aria-hidden="true">{error?'!':'○'}</span>}>
    <div className="popover-body">
      {(loading||error)&&<p>{label}</p>}
      {range&&<p>{t('analytics.retainedRange',{range:timeRangeLabel(range)})}</p>}
      {children}
      {error&&error!=='filters_limit'&&<button ref={action} type="button" className="button" onClick={retry}>{t('period.retry')}</button>}
    </div>
  </Popover></span>;
}
