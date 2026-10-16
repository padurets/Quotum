/** @jsxRuntime automatic */
import {useLayoutEffect,useMemo,useRef,useState,type RefObject,type ReactNode} from 'react';
import {flushSync} from 'react-dom';
import {tableLayout,tablePages,TABLE_PAGE_ROWS,TABLE_MEASURE_MIN_ROWS,type TableSort} from '../lib/table';
import {t,useLocale} from '../i18n';
import {Popover} from './Popover';
import {Segmented} from './Kit';
import {fillOf,pixels,same,useSizing} from './sizing';
import {tableCell,type Cell,type TimedCell} from './TableCell';


// Private synthetic-only witness. No production optimization or DOM measurement lives here.
type WitnessDeps=readonly unknown[];
type WitnessState={id:number;life:number;alive:boolean;firstSync:boolean;syncDeps:WitnessDeps|null;firstSyncEffect:boolean;syncEffectDeps:WitnessDeps|null;generation:number};
type WitnessClosure={id:number;deps:WitnessDeps|null};
type WitnessObserver={id:number;generation:number;life:number;ordinal:number;targets:readonly (Element|null)[]};
type WitnessCallback={id:number;ordinal:number;observer:WitnessObserver;state:WitnessState;count:number;examined:number};
type WitnessContext={state:WitnessState;life:number;trigger:'sync'|'ro';callback:WitnessCallback|null;scheduled:WitnessClosure|null;scheduledChangedMask:number|null;firstSyncEffect:boolean|null;syncEffect:number|null};
type WitnessUpdate={id:number;state:WitnessState;life:number};
type WitnessRecord=Record<string,number|string|boolean|null>;
const tableInstanceWitness=(()=>{
  const records:WitnessRecord[]=[],elements=new WeakMap<object,number>();
  const widths=new WeakMap<object,{root:number|null;width:number}>();
  const strings=new Set(['capture-start','capture-stop','lifetime-start','lifetime-end','observer-start','observer-end','sync-effect','ro-start','ro-entry','ro-row','ro-decision','ro-end','update-start','update-end','bbox-start','bbox-end','report','root','live','measured','footer','multiFooter','singleFooter','row','unknown','sync','ro','table','list']);
  let sequence=0,started=false,stopped=false,bytes=4096,omitted=0,lastClock:number|null=null;
  let overflow=false,invalidClock=false,invalidValue=false,recorderError=false,unknownTrigger=false,dependencyReasonInsufficient=false,abruptProduction=false,controlError=false;
  let context:WitnessContext|null=null;
  const active=()=>started&&!stopped;
  const safe=<T,>(fallback:T,run:()=>T):T=>{try{return run();}catch{recorderError=true;return fallback;}};
  const next=()=>{if(sequence>=Number.MAX_SAFE_INTEGER){invalidValue=true;return 0;}return ++sequence;};
  const element=(value:object|null):number|null=>{if(!value)return null;let id=elements.get(value);if(id===undefined){id=next();elements.set(value,id);}return id;};
  const append=(value:WitnessRecord)=>safe(undefined,()=>{
    if(!active())return;
    const ts=performance.now();
    if(!Number.isFinite(ts)||ts<0||(lastClock!==null&&ts<lastClock)){invalidClock=true;omitted++;return;}
    lastClock=ts;
    const row={ts,...value};
    if(Object.values(row).some(value=>value!==null&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isFinite(value))&&!(typeof value==='string'&&strings.has(value)))){invalidValue=true;omitted++;return;}
    const size=JSON.stringify(row).length+1;
    if(records.length>=8192||bytes+size>1024*1024){overflow=true;omitted++;return;}
    bytes+=size;records.push(row);
  });
  const fields=(state:WitnessState,life=state.life)=>({instance:state.id,lifetime:life});
  const role=(observer:WitnessObserver,target:Element,isRow:boolean)=>{
    const index=observer.targets.indexOf(target);
    return index>=0?(['root','live','measured','footer','multiFooter','singleFooter'] as const)[index]:isRow?'row':'unknown';
  };
  const snapshot=()=>({status:!started?'unstarted':overflow||invalidClock||invalidValue||recorderError||unknownTrigger||dependencyReasonInsufficient||abruptProduction||controlError?'insufficient-evidence':!stopped?'active':'complete',
    started,stopped,overflow,invalidClock,invalidValue,recorderError,unknownTrigger,dependencyReasonInsufficient,abruptProduction,controlError,omitted,records:records.map(record=>({...record}))});
  const api={
    start:()=>safe(false,()=>{if(started){controlError=true;return false;}started=true;append({event:'capture-start'});return true;}),
    stop:()=>safe(null,()=>{if(!started||stopped){controlError=true;return snapshot();}append({event:'capture-stop'});stopped=true;return snapshot();}),
    read:()=>safe(null,()=>snapshot()),
  };
  try{Object.defineProperty(globalThis,'__quotumTableInstanceWitness',{value:api,configurable:false,writable:false});}catch{recorderError=true;}
  return {
    state:():WitnessState=>safe({id:0,life:0,alive:false,firstSync:true,syncDeps:null,firstSyncEffect:true,syncEffectDeps:null,generation:0},()=>({id:next(),life:0,alive:false,firstSync:true,syncDeps:null,firstSyncEffect:true,syncEffectDeps:null,generation:0})),
    closure:():WitnessClosure=>safe({id:0,deps:null},()=>({id:next(),deps:null})),
    dependencies:<T extends WitnessDeps>(closure:WitnessClosure,deps:T):T=>{safe(undefined,()=>{closure.deps=deps;});return deps;},
    mount:(state:WitnessState)=>safe(0,()=>{state.life=next();state.alive=true;state.firstSync=true;state.syncDeps=null;state.firstSyncEffect=true;state.syncEffectDeps=null;append({event:'lifetime-start',...fields(state)});return state.life;}),
    unmount:(state:WitnessState,life:number)=>safe(undefined,()=>{append({event:'lifetime-end',...fields(state,life)});if(state.life===life){state.alive=false;state.syncDeps=null;state.syncEffectDeps=null;}}),
    width:(box:object,root:Element,width:number)=>safe(undefined,()=>{widths.set(box,{root:element(root),width});}),
    enter:(state:WitnessState,trigger:'sync'|'ro',callback:WitnessCallback|null,scheduled:WitnessClosure|null=null)=>safe(context,()=>{
      const previous=context;
      let scheduledChangedMask:number|null=null,firstSyncEffect:boolean|null=null,syncEffect:number|null=null;
      if(trigger==='sync'){
        firstSyncEffect=state.firstSyncEffect;
        const deps=scheduled?.deps;
        if(deps?.length===6&&state.syncEffectDeps?.length===6){scheduledChangedMask=0;for(let i=0;i<6;i++)if(!Object.is(deps[i],state.syncEffectDeps[i]))scheduledChangedMask|=1<<i;}
        if(active()&&(!scheduled||deps?.length!==6))dependencyReasonInsufficient=true;
        state.firstSyncEffect=false;state.syncEffectDeps=deps??null;syncEffect=next();
      }
      context={state,trigger,callback,life:callback?.observer.life??state.life,scheduled,scheduledChangedMask,firstSyncEffect,syncEffect};
      if(syncEffect!==null)append({event:'sync-effect',...fields(state),effectEntry:syncEffect,scheduledClosure:scheduled?.id??null,scheduledChangedMask,firstSyncEffect});
      return previous;
    }),
    leave:(previous:WitnessContext|null)=>safe(undefined,()=>{context=previous;}),
    update:(state:WitnessState,closure:WitnessClosure,root:Element|null,reuseRows:boolean,width:number,hasMeasurement:boolean,box:object)=>safe(null as WitnessUpdate|null,()=>{
      const id=next(),current=context,known=current!==null&&current.state===state&&current.life===state.life;
      const trigger=known&&current?current.trigger:'unknown';
      if(active()&&!known)unknownTrigger=true;
      const scheduled=trigger==='sync'?current?.scheduled??null:null,scheduledDeps=scheduled?.deps,actualDeps=closure.deps;
      const scheduledVsActualClosureSame=trigger==='sync'&&scheduled?scheduled.id===closure.id:null;
      const scheduledVsActualDepsSame=trigger==='sync'&&scheduledDeps&&actualDeps?scheduledDeps.length===6&&actualDeps.length===6&&scheduledDeps.every((value,index)=>Object.is(value,actualDeps[index])):null;
      if(active()&&trigger==='sync'&&(scheduledVsActualClosureSame!==true||scheduledVsActualDepsSame!==true))dependencyReasonInsufficient=true;
      const firstSync=trigger==='sync'&&state.firstSync;
      let mask:number|null=null;
      if(closure.deps&&state.syncDeps){mask=0;for(let i=0;i<6;i++)if(!Object.is(closure.deps[i],state.syncDeps[i]))mask|=1<<i;}
      if(trigger==='sync'){state.firstSync=false;state.syncDeps=closure.deps;}
      const observed=widths.get(box),callback=current?.callback;
      append({event:'update-start',...fields(state),invocation:id,closure:closure.id,trigger,triggerLifetime:current?.life??null,
        callback:known&&callback?callback.id:null,callbackOrdinal:known&&callback?callback.ordinal:null,
        observer:known&&callback?callback.observer.id:null,generation:known&&callback?callback.observer.generation:null,
        syncEffect:trigger==='sync'?current?.syncEffect??null:null,scheduledClosure:scheduled?.id??null,
        scheduledChangedMask:trigger==='sync'?current?.scheduledChangedMask??null:null,firstSyncEffect:trigger==='sync'?current?.firstSyncEffect??null:null,
        scheduledVsActualClosureSame,scheduledVsActualDepsSame,
        root:element(root),alive:state.alive,reuseRows,firstSync,changedMask:mask,width,hasMeasurement,
        observedWidth:observed?.width??null,observedWidthRoot:observed?.root??null,widthObserved:!!observed&&Object.is(width,observed.width)});
      return {id,state,life:state.life};
    }),
    updateEnd:(call:WitnessUpdate|null,failed:boolean)=>safe(undefined,()=>{if(active()&&failed)abruptProduction=true;if(call)append({event:'update-end',...fields(call.state,call.life),invocation:call.id,failed});}),
    bboxStart:(call:WitnessUpdate|null,root:Element)=>safe(undefined,()=>{if(call)append({event:'bbox-start',...fields(call.state,call.life),invocation:call.id,root:element(root)});}),
    bboxEnd:(call:WitnessUpdate|null,root:Element,height:number|undefined)=>safe(undefined,()=>{if(call)append({event:'bbox-end',...fields(call.state,call.life),invocation:call.id,root:element(root),height:height??null});}),
    report:<T extends {min:number;natural:number;shown:number}>(call:WitnessUpdate|null,value:T):T=>{safe(undefined,()=>{if(call)append({event:'report',...fields(call.state,call.life),invocation:call.id,min:value.min,natural:value.natural,shown:value.shown});});return value;},
    observer:(state:WitnessState):WitnessObserver=>safe({id:0,generation:0,life:state.life,ordinal:0,targets:[]},()=>{const value={id:next(),generation:++state.generation,life:state.life,ordinal:0,targets:[] as readonly (Element|null)[]};append({event:'observer-start',...fields(state),observer:value.id,generation:value.generation});return value;}),
    targets:(observer:WitnessObserver,targets:readonly (Element|null)[])=>safe(undefined,()=>{observer.targets=targets;}),
    disconnect:(state:WitnessState,observer:WitnessObserver)=>safe(undefined,()=>{append({event:'observer-end',...fields(state,observer.life),observer:observer.id,generation:observer.generation});observer.targets=[];}),
    roStart:(state:WitnessState,observer:WitnessObserver,count:number):WitnessCallback=>safe({id:0,ordinal:0,observer,state,count,examined:0},()=>{const call={id:next(),ordinal:++observer.ordinal,observer,state,count,examined:0};append({event:'ro-start',...fields(state,observer.life),observer:observer.id,generation:observer.generation,callback:call.id,ordinal:call.ordinal,ordinalOne:call.ordinal===1,count});return call;}),
    roEntry:(call:WitnessCallback,index:number,target:Element,isRow:boolean)=>safe(undefined,()=>{call.examined=index+1;append({event:'ro-entry',...fields(call.state,call.observer.life),observer:call.observer.id,generation:call.observer.generation,callback:call.id,entry:index,target:element(target),role:role(call.observer,target,isRow),examined:true,isRow});}),
    roRow:(call:WitnessCallback,index:number,previous:boolean,box:boolean,widthSame:boolean|null,heightSame:boolean|null,changed:boolean)=>safe(undefined,()=>{append({event:'ro-row',...fields(call.state,call.observer.life),observer:call.observer.id,generation:call.observer.generation,callback:call.id,entry:index,previous,box,widthSame,heightSame,changed});}),
    roDecision:(call:WitnessCallback,resized:boolean,update:boolean)=>safe(undefined,()=>{append({event:'ro-decision',...fields(call.state,call.observer.life),observer:call.observer.id,generation:call.observer.generation,callback:call.id,resized,update});}),
    roEnd:(call:WitnessCallback,failed:boolean)=>safe(undefined,()=>{if(active()&&failed)abruptProduction=true;for(let index=call.examined;index<call.count;index++)append({event:'ro-entry',...fields(call.state,call.observer.life),observer:call.observer.id,generation:call.observer.generation,callback:call.id,entry:index,target:null,role:'unknown',examined:false,isRow:null});append({event:'ro-end',...fields(call.state,call.observer.life),observer:call.observer.id,generation:call.observer.generation,callback:call.id,failed});}),
  };
})();

