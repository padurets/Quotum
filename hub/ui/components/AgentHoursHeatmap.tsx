import {memo,useMemo,useLayoutEffect,useRef,useState,useSyncExternalStore,type CSSProperties,type KeyboardEvent,type RefObject} from 'react';
import {createPortal,flushSync} from 'react-dom';
import {boardPeriod} from '../lib/period';
import {CALENDAR_OPACITY,calendarLevel,exactAgentHours} from '../lib/workCalendar';
import {heatmapLayoutPrepared,heatCellAt,heatCellChangesAt,heatDateLabel,heatIntervalLabel,HEATMAP_MIN,HEATMAP_NATURAL,type HeatCell,type HeatmapLayout} from '../lib/heatmap';
import {usePrepared} from './prepared';
import {useClock} from '../lib/clock';
import {AGENT_HOURS_HEATMAP,withHidden,type Arrange} from '../lib/view';
import {CATEGORY_COLORS} from '../lib/providers';
import {MIN_TIME_RANGE,setTimeRange,useTimeRange} from '../lib/timeRange';
import {setPrefs,usePref} from '../lib/prefs';
import {formatLocale,t,useLocale} from '../i18n';
import {num} from '../lib/format';
import {HideRow,Popover,PopoverHeading,SlidersIcon} from './Popover';
import {Segmented} from './Kit';
import {useBubble} from './Tooltip';
import {ReadState} from './ReadState';
import {fillOf,pixels,same,useSizing} from './sizing';
import {isFocusReturn} from './focusReturn';

function Details({heading,label,interval,item}:{heading:boolean;label:string;interval:string;item:HeatCell}){
  return <>{heading&&<strong>{label}</strong>}{interval&&<p className="heatmap-interval">{interval}</p>}<p>{item.cell.agentMs===null?t('calendar.unavailable'):item.cell.agentMs===0?t('calendar.zero'):`${exactAgentHours(item.cell.agentMs,formatLocale())} ${t('calendar.hours')}`}</p>{item.partial&&<p>{t('calendar.partial')}</p>}</>;
}

