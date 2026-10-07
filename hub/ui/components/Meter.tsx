import type {ReactNode} from 'react';
import {level,resetLine} from '../lib/quota';
import {num,duration,stamp} from '../lib/format';
import {t} from '../i18n';

/** Subscription windows and money caps use the same segmented meter. */
export function MeterBar({remaining,label,children}:{remaining:number|null;label:string;children?:ReactNode}) {
  return <div className="meter" role={remaining===null?undefined:'progressbar'} aria-label={label}
    aria-valuenow={remaining===null?undefined:Math.round(remaining)} aria-valuemin={remaining===null?undefined:0} aria-valuemax={remaining===null?undefined:100}>
    <span className="meter-track">{remaining!==null&&<i className={`fill fill-${level(remaining)}`} style={{width:`${Math.max(remaining,1)}%`}}/>}</span>
    {children}
  </div>;
}

/** The wording and position of a subscription reset are independent of its provider. */
export function ResetText({resetAt,now,short=false}:{resetAt:number|null;now:number;short?:boolean}) {
  const reset=resetLine({resetAt},now);
  if(short&&reset.key!=='resetsIn')return null;
  const text=reset.key==='resetsIn'?t('limit.resetsIn',{time:duration(reset.inMs)}):t(`limit.${reset.key}`),date=resetAt?stamp(resetAt):'';
  return <span data-time="reset" title={short?[text,date].filter(Boolean).join('\n'):date} aria-label={short?text:undefined}>
    {short&&reset.key==='resetsIn'?duration(reset.inMs):text}
  </span>;
}

/** Every subscription uses the same remaining-percent row in both board views. */
export function PercentLimit({name,remaining,reset,note,status,valueTitle,compact=false,children}:{name:string;remaining:number|null;reset:ReactNode;note?:ReactNode;status?:ReactNode;valueTitle?:string;compact?:boolean;children?:ReactNode}) {
  const label=status?<span className="cap-label"><span>{name}</span>{status}</span>:name;
  const value=remaining===null?'—':num(remaining),tone=remaining===null?'ok':level(remaining);
  const bar=<MeterBar remaining={remaining} label={name.replaceAll(' · ','\n')}>{children}</MeterBar>;
  if(compact)return <div className="compact-limit">
    <div className="compact-window-name"><span title={name.replaceAll(' · ','\n')}>
      {status?label:name.split(' · ').map((part,i)=><span key={i}>{part}</span>)}
    </span></div>
    <small className="compact-reset">{reset}</small>{bar}
    <strong className={`v-${tone}`} title={valueTitle}>{value}{remaining!==null&&'%'}</strong>
  </div>;
  return <div className="limit">
    <div className="limit-top"><span className="limit-name">{label}</span>
      <span className={`limit-value v-${tone}`} title={valueTitle}>{value}{remaining!==null&&<small>%</small>}</span>
    </div>{bar}<div className="limit-bottom">{reset}{note}</div>
  </div>;
}