export const SortIcon=()=> <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 3v10M1.5 10.5 4 13l2.5-2.5M9 4h5M9 8h3.5M9 12h2"/></svg>;
export function TableGrouping<Id extends string>({value,options,onChange}:{value:Id;options:[Id,string][];onChange:(value:Id)=>void}){
  return <div className="popover-section"><div className="popover-title">{t('table.groupBy')}</div><div className="popover-pad"><Segmented value={value} options={options} onChange={onChange} label={t('table.groupBy')}/></div></div>;
}
export type TableSorting<Id extends string>={active:TableSort<Id>;headers:readonly {id:Id;title:string}[];label:string;defaultLabel:string;onSort:(column:Id|null,cycle?:boolean)=>void};
export function TableSortMenu<Id extends string>({active,headers,label,defaultLabel,onSort}:TableSorting<Id>){
  return <Popover label={label} icon={<SortIcon/>}>
    <div className="popover-title">{label}</div>
    <button type="button" className="popover-row" aria-pressed={!active} onClick={()=>onSort(null)}><span>{defaultLabel}</span><b aria-hidden="true">{!active?'✓':''}</b></button>
    {headers.map(column=><button type="button" className="popover-row" key={column.id} aria-pressed={active?.column===column.id} onClick={()=>onSort(column.id,false)}><span>{column.title}</span>{active?.column===column.id&&<b><span aria-hidden="true">{active.descending?'↓':'↑'}</span><span className="sr-only">{t(active.descending?'agents.descending':'agents.ascending')}</span></b>}</button>)}
  </Popover>;
}
export function TableHeading<Id extends string>({id,title,hint,align,sorting}:{id:Id;title:string;hint?:string;align?:'right';sorting?:Pick<TableSorting<Id>,'active'|'onSort'>}){
  const active=sorting?.active?.column===id?sorting.active:null;
  return <th scope="col" title={hint} className={align&&'is-'+align} aria-sort={active?(active.descending?'descending':'ascending'):undefined}>
    {sorting?<button type="button" className="table-sort" onClick={()=>sorting.onSort(id)}>{title}<span className="table-sort-arrow" aria-hidden="true">{active?(active.descending?'↓':'↑'):''}</span></button>:title}
  </th>;
}