/** The latest interaction owns one description; an open detail suppresses previews. */
class HeatmapPreview {
  private active:{key:string;input:'pointer'|'focus'}|null=null;
  private opened=new Set<string>();
  private listeners=new Map<string,Set<()=>void>>();
  get=(key:string)=>this.active?.key===key;
  subscribe(key:string,listener:()=>void){
    let listeners=this.listeners.get(key);if(!listeners)this.listeners.set(key,listeners=new Set());
    listeners.add(listener);return()=>{listeners!.delete(listener);if(!listeners!.size)this.listeners.delete(key);};
  }
  private select(next:typeof this.active){
    const before=this.active;this.active=next;
    if(before?.key===next?.key)return;
    for(const key of [before?.key,next?.key])if(key!==undefined)for(const listener of [...(this.listeners.get(key)??[])])listener();
  }
  show(key:string,input:'pointer'|'focus'){if(!this.opened.size&&(this.active?.key!==key||this.active.input!==input))this.select({key,input});}
  dismiss=()=>this.select(null);
  leave(key:string,input:'pointer'|'focus'){if(this.active?.key===key&&this.active.input===input)this.select(null);}
  open(key:string,open:boolean){if(open){this.opened.add(key);this.select(null);}else this.opened.delete(key);}
  retire(key:string){this.opened.delete(key);if(this.active?.key===key)this.select(null);}
}
type BucketProps={item:HeatCell;span:number;zone:string;tab:boolean;selected:boolean;focus:(key:string)=>void;openRange:(range:{from:number;to:number})=>void;panel:RefObject<HTMLElement|null>;onKey:(event:KeyboardEvent<HTMLButtonElement>,item:HeatCell)=>void;preview:HeatmapPreview;timed?:boolean};
function TimedBucket(props:BucketProps){
  const timed=props.item.cell.validUntil!==null,now=useClock(now=>heatCellChangesAt(props.item,now),[props.item],timed);
  return <Bucket {...props} item={timed?heatCellAt(props.item,now):props.item} timed={timed}/>;
}
const Bucket=memo(function Bucket({item,span,zone,tab,selected,focus,openRange,panel,onKey,preview,timed}:BucketProps){
  const locale=useLocale(),[open,setOpen]=useState(false);
  const subscribe=useMemo(()=>(listener:()=>void)=>preview.subscribe(item.key,listener),[preview,item.key]);
  const active=useSyncExternalStore(subscribe,()=>preview.get(item.key),()=>false);
  useLayoutEffect(()=>()=>preview.retire(item.key),[preview,item.key]);
  const anchor=useRef<HTMLDivElement>(null),tip=useBubble(active,anchor,panel.current);
  const label=useMemo(()=>heatDateLabel(item.date,formatLocale()),[item.date,locale]);
  const interval=useMemo(()=>heatIntervalLabel(item,span,zone,formatLocale()),[item.from,item.to,item.repeated,item.dayRange.from,item.dayRange.to,span,zone,locale]);
  const available=item.cell.agentMs!==null,level=available?calendarLevel(item.cell.agentMs!,span):0;
  const aria=[label,interval,available?t('calendar.exact',{hours:exactAgentHours(item.cell.agentMs!,formatLocale())}):t('calendar.unavailable'),...(item.partial?[t('calendar.partial')]:[])].join('\n');
  const day=span>=23*3_600_000,range=day?item.dayRange:{from:item.from,to:item.to};
  const changeOpen=(next:boolean)=>{preview.open(item.key,next);setOpen(next);};
  return <div className={`calendar-date heatmap-bucket${selected?' is-selected':''}${!available?' is-unavailable':''}${item.partial?' is-partial':''}`} role="gridcell" aria-selected={selected} ref={anchor} data-time={timed?'calendar':undefined}
    style={{left:item.x,top:item.y,width:item.width,height:item.height}} onPointerEnter={event=>{if(event.pointerType==='touch')preview.dismiss();else preview.show(item.key,'pointer');}} onPointerMove={event=>{if(event.pointerType!=='touch')preview.show(item.key,'pointer');}} onPointerLeave={()=>preview.leave(item.key,'pointer')}>
    <Popover label={aria} trigger={<svg viewBox="0 0 24 24" preserveAspectRatio="none" aria-hidden="true"><rect width="24" height="24" rx="2" fill={level?CATEGORY_COLORS[0]:'var(--hair)'} fillOpacity={level?CALENDAR_OPACITY[level]:1}/></svg>} triggerClass="calendar-cell"
      open={open} onOpenChange={changeOpen} width={320} portal={panel.current}
      buttonProps={{tabIndex:tab?0:-1,'data-calendar-date':item.date,'data-heatmap-cell':item.key,'data-agent-ms':item.cell.agentMs??undefined,'aria-label':aria,title:'',onFocus:event=>{focus(item.key);if(event.currentTarget.matches(':focus-visible'))preview.show(item.key,'focus');},onBlur:()=>preview.leave(item.key,'focus'),onKeyDown:event=>onKey(event,item)}}>
      <PopoverHeading onClose={()=>changeOpen(false)}>{label}</PopoverHeading>
      <div className="popover-body calendar-details"><Details heading={false} label={label} interval={interval} item={item}/>
        {available&&range.to-range.from>=MIN_TIME_RANGE&&<button className="button" onClick={()=>{openRange(range);changeOpen(false);}}>{t(day?'calendar.openDay':'calendar.openInterval')}</button>}
      </div>
    </Popover>
    {active&&panel.current&&createPortal(<span className="tooltip glass calendar-tip" role="tooltip" ref={tip}><Details heading label={label} interval={interval} item={item}/></span>,panel.current)}
  </div>;
});

