import type {ReactNode} from 'react';
import {level} from '../lib/quota';

/** Subscription windows and money caps use the same segmented meter. */
export function MeterBar({remaining,label,children}:{remaining:number|null;label:string;children?:ReactNode}) {
  return <div className="meter" role={remaining===null?undefined:'progressbar'} aria-label={label}
    aria-valuenow={remaining===null?undefined:Math.round(remaining)} aria-valuemin={remaining===null?undefined:0} aria-valuemax={remaining===null?undefined:100}>
    <span className="meter-track">{remaining!==null&&<i className={`fill fill-${level(remaining)}`} style={{width:`${Math.max(remaining,1)}%`}}/>}</span>
    {children}
  </div>;
}