/** The page control is always measured, but only real multiple pages show it. */
export function TablePages({page,pages,onPage,range,body,reserve=false}:{page:number;pages:number;onPage:(page:number)=>void;range?:string;body?:RefObject<HTMLElement|null>;reserve?:boolean}){
  return <nav ref={body} className="table-pages" hidden={!reserve&&pages<2} aria-label={t('table.pages')}>
    <button type="button" className="icon-button" aria-label={t('period.previous')} disabled={page===0} onClick={()=>onPage(page-1)}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m10 3-5 5 5 5"/></svg></button>
    <span title={range} aria-label={t('table.page',{page:page+1,pages})}>{page+1} / {pages}</span>
    <button type="button" className="icon-button" aria-label={t('period.next')} disabled={page+1>=pages} onClick={()=>onPage(page+1)}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></button>
  </nav>;
}

export type TableMetric={id:string;column?:string;label:string;compactLabel?:string;cell:Cell|TimedCell};
function TableFooter({table,count,metrics=[],columns,still=false,single=false,body}:{table:TableWidget;count:number;metrics?:readonly TableMetric[];columns?:readonly string[];still?:boolean;single?:boolean;body?:RefObject<HTMLElement|null>}){
  const aligned=table.layout==='table'&&!!columns;
  const shown=aligned?metrics.filter(metric=>columns!.includes(metric.column??metric.id)):metrics;
  // The table reaches the panel edges; the footer's last column ends at its inner padding.
  const gridColumns=aligned?`minmax(0, 1fr) ${table.columnWidths.map((width,index)=>index===table.columnWidths.length-1?`calc(${width}px - var(--panel-pad))`:width+'px').join(' ')}`:undefined;
  return <footer ref={body} className={`table-footer${table.layout==='list'?' is-list':''}`} aria-label={t('table.summary')}>
    {shown.length>0&&<div className={`table-summary${aligned?' is-aligned':''}`} style={gridColumns?{gridTemplateColumns:gridColumns}:undefined}><div className="table-summary-heading" title={t('table.summaryHint')}>{t('table.summary')}</div>
      {shown.length>0&&<dl>{shown.map(metric=><div key={metric.id} style={aligned?{gridColumn:columns!.indexOf(metric.column??metric.id)+1,gridRow:1}:undefined}><dt className={aligned?'sr-only':undefined} title={metric.label}>{table.layout==='list'?metric.compactLabel??metric.label:metric.label}</dt>{tableCell(metric.id,metric.cell,(cell,time)=><dd data-time={time} data-table-metric={metric.id} className={cell.className} title={cell.title}>{cell.content}</dd>,still)}</div>)}</dl>}
    </div>}
    <div className="table-footer-pages"><small title={t('table.summaryHint')}>{t('table.rows',{count})}</small>{!single&&<TablePages page={still?0:table.page} pages={still?2:table.pages} onPage={table.onPage} range={`${table.from+1}–${table.to} / ${count}`}/>}</div>
  </footer>;
}

