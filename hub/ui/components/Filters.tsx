import {useRef,useState,type ReactNode} from 'react';
import {ChevronDown,X} from 'lucide-react';
import {t,type Key} from '../i18n';
import {Popover} from './Popover';

/** Status and reset keep their space, so editing a filter never moves its menu. */
export function FilterPopover({label,count,capacity=0,changed,onReset,children,open,onOpenChange,width}:{label:Key;count?:number;capacity?:number;changed:boolean;onReset:()=>void;children:ReactNode;open?:boolean;onOpenChange?:(open:boolean)=>void;width?:number}){
  const root=useRef<HTMLDivElement>(null);
  return <div className="filter-control" data-filter={label} ref={root}>
    <Popover label={t(label)} trigger={<span className="filter-trigger"><span>{t(label)}</span>
      {count!==undefined?<span className={`filter-count${count?'':' is-empty'}`} data-space={`−${capacity}`} aria-label={count?t('filters.excludedCount',{count}):undefined} aria-hidden={!count}><span>−{count}</span></span>:
        <i className={`filter-changed${changed?'':' is-empty'}`} aria-hidden="true"/>}
    </span>} open={open} onOpenChange={onOpenChange} width={width}>{children}</Popover>
    <button type="button" className={`icon-button filter-reset${changed?'':' is-empty'}`} disabled={!changed} title={t('filters.showAll',{filter:t(label)})} aria-label={t('filters.showAll',{filter:t(label)})} onClick={()=>{root.current?.querySelector('button')?.focus({preventScroll:true});onReset();}}><X size={13}/></button>
  </div>;
}

/** Every on/off filter uses the same trailing switch, including group headings. */
export function FilterRow({on,onChange,children,value,className='',disabled}:{on:boolean;onChange:(on:boolean)=>void;children:ReactNode;value?:string;className?:string;disabled?:boolean}){
  return <button type="button" className={`popover-row filter-row ${className}`} role="switch" aria-checked={on} disabled={disabled} onClick={()=>onChange(!on)}>
    <span>{children}</span>{value!==undefined&&<b>{value}</b>}<i className={`switch ${on?'on':''}`} aria-hidden="true"/>
  </button>;
}

export function FilterChoice({selected,onSelect,children}:{selected:boolean;onSelect:()=>void;children:ReactNode}){
  return <button type="button" className="popover-row filter-row" aria-pressed={selected} onClick={onSelect}><span>{children}</span><i className={`check ${selected?'on':''}`} aria-hidden="true"/></button>;
}

/** The disclosure and switch are siblings: neither control activates the other. */
export function FilterGroup({label,icon,on,onChange,hidden,children}:{label:string;icon:ReactNode;on:boolean;onChange:(on:boolean)=>void;hidden?:boolean;children?:((expanded:boolean)=>ReactNode)}){
  const [expanded,setExpanded]=useState(false),[visited,setVisited]=useState(false);
  const heading=<>{children&&<ChevronDown size={14}/>} {icon}<span>{label}</span></>;
  return <div className={`filter-group${on?'':' is-off'}`} hidden={hidden}>
    <FilterRow className="filter-group-toggle" on={on} onChange={onChange}><span className="sr-only">{label}</span></FilterRow>
    {children?<details open={on&&expanded} onToggle={event=>{const next=event.currentTarget.open;setExpanded(next);if(next)setVisited(true);}}>
      <summary className="popover-row filter-group-heading" aria-disabled={!on} onClick={event=>{if(!on)event.preventDefault();}}>{heading}</summary>
      {visited&&<div className="filter-group-items">{children(on&&expanded)}</div>}
    </details>:<div className="popover-row filter-group-heading">{heading}</div>}
  </div>;
}
