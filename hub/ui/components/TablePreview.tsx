/** @jsxRuntime automatic */
import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {Popover} from './Popover';
import {t} from '../i18n';

/** A bounded row preview retains its complete, accessible contents beside the cell. */
export function TablePreview({children,label,still=false}:{children:ReactNode;label:string;still?:boolean}) {
  const box=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null),[overflow,setOverflow]=useState(false);
  useLayoutEffect(()=>{
    if(still)return;
    const measure=()=>{
      const node=content.current;if(!node)return;
      if(!node.clientHeight||!node.clientWidth){setOverflow(false);return;}
      setOverflow([node,...node.querySelectorAll<HTMLElement>('*')].some(part=>part.clientHeight>0&&part.clientWidth>0&&(part.scrollHeight>part.clientHeight+1||part.scrollWidth>part.clientWidth+1)));
    };
    measure();const observer=new ResizeObserver(measure);if(content.current)observer.observe(content.current);return()=>observer.disconnect();
  },[children,still]);
  return <div ref={box} className={`table-preview${overflow?' has-detail':''}`}>
    <div ref={content} className="table-preview-content">{children}</div>
    {overflow&&!still&&<Popover label={t('table.details',{name:label})} trigger="…" triggerClass="table-preview-trigger" portal={box.current?.closest<HTMLElement>('.panel,.dialog')}><div className="popover-body table-cell-details">{children}</div></Popover>}
  </div>;
}