export const AgentHoursHeatmap=memo(function AgentHoursHeatmap({arrange}:{arrange:Arrange}){
  const locale=useLocale(),view=usePref('heatmapView'),reading=useSyncExternalStore(boardPeriod.calendar.subscribe,boardPeriod.calendar.get),selection=useTimeRange();
  const {value,loading,error,window}=reading,root=useRef<HTMLElement>(null),matrix=useRef<HTMLDivElement>(null),sizing=useSizing();
  const [focused,setFocused]=useState(''),[settings,setSettings]=useState(false),[width,setWidth]=useState(0),[height,setHeight]=useState(0),[visible,setVisible]=useState(false);
  const [preview]=useState(()=>new HeatmapPreview());
  const drill=useRef<{range:{from:number;to:number};context:string;focus:boolean}|null>(null);
  const presentation=boardPeriod.calendar.presentationKey();
  const context=JSON.stringify([presentation,!!value,window.zone,view,width,height,locale,selection]);
  const aligned=!selection||window.range.from===selection.from&&window.range.to===selection.to;
  useLayoutEffect(()=>boardPeriod.calendar.retain(reading),[reading]);
  const prepared=usePrepared(function*(){return {reading,layout:yield*heatmapLayoutPrepared(reading,width,view,formatLocale(),height)};},[window,value,width,view,locale,height],context,aligned&&width>0&&visible);
  useLayoutEffect(()=>prepared.value?boardPeriod.calendar.retain(prepared.value.reading):undefined,[prepared.value?.reading]);
  const empty:HeatmapLayout={cells:[],labels:[],height:Math.max(HEATMAP_MIN,height||HEATMAP_NATURAL),naturalHeight:HEATMAP_NATURAL,span:3_600_000,kind:'strip'};
  const layout=prepared.value?.layout??empty;
  useLayoutEffect(()=>{
    const revoke=()=>{if(drill.current)drill.current.focus=false;};
    const focused=(event:FocusEvent)=>{if(event.target!==document.body&&event.target!==document.documentElement&&!isFocusReturn())revoke();};
    // Observe producer context changes even when React coalesces A → B → A.
    const stop=boardPeriod.calendar.subscribe(()=>{if(drill.current?.context!==boardPeriod.calendar.presentationKey())drill.current=null;});
    document.addEventListener('pointerdown',revoke,true);document.addEventListener('keydown',revoke,true);
    document.addEventListener('wheel',revoke,{capture:true,passive:true});document.addEventListener('focusin',focused,true);
    return()=>{drill.current=null;stop();document.removeEventListener('pointerdown',revoke,true);document.removeEventListener('keydown',revoke,true);document.removeEventListener('wheel',revoke,true);document.removeEventListener('focusin',focused,true);};
  },[]);
  const measure=useRef(()=>{});
  measure.current=()=>{
    const node=root.current,plot=matrix.current;if(!node||!plot)return;const nextWidth=plot.clientWidth;setVisible(nextWidth>0);
    // Hidden panels retain their last positive size without preparing invisible cells.
    if(!nextWidth)return;setWidth(nextWidth);
    if(sizing){const shown=pixels(node.getBoundingClientRect().height-fillOf(node)),chrome=shown-plot.getBoundingClientRect().height,min=pixels(chrome+HEATMAP_MIN);
      sizing.report({min,natural:pixels(chrome+HEATMAP_NATURAL),shown,layout:JSON.stringify([width,locale,view])});const next=sizing.manual?pixels(Math.max(HEATMAP_MIN,sizing.allocated-chrome)):0;setHeight(was=>same(was,next)?was:next);
    }
  };
  useLayoutEffect(()=>measure.current(),[sizing?.manual,sizing?.allocated,sizing?.width,sizing?.report,loading,error,locale,layout.naturalHeight]);
  useLayoutEffect(()=>{const node=root.current;if(!node)return;const observer=new ResizeObserver(()=>flushSync(()=>measure.current()));observer.observe(node);return()=>observer.disconnect();},[]);
  useLayoutEffect(()=>()=>sizing?.report(null),[sizing?.report]);
  const tab=layout.cells.find(c=>c.key===focused)??layout.cells.reduce<HeatCell|undefined>((best,c)=>!best||Math.abs(c.from-Number(focused))<Math.abs(best.from-Number(focused))?c:best,undefined);
  const openRange=(range:{from:number;to:number})=>{
    drill.current=null;setFocused(String(range.from));setTimeRange(range);
    drill.current={range,context:boardPeriod.calendar.presentationKey(),focus:true};
  };
  const retry=()=>{
    const request=drill.current;
    if(request&&request.context===presentation&&presentation===boardPeriod.calendar.presentationKey()&&selection?.from===request.range.from&&selection.to===request.range.to)request.focus=true;
    boardPeriod.retry();
  };
  useLayoutEffect(()=>{
    const request=drill.current;if(!request)return;
    const {range}=request;
    if(request.context!==presentation||selection?.from!==range.from||selection?.to!==range.to){drill.current=null;return;}
    // Placeholder cells retire again when the requested evidence arrives.
    if(!value||!prepared.ready||window.range.from!==range.from||window.range.to!==range.to||!tab)return;
    const button=matrix.current?.querySelector<HTMLButtonElement>(`[data-heatmap-cell="${tab.key}"]`);
    if(button){drill.current=null;if(request.focus)button.focus({preventScroll:true});}
  },[selection,presentation,window,tab?.key,value,prepared.ready]);
  const key=(event:KeyboardEvent<HTMLButtonElement>,item:HeatCell)=>{
    const {key,ctrlKey}=event;let candidates:HeatCell[]=[];
    if(key==='Home'||key==='End')candidates=layout.cells.filter(c=>ctrlKey||c.row===item.row).sort((a,b)=>ctrlKey?a.from-b.from:a.column-b.column);
    else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key)){
      const vertical=key==='ArrowUp'||key==='ArrowDown',direction=key==='ArrowUp'||key==='ArrowLeft'?-1:1;
      candidates=layout.cells.filter(c=>vertical?(c.row-item.row)*direction>0:c.row===item.row&&(c.column-item.column)*direction>0).sort((a,b)=>vertical?Math.abs(a.row-item.row)-Math.abs(b.row-item.row)||Math.abs(a.column-item.column)-Math.abs(b.column-item.column):Math.abs(a.column-item.column)-Math.abs(b.column-item.column));
    }else return;
    event.preventDefault();const next=key==='End'?candidates.at(-1):candidates[0];if(!next)return;
    setFocused(next.key);matrix.current?.querySelector<HTMLButtonElement>(`[data-heatmap-cell="${next.key}"]`)?.focus();
  };
  const unit=layout.span<3_600_000?60_000:3_600_000,thresholds=[0,0,layout.span*.5,layout.span,layout.span*2,layout.span*4];
  return <section ref={root} className={`panel agent-hours-heatmap${loading?' is-loading':''}`} aria-label={t('calendar.title')} aria-busy={loading||!prepared.ready} data-calendar-ready={!!value&&prepared.ready}
    onFocusCapture={event=>{if(!(event.target as Element).closest('[data-heatmap-cell]'))preview.dismiss();}}>
    <div className="panel-head"><h2 className="panel-heading" tabIndex={-1}>{t('calendar.title')}</h2><div className="panel-controls"><ReadState error={error} loading={loading&&!!selection&&!!value} range={reading.basis?.range} retry={retry}/><Popover label={t('calendar.settings')} icon={<SlidersIcon/>} open={settings} onOpenChange={setSettings}>
      <div className="popover-section"><div className="popover-title">{t('calendar.view')}</div><div className="popover-pad"><Segmented value={view} onChange={heatmapView=>setPrefs({heatmapView})} options={['matrix','calendar'].map(key=>[key as 'matrix'|'calendar',t(key==='matrix'?'calendar.matrix':'calendar.calendar')])} label={t('calendar.view')}/></div></div>
      {arrange.owner&&<HideRow onHide={()=>arrange.update(view=>withHidden(view,AGENT_HOURS_HEATMAP,true))}>{t('widget.hide')}</HideRow>}
    </Popover></div></div>
    <div className="heatmap-plot" ref={matrix} role="grid" aria-label={t('calendar.registered')} aria-description={t('calendar.observations')} style={{height:layout.height} as CSSProperties} data-heatmap-view={layout.kind}>
      {layout.labels.map((label,i)=><span key={i} aria-hidden="true" className="heatmap-axis" style={{left:label.x,top:label.y,transform:label.align==='end'?'translate(-100%,-100%)':label.align==='middle'?'translate(-50%,-100%)':'translateY(-100%)'}}>{label.text}</span>)}
      {[...new Set(layout.cells.map(c=>c.row))].sort((a,b)=>a-b).map(row=><div role="row" className="heatmap-row" key={row}>{layout.cells.filter(c=>c.row===row).sort((a,b)=>a.column-b.column||a.from-b.from).map(item=><TimedBucket key={item.key} item={item} span={layout.span} zone={window.zone} selected={selection?.from===item.from&&selection?.to===item.to} tab={item.key===tab?.key} focus={setFocused} openRange={openRange} panel={root} onKey={key} preview={preview}/>)}</div>)}
    </div>
    <div className="legend calendar-legend" style={{height:width<260?80:width<560?48:24}}><span className="heatmap-unit">{t(unit===60_000?'calendar.scaleMinutes':'calendar.scaleHours')}</span>{thresholds.map((value,level)=><span className="heatmap-key" key={level}><svg width="10" height="8" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill={level?CATEGORY_COLORS[0]:'var(--hair)'} fillOpacity={level?CALENDAR_OPACITY[level]:1}/></svg>{level===1?'>0':level===5?'≥ '+num(value/unit,2):num(value/unit,2)}</span>)}</div>
  </section>;
});
