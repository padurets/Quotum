import {t} from '../i18n';
import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';

export const KEYS_PER_PAGE = 10;

/** Keep the page's slots, including the short final page, while its data changes. */
export function KeyPageContent({loading,rows,series=false,children}:{loading:boolean;rows:number;series?:boolean;children:ReactNode}) {
  const root=useRef<HTMLDivElement>(null),[height,setHeight]=useState(0);
  useLayoutEffect(()=>{
    const element=root.current!;element.inert=loading;
    const slots=element.querySelectorAll<HTMLElement>(':scope > .key-slot');
    if(!slots.length){setHeight(0);return;}
    const first=slots[0].getBoundingClientRect(),second=slots[1]?.getBoundingClientRect();
    const step=second?second.height+second.top-first.bottom:first.height;
    const wanted=first.height+Math.max(0,rows-1)*step;
    setHeight(wanted);
  },[loading,rows,children]);
  const skeletonRow=<div className="popover-row key-placeholder"><i className="switch"/><span>&nbsp;</span><b>&nbsp;</b></div>;
  return <div ref={root} className={`key-page${loading?' is-loading':''}`} aria-busy={loading} style={height?{minHeight:height}:undefined}>
    {children??Array.from({length:rows},(_,index)=>series?<div key={index} className="popover-section key-slot" aria-hidden="true"><div className="popover-title">&nbsp;</div>{skeletonRow}{skeletonRow}</div>:<div key={index} className="popover-row key-slot key-placeholder" aria-hidden="true"><i className="switch"/><span>&nbsp;</span><b>&nbsp;</b></div>)}
  </div>;
}

/** The same compact page arrows in card and chart settings. */
export function KeyPages({page,pages,previous,next,loading=false,onPrevious,onNext}:{page:number;pages:number;previous:boolean;next:boolean;loading?:boolean;onPrevious:()=>void;onNext:()=>void}) {
  return <div className="button-row popover-pad">
    <button type="button" className="icon-button" aria-label={t('money.previous')} title={t('money.previous')} disabled={!previous} aria-disabled={loading||!previous} onClick={()=>{if(!loading)onPrevious();}}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m10 3-5 5 5 5"/></svg></button>
    <span className="page-number">{page} / {pages}</span>
    <button type="button" className="icon-button" aria-label={t('money.next')} title={t('money.next')} disabled={!next} aria-disabled={loading||!next} onClick={()=>{if(!loading)onNext();}}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></button>
  </div>;
}
