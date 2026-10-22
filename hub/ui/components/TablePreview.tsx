/** @jsxRuntime automatic */
import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {Popover} from './Popover';
import {t} from '../i18n';

/** A bounded row preview retains its complete, accessible contents beside the cell.
 * A timed compact cell owns the wrapper as well as the text inside it. */
export function TablePreview({children,label,details,still=false,time}:{children:ReactNode;label:string;details?:ReactNode;still?:boolean;time?:string}) {
  const box=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null),[overflow,setOverflow]=useState(false);
  const semantic=!!details,[portal,setPortal]=useState<HTMLElement|null>(null);
  useLayoutEffect(()=>{
    if(semantic&&!still)setPortal(box.current?.closest<HTMLElement>('.panel,.dialog')??null);
  },[semantic,still]);
  useLayoutEffect(()=>{
    if(still)return;
    const measure=()=>{
      const node=content.current;if(!node)return;
      if(!node.clientHeight||!node.clientWidth){setOverflow(false);return;}
      setOverflow([node,...node.querySelectorAll<HTMLElement>('*')].some(part=>!part.closest('.sr-only')&&part.clientHeight>0&&part.clientWidth>0&&(part.scrollHeight>part.clientHeight+1||part.scrollWidth>part.clientWidth+1)));
    };
    measure();const observer=new ResizeObserver(measure);if(content.current)observer.observe(content.current);return()=>observer.disconnect();
  },[children,still]);
  return <div ref={box} data-time={time} className={`table-preview${overflow||details?' has-detail':''}${details?' has-semantic':''}`}>
    <div ref={content} className="table-preview-content">{details&&!still?<Popover label={t('table.details',{name:label})} trigger={children} triggerClass="table-preview-value" portal={portal??box.current?.closest<HTMLElement>('.panel,.dialog')}><div className="popover-body table-cell-details">{details}</div></Popover>:children}</div>
    {overflow&&!details&&!still&&<Popover label={t('table.details',{name:label})} trigger="…" triggerClass="table-preview-trigger" portal={portal??box.current?.closest<HTMLElement>('.panel,.dialog')}><div className="popover-body table-cell-details">{children}</div></Popover>}
  </div>;
}