type Measurement={scope:string;heights:ReadonlyMap<string,number>;fallback:number;shell:number;footer:number;singleFooter:number;border:number};
export function useTableLayout(box:RefObject<HTMLElement|null>,columns:readonly number[],nameWidth:number,edges?:number,widthKey?:string){
  const [model,setModel]=useState<{layout:'table'|'list';width:number}>({layout:'table',width:0}),key=columns.join(',');
  const space=useRef<{element:HTMLElement;width:number;padding:number;widthKey?:string}|null>(null);
  useLayoutEffect(()=>{
    const root=box.current?.closest<HTMLElement>('.panel,.dialog');if(!root)return;
    const fit=()=>{const measured=space.current!,width=measured.width;
      const layout=tableLayout(columns,width,nameWidth,edges??measured.padding);
      setModel(was=>was.width===width&&was.layout===layout?was:{width,layout});};
    const measure=()=>{const width=root.clientWidth;
      tableInstanceWitness.width(box,root,width);
      const style=getComputedStyle(root),padding=edges??parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)-20;
      space.current={element:root,width,padding,widthKey};fit();};
    const observer=new ResizeObserver(measure);observer.observe(root);
    // Column changes fit the last observed box without forcing layout of the plots.
    if(space.current?.element===root&&space.current.widthKey===widthKey)fit();else measure();return ()=>observer.disconnect();
  },[box,key,nameWidth,edges,widthKey]);
  return model;
}
/** All board tables share width, height, row measurement and page ownership. */
export function useTableWidget(panel:RefObject<HTMLElement|null>,columns:readonly number[],nameWidth:number,keys:readonly string[],resetKey:string,edges?:number){
  useLocale();
  const witness=useRef<WitnessState|null>(null);if(!witness.current)witness.current=tableInstanceWitness.state();
  const witnessState=witness.current;
  const sizing=useSizing(),{layout,width}=useTableLayout(panel,columns,nameWidth,edges,sizing?.width);
  const live=useRef<HTMLElement>(null),measured=useRef<HTMLElement>(null),footer=useRef<HTMLElement>(null),measuredFooter=useRef<HTMLElement>(null),measuredSingleFooter=useRef<HTMLElement>(null);
  const scope=JSON.stringify([layout,width,columns,nameWidth,edges]);
  const [measurement,setMeasurement]=useState<Measurement|null>(null),[position,setPosition]=useState({key:resetKey,page:0});
  const seen=useRef<{key:string;outer:number;live:number;layer:number;footer:number;singleFooter:number}|null>(null);
  const rowBoxes=useRef(new WeakMap<Element,{width:number;height:number}>());
  const rowRun=useRef<{key:string;rows:Element[]}|null>(null);
  const sizes=measurement?.scope===scope?measurement:null;
  const fallback=sizes?.fallback??(layout==='table'?44:90),heights=sizes?.heights??new Map<string,number>();
  let starts:number[];
  if(sizing?.manual&&sizes){
    const room=sizing.allocated-sizes.shell;
    starts=tablePages(keys,heights,fallback,room-sizes.singleFooter,sizes.border);
    if(starts.length>1)starts=tablePages(keys,heights,fallback,room-sizes.footer,sizes.border);
  }else starts=Array.from({length:Math.max(1,Math.ceil(keys.length/TABLE_PAGE_ROWS))},(_,i)=>i*TABLE_PAGE_ROWS);
  const page=Math.min(position.key===resetKey?position.page:0,starts.length-1),from=starts[page],to=starts[page+1]??keys.length;
  useLayoutEffect(()=>{if(position.key!==resetKey||((sizes||!sizing?.manual)&&position.page!==page))setPosition({key:resetKey,page});},[resetKey,page,position,!!sizes,sizing?.manual]);
  const update=useRef<(reuseRows?:boolean)=>void>(()=>{});
  const witnessClosure=tableInstanceWitness.closure();
  update.current=(reuseRows=false)=>{
    const root=panel.current;
    const witnessCall=tableInstanceWitness.update(witnessState,witnessClosure,root,reuseRows,width,sizes!==null,panel);
    let witnessFailed=false;
    try{
    if(!root)return;
    tableInstanceWitness.bboxStart(witnessCall,root);
    let witnessHeight:number|undefined;
    try{witnessHeight=root.getBoundingClientRect().height;}finally{tableInstanceWitness.bboxEnd(witnessCall,root,witnessHeight);}
    const outer=pixels(witnessHeight!-fillOf(root));
    const signal={key:JSON.stringify([scope,keysKey,from,to,sizing?.manual]),outer,live:pixels(live.current?.getBoundingClientRect().height??0),
      layer:pixels(measured.current?.getBoundingClientRect().height??0),footer:pixels(measuredFooter.current?.getBoundingClientRect().height??0),singleFooter:pixels(measuredSingleFooter.current?.getBoundingClientRect().height??0)};
    const last=seen.current;
    // The grid can change only a panel's fill. Its rows and chrome need no new reads.
    if(last&&last.key===signal.key&&same(last.outer,signal.outer)&&same(last.live,signal.live)&&same(last.layer,signal.layer)&&same(last.footer,signal.footer)&&same(last.singleFooter,signal.singleFooter))return;
    seen.current=signal;
    const items=[...(live.current?.children??[])].filter(e=>!(e as HTMLElement).hasAttribute('data-table-total')) as HTMLElement[];
    if(!items.length){
      rowRun.current=null;
      sizing?.report(tableInstanceWitness.report(witnessCall,{min:outer,natural:outer,shown:outer}));if(measurement)setMeasurement(null);
      if(position.page!==0||position.key!==resetKey)setPosition({key:resetKey,page:0});return;
    }
    const layer=sizing?.manual?[...(measured.current?.children??[])] as HTMLElement[]:items;
    if(!layer.length){rowRun.current=null;return;}
    const border=layout==='table'?(parseFloat(getComputedStyle(items[0].firstElementChild!).borderBottomWidth)||0)/2:parseFloat(getComputedStyle(items[0]).borderBottomWidth)||0;
    const area=items.at(-1)!.getBoundingClientRect().bottom-items[0].getBoundingClientRect().top;
    const shell=pixels(outer-area-(footer.current?.getBoundingClientRect().height??0));
    const {footer:multiFooter,singleFooter}=signal;
    const nextHeights=new Map(sizes?.heights??[]);
    const rowKey=JSON.stringify([scope,keysKey,from,sizing?.manual,border]),run=rowRun.current;
    // Chrome can resize the page while its observed measurement rows stay the same.
    if(!reuseRows||!sizes||run?.key!==rowKey||run.rows.length!==layer.length||run.rows.some((row,i)=>row!==layer[i])){
      for(let i=0;i<layer.length;i++){
        const rect=layer[i].getBoundingClientRect(),end=i+1<layer.length?layer[i+1].getBoundingClientRect().top:rect.bottom+border;
        rowBoxes.current.set(layer[i],{width:rect.width,height:rect.height});
        const key=keys[from+i];if(key!==undefined)nextHeights.set(key,pixels(end-rect.top));
      }
      rowRun.current={key:rowKey,rows:layer};
    }
    const retained=new Set(keys);for(const key of nextHeights.keys())if(!retained.has(key))nextHeights.delete(key);
    const ordered=[...nextHeights.values()].sort((a,b)=>a-b),base=ordered[Math.floor(ordered.length/2)]??fallback;
    const min=shell+Math.max(base,...ordered)-border+(keys.length>1?multiFooter:singleFooter);
    const natural=shell+keys.slice(0,TABLE_PAGE_ROWS).reduce((sum,key)=>sum+(nextHeights.get(key)??base),0)-border+(keys.length>TABLE_PAGE_ROWS?multiFooter:singleFooter);
    sizing?.report(tableInstanceWitness.report(witnessCall,{min:pixels(min),natural:pixels(Math.max(min,natural)),shown:outer}));
    if(!sizes||!same(sizes.shell,shell)||!same(sizes.footer,multiFooter)||!same(sizes.singleFooter,singleFooter)||!same(sizes.border,border)||!same(sizes.fallback,base)||nextHeights.size!==sizes.heights.size||[...nextHeights].some(([key,height])=>!same(sizes.heights.get(key),height)))
      setMeasurement({scope,heights:nextHeights,fallback:base,shell,footer:multiFooter,singleFooter,border});
    }catch(error){witnessFailed=true;throw error;}finally{tableInstanceWitness.updateEnd(witnessCall,witnessFailed);}
  };
  const keysKey=keys.join('\n'),columnsKey=columns.join(',');
  useLayoutEffect(()=>{const lifetime=tableInstanceWitness.mount(witnessState);return()=>tableInstanceWitness.unmount(witnessState,lifetime);},[]);
  useLayoutEffect(()=>{const previous=tableInstanceWitness.enter(witnessState,'sync',null,witnessClosure);try{update.current();}finally{tableInstanceWitness.leave(previous);}},tableInstanceWitness.dependencies(witnessClosure,[layout,scope,keysKey,sizing?.manual,sizing?.allocated,columnsKey]));
  useLayoutEffect(()=>{
    const body=sizing?.manual?measured.current:live.current;
    const rows=new Set([...(body?.children??[])].filter(row=>!row.hasAttribute('data-table-total')));
    const witnessObserver=tableInstanceWitness.observer(witnessState);
    const observer=new ResizeObserver(entries=>{
      const witnessCallback=tableInstanceWitness.roStart(witnessState,witnessObserver,entries.length);let witnessFailed=false;
      try{
      const resized=entries.some((entry,index)=>{
        const target=entry.target,isRow=rows.has(target);tableInstanceWitness.roEntry(witnessCallback,index,target,isRow);
        if(!isRow)return false;
        const previous=rowBoxes.current.get(entry.target),box=entry.borderBoxSize?.length===1?entry.borderBoxSize[0]:undefined;
        let widthSame:boolean|null=null,heightSame:boolean|null=null;
        const changed=!previous||!box||!(widthSame=same(previous.width,box.inlineSize))||!(heightSame=same(previous.height,box.blockSize));
        tableInstanceWitness.roRow(witnessCallback,index,!!previous,!!box,widthSame,heightSame,changed);return changed;
      });
      // Initial row notifications repeat the boxes already read by the layout effect.
      if(resized){seen.current=null;rowRun.current=null;}
      const needsUpdate=resized||entries.some(entry=>!rows.has(entry.target));
      tableInstanceWitness.roDecision(witnessCallback,resized,needsUpdate);
      if(needsUpdate)flushSync(()=>{const previous=tableInstanceWitness.enter(witnessState,'ro',witnessCallback);try{update.current(!resized);}finally{tableInstanceWitness.leave(previous);}});
      }catch(error){witnessFailed=true;throw error;}finally{tableInstanceWitness.roEnd(witnessCallback,witnessFailed);}
    });
    const witnessTargets=[panel.current,live.current,measured.current,footer.current,measuredFooter.current,measuredSingleFooter.current];
    tableInstanceWitness.targets(witnessObserver,witnessTargets);
    for(const element of witnessTargets)if(element)observer.observe(element);
    for(const row of rows)observer.observe(row,{box:'border-box'});
    return ()=>{try{observer.disconnect();}finally{tableInstanceWitness.disconnect(witnessState,witnessObserver);}};
  },[panel,layout,!!keys.length,keysKey,from,to,sizing?.manual]);
  const report=sizing?.report;useLayoutEffect(()=>()=>report?.(null),[report]);
  return useMemo(()=>({layout,columnWidths:columns,from,to,page,count:keys.length,pages:starts.length,onPage:(page:number)=>setPosition({key:resetKey,page}),live,measured,footer,measuredFooter,measuredSingleFooter,
    measureFrom:from,measureTo:sizing?.manual?Math.min(keys.length,Math.max(from+TABLE_MEASURE_MIN_ROWS,to+1)):from}),[layout,columnsKey,from,to,page,starts.length,resetKey,sizing?.manual,keys.length]);
}
export type TableWidget=ReturnType<typeof useTableWidget>;
export function TableMeasure({table,children,metrics,columns}:{table:TableWidget;children:ReactNode;metrics?:readonly TableMetric[];columns?:readonly string[]}){
  return <div className="table-measure" aria-hidden="true" inert>{children}<TableFooter table={table} count={table.count} metrics={metrics} columns={columns} still body={table.measuredFooter}/><TableFooter table={table} count={table.count} metrics={metrics} columns={columns} still single body={table.measuredSingleFooter}/></div>;
}
export function WidgetPages({table,count,metrics,columns}:{table:TableWidget;count:number;metrics?:readonly TableMetric[];columns?:readonly string[]}){
  return <TableFooter table={table} count={count} metrics={metrics} columns={columns} body={table.footer}/>;
}
