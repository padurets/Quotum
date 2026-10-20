import {useRef,useState,type ReactNode} from 'react';
import {ChevronDown,CircleHelp,X} from 'lucide-react';
import {t,type Key} from '../i18n';
import {Popover} from './Popover';
import {Field} from './Kit';

/** The menu follows the label; optional status and reset take only the room they need. */
export function FilterPopover({label,count,changed,onReset,children,open,onOpenChange,width}:{label:Key;count?:number;changed:boolean;onReset:()=>void;children:ReactNode;open?:boolean;onOpenChange?:(open:boolean)=>void;width?:number}){
  const root=useRef<HTMLDivElement>(null);
  const anchor=useRef<HTMLSpanElement>(null);
  return <div className={`filter-control${changed?' is-changed':''}`} data-filter={label} ref={root}>
    <Popover label={t(label)} horizontalAnchor={anchor} trigger={<span className="filter-trigger"><span ref={anchor}>{t(label)}</span>
      {!!count&&<span className="filter-count" aria-label={t('filters.excludedCount',{count})}>−{count}</span>}
      {changed&&count===undefined&&<i className="filter-changed" aria-hidden="true"/>}
    </span>} open={open} onOpenChange={onOpenChange} width={width}>{children}</Popover>
    {changed&&<button type="button" className="icon-button filter-reset" title={t('filters.showAll',{filter:t(label)})} aria-label={t('filters.showAll',{filter:t(label)})} onClick={()=>{root.current?.querySelector('button')?.focus({preventScroll:true});onReset();}}><X size={13}/></button>}
  </div>;
}

export function FilterSearch({value,onChange}:{value:string;onChange:(value:string)=>void}){
  return <div className="popover-body"><Field label={t('filters.search')} compact placeholder={t('filters.search')} type="search" value={value} onChange={event=>onChange(event.target.value)}/></div>;
}

export function FilterOptions({children}:{children:ReactNode}){
  return <div className="filter-options popover-scroll">{children}</div>;
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
export function FilterGroup({label,icon,on,onChange,hidden,children}:{label:string;icon?:ReactNode;on:boolean;onChange:(on:boolean)=>void;hidden?:boolean;children?:((expanded:boolean)=>ReactNode)}){
  const [expanded,setExpanded]=useState(false),[visited,setVisited]=useState(false);
  const heading=<span className="filter-group-label"><i className="filter-disclosure" aria-hidden="true">{children&&<ChevronDown size={14}/>}</i><i className="filter-logo" aria-hidden="true">{icon??<CircleHelp size={16}/>}</i><span>{label}</span></span>;
  return <div className={`filter-group${on?'':' is-off'}`} hidden={hidden}>
    {children?<>
    <FilterRow className="filter-group-toggle" on={on} onChange={onChange}><span className="sr-only">{label}</span></FilterRow>
    <details open={on&&expanded} onToggle={event=>{const next=event.currentTarget.open;setExpanded(next);if(next)setVisited(true);}}>
      <summary className="popover-row filter-group-heading" aria-disabled={!on} onClick={event=>{if(!on)event.preventDefault();}}>{heading}</summary>
      {visited&&<div className="filter-group-items">{children(on&&expanded)}</div>}
    </details></>:<FilterRow on={on} onChange={onChange}>{heading}</FilterRow>}
  </div>;
}
