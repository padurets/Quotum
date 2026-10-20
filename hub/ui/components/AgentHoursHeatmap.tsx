import {memo,useCallback,useMemo,useLayoutEffect,useRef,useState,useSyncExternalStore,type CSSProperties,type KeyboardEvent,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {boardPeriod} from '../lib/period';
import {CALENDAR_OPACITY,CALENDAR_RETENTION,calendarLevel,exactAgentHours} from '../lib/workCalendar';
import {useClock} from '../lib/clock';
import type {CalendarCell} from '../../server/domain/workCalendar';
import {AGENT_HOURS_HEATMAP,withHidden,type Arrange} from '../lib/view';
import {CATEGORY_COLORS} from '../lib/providers';
import {setTimeRange,useTimeRange} from '../lib/timeRange';
import {formatLocale,t,useLocale} from '../i18n';
import {clock,stamp} from '../lib/format';
import {HideRow,Popover,PopoverHeading,SlidersIcon} from './Popover';
import {useBubble} from './Tooltip';
import {HistoryFailure} from './HistoryFailure';
import {fillOf,useSizing} from './sizing';

function Details({date,cell,start,end,heading=true}:{heading?:boolean;date:string;cell:CalendarCell|null;start:number;end:number}){
  const available=cell?.agentMs!==null&&cell?.agentMs!==undefined;
  const now=useClock(at=>{
    if(!available||at-CALENDAR_RETENTION>=cell!.to)return null;
    const entry=cell!.from+CALENDAR_RETENTION+1;
    return entry>at?entry:(Math.floor(at/60_000)+1)*60_000;
  });
  const from=available?Math.min(cell!.to,Math.max(cell!.from,now-CALENDAR_RETENTION)):start;
  return <>
    {heading&&<strong>{date}</strong>}
    <p>{available?cell!.agentMs===0?t('calendar.zero'):`${exactAgentHours(cell!.agentMs!,formatLocale())} ${t('calendar.hours')}`:t('calendar.unavailable')}</p>
    {available&&(from>start||cell!.to<end)&&<p data-time="calendar-bounds" aria-label={t('calendar.bounds')}>{clock(from)} — {clock(cell!.to)}</p>}
  </>;
}

const Day=memo(function Day({date,dateKey,index,start,end,cell,selected,tab,focus,panel,onKey}:{date:string;dateKey:string;index:number;start:number;end:number;cell:CalendarCell|null;selected:boolean;tab:boolean;focus:(date:string)=>void;panel:RefObject<HTMLElement|null>;onKey:(event:KeyboardEvent<HTMLButtonElement>,index:number)=>void}){
  const [open,setOpen]=useState(false),[hover,setHover]=useState(false),[focused,setFocused]=useState(false);
  const changeOpen=(next:boolean)=>{setHover(false);setOpen(next);};
  const anchor=useRef<HTMLDivElement>(null),active=!open&&(hover||focused);
  const tip=useBubble(active,anchor,panel.current);
  const available=cell?.agentMs!==undefined&&cell.agentMs!==null;
  const level=available?calendarLevel(cell!.agentMs!):0;
  const partial=available&&(cell!.from>start||cell!.to<end);
  const label=[date,available?t('calendar.exact',{hours:exactAgentHours(cell!.agentMs!,formatLocale())}):t('calendar.unavailable'),...(partial?[t('calendar.partial'),`${stamp(cell!.from)} — ${stamp(cell!.to)}`]:[])].join('\n');
  return <div className={`calendar-date${selected?' is-selected':''}${!available?' is-unavailable':''}${partial?' is-partial':''}`} role="gridcell" aria-selected={selected} ref={anchor}
    onPointerEnter={()=>setHover(true)} onPointerLeave={()=>setHover(false)}>
    <Popover label={label} trigger={<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill={level?CATEGORY_COLORS[0]:'var(--hair-2)'} fillOpacity={level?CALENDAR_OPACITY[level]:1}/></svg>} triggerClass="calendar-cell"
      open={open} onOpenChange={changeOpen} width={320} portal={panel.current}
      buttonProps={{tabIndex:tab?0:-1,'data-calendar-date':dateKey,'data-agent-ms':cell?.agentMs??undefined,'aria-label':label,title:'',onFocus:()=>{focus(dateKey);setFocused(true);},onBlur:()=>setFocused(false),onKeyDown:event=>onKey(event,index)}}>
      <PopoverHeading onClose={()=>changeOpen(false)}>{date}</PopoverHeading>
      <div className="popover-body calendar-details"><Details date={date} cell={cell} start={start} end={end} heading={false}/>
        {available&&<button className="button" onClick={()=>{setTimeRange({from:start,to:end});changeOpen(false);}}>{t('calendar.openDay')}</button>}
      </div>
    </Popover>
    {active&&panel.current&&createPortal(<span className="tooltip glass calendar-tip" role="tooltip" ref={tip}><Details date={date} cell={cell} start={start} end={end}/></span>,panel.current)}
  </div>;
});

export const AgentHoursHeatmap=memo(function AgentHoursHeatmap({arrange}:{arrange:Arrange}){
  const locale=useLocale();
  const reading=useSyncExternalStore(boardPeriod.calendar.subscribe,boardPeriod.calendar.get);
  const {window,value,loading,error}=reading,selection=useTimeRange();
  const root=useRef<HTMLElement>(null),matrix=useRef<HTMLDivElement>(null),sizing=useSizing();
  const [focused,setFocused]=useState(window.dates[89]),[settings,setSettings]=useState(false);
  const offset=(new Date(window.dates[0]+'T12:00:00Z').getUTCDay()+6)%7,weeks=Math.ceil((offset+90)/7);
  const [capacity,setCapacity]=useState(weeks);
  // Balanced week bands keep every date visible without an inner scroller.
  const columns=Math.ceil(weeks/Math.ceil(weeks/capacity)),bands=Math.ceil(weeks/columns);
  const measure=useRef(()=>{});
  measure.current=()=>{const node=root.current;if(matrix.current)setCapacity(Math.max(1,Math.floor((matrix.current.clientWidth-30)/26)));if(node&&sizing){const height=node.getBoundingClientRect().height-fillOf(node);sizing.report({min:height,natural:height,shown:height});}};
  useLayoutEffect(()=>measure.current(),[sizing?.manual,sizing?.allocated,sizing?.width,sizing?.report,loading,error,locale,columns]);
  useLayoutEffect(()=>{
    const node=root.current;if(!node)return;
    const observer=new ResizeObserver(()=>measure.current());observer.observe(node);return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>()=>sizing?.report(null),[sizing?.report]);
  const key=useCallback((event:KeyboardEvent<HTMLButtonElement>,i:number)=>{
    const day=(offset+i)%7;
    const next=event.key==='ArrowUp'?i-1:event.key==='ArrowDown'?i+1:event.key==='ArrowLeft'?i-7:event.key==='ArrowRight'?i+7:event.key==='Home'?event.ctrlKey?0:i-day:event.key==='End'?event.ctrlKey?89:i+6-day:null;
    if(next===null)return;event.preventDefault();const date=window.dates[Math.max(0,Math.min(89,next))];setFocused(date);
    matrix.current?.querySelector<HTMLButtonElement>(`[data-calendar-date="${date}"]`)?.focus();
  },[window,offset]);
  const formatters=useMemo(()=>({month:new Intl.DateTimeFormat(formatLocale(),{month:'short',timeZone:'UTC'}),weekday:new Intl.DateTimeFormat(formatLocale(),{weekday:'short',timeZone:'UTC'}),date:new Intl.DateTimeFormat(formatLocale(),{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}),bound:new Intl.DateTimeFormat(formatLocale(),{day:'numeric',month:'short',timeZone:'UTC'})}),[locale]);
  const dateText=(date:string,options:Intl.DateTimeFormatOptions)=>(options.weekday?formatters.weekday:options.year?formatters.date:formatters.month).format(new Date(date+'T12:00:00Z'));
  return <section ref={root} className={`panel agent-hours-heatmap${loading?' is-loading':''}`} aria-label={t('calendar.title')} aria-busy={loading} data-calendar-ready={!!value}>
    <div className="panel-head"><h2 className="panel-heading">{t('calendar.title')}</h2>{arrange.owner&&<Popover label={t('calendar.settings')} icon={<SlidersIcon/>} open={settings} onOpenChange={setSettings}>
      <HideRow onHide={()=>arrange.update(view=>withHidden(view,AGENT_HOURS_HEATMAP,true))}>{t('widget.hide')}</HideRow>
    </Popover>}</div>
    <p className="analytics-note" data-time="calendar-window">{formatters.bound.format(new Date(window.dates[0]+'T12:00:00Z'))} — {formatters.bound.format(new Date(window.dates[89]+'T12:00:00Z'))}</p>
    <HistoryFailure error={error==='history_limit'?'history_limit':error==='filters_limit'?'filters_limit':error?'history_failed':undefined} retry={boardPeriod.retry}/>
    <div className="calendar-bands" ref={matrix}>
      <div className="calendar-grid" role="grid" aria-label={t('calendar.registered')} aria-description={t('calendar.observations')} style={{'--calendar-weeks':columns,gridTemplateRows:Array.from({length:bands},()=> '20px repeat(7,24px)').join(' 16px ')} as CSSProperties}>
        {Array.from({length:weeks},(_,week)=>{const date=window.dates[Math.max(0,week*7-offset)],previous=week%columns?window.dates[Math.max(0,(week-1)*7-offset)]:undefined;return <span key={week} className="calendar-month" aria-hidden="true" style={{gridColumn:week%columns+2,gridRow:Math.floor(week/columns)*9+1}}>{!previous||date.slice(0,7)!==previous.slice(0,7)?dateText(date,{month:'short'}):''}</span>;})}
        {Array.from({length:7},(_,weekday)=><div role="row" className="calendar-weekday" key={weekday}>
          {Array.from({length:bands},(_,band)=><span key={band} role="rowheader" aria-hidden={band>0?true:undefined} className="calendar-day-label" style={{gridRow:band*9+weekday+2,gridColumn:1}}>{dateText(new Date(Date.UTC(2026,0,5+weekday)).toISOString().slice(0,10),{weekday:'short'})}</span>)}
          {window.dates.map((date,i)=>(offset+i)%7===weekday?<div className="calendar-slot" key={date} style={{gridRow:Math.floor(Math.floor((offset+i)/7)/columns)*9+weekday+2,gridColumn:Math.floor((offset+i)/7)%columns+2}}>
            <Day dateKey={date} date={dateText(date,{day:'numeric',month:'long',year:'numeric'})} index={i} start={window.edges[i]} end={window.edges[i+1]} cell={value?.cells[i]??null} selected={selection?.from===window.edges[i]&&selection?.to===window.edges[i+1]} tab={date===focused||!window.dates.includes(focused)&&i===89} focus={setFocused} panel={root} onKey={key}/>
          </div>:null)}
        </div>)}
      </div>
    </div>
    <div className="calendar-legend" aria-label={t('calendar.registered')}>{['0','<1','1–4','4–16','16–64','64+'].map((label,level)=><span key={label}><svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill={level?CATEGORY_COLORS[0]:'var(--hair-2)'} fillOpacity={level?CALENDAR_OPACITY[level]:1}/></svg>{label} {t('calendar.hours')}</span>)}</div>
    {value&&value.cells.some(c=>c.agentMs!==null)&&value.cells.every(c=>c.agentMs===null||c.agentMs===0)&&<p className="analytics-note">{t('calendar.empty')}</p>}
    {value&&value.cells.every(c=>c.agentMs===null)&&<p className="analytics-note">{t('calendar.unavailable')}</p>}
    {!value&&!error&&<p className="analytics-note" role="status">{t(loading?'calendar.loading':'calendar.pending')}</p>}
  </section>;
});
