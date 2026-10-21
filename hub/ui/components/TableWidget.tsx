/** @jsxRuntime automatic */
import {useLayoutEffect,useMemo,useRef,useState,type RefObject,type ReactNode} from 'react';
import {flushSync} from 'react-dom';
import {tableLayout,tablePages,TABLE_PAGE_ROWS,TABLE_MEASURE_MIN_ROWS,type TableSort} from '../lib/table';
import {t,useLocale} from '../i18n';
import {Popover} from './Popover';
import {Segmented} from './Kit';
import {fillOf,pixels,same,useSizing} from './sizing';
import {tableCell,type Cell,type TimedCell} from './TableCell';

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
  const sizing=useSizing(),{layout,width}=useTableLayout(panel,columns,nameWidth,edges,sizing?.width);
  const measurable=width>0;
  const live=useRef<HTMLElement>(null),measured=useRef<HTMLElement>(null),footer=useRef<HTMLElement>(null),measuredFooter=useRef<HTMLElement>(null),measuredSingleFooter=useRef<HTMLElement>(null);
  const scope=JSON.stringify([layout,width,columns,nameWidth,edges]);
  const [measurement,setMeasurement]=useState<Measurement|null>(null),[position,setPosition]=useState({key:resetKey,page:0});
  const seen=useRef<{key:string;outer:number;live:number;layer:number;footer:number;singleFooter:number}|null>(null);
  const rowBoxes=useRef(new WeakMap<Element,{width:number;height:number}>());
  const rowRun=useRef<{key:string;rows:Element[]}|null>(null);
  const suspended=useRef<HTMLElement|null>(null);
  // A hidden layout keeps the last useful geometry for page ownership.
  const sizes=measurement?.scope===scope||(panel.current&&suspended.current===panel.current)?measurement:null;
  const fallback=sizes?.fallback??(layout==='table'?44:90),heights=sizes?.heights??new Map<string,number>();
  let starts:number[];
  if(sizing?.manual&&sizes){
    const room=sizing.allocated-sizes.shell;
    starts=tablePages(keys,heights,fallback,room-sizes.singleFooter,sizes.border);
    if(starts.length>1)starts=tablePages(keys,heights,fallback,room-sizes.footer,sizes.border);
  }else starts=Array.from({length:Math.max(1,Math.ceil(keys.length/TABLE_PAGE_ROWS))},(_,i)=>i*TABLE_PAGE_ROWS);
  const page=Math.min(position.key===resetKey?position.page:0,starts.length-1),from=starts[page],to=starts[page+1]??keys.length;
  useLayoutEffect(()=>{if((position.key!==resetKey&&position.page!==0)||((sizes||!sizing?.manual||!keys.length)&&position.page!==page))setPosition({key:resetKey,page});},[resetKey,page,position,!!sizes,sizing?.manual,keys.length]);
  const update=useRef<(reuseRows?:boolean)=>void>(()=>{});
  update.current=(reuseRows=false)=>{
    const root=panel.current;if(!root||suspended.current===root)return;
    const rect=root.getBoundingClientRect();
    // A hidden panel has no row geometry. Refresh the rows on the next real
    // layout read, even if the panel returns to its last measured size.
    if(rect.width===0){seen.current=null;rowRun.current=null;return;}
    suspended.current=null;
    const outer=pixels(rect.height-fillOf(root));
    const signal={key:JSON.stringify([scope,keysKey,from,to,sizing?.manual]),outer,live:pixels(live.current?.getBoundingClientRect().height??0),
      layer:pixels(measured.current?.getBoundingClientRect().height??0),footer:pixels(measuredFooter.current?.getBoundingClientRect().height??0),singleFooter:pixels(measuredSingleFooter.current?.getBoundingClientRect().height??0)};
    const last=seen.current;
    // The grid can change only a panel's fill. Its rows and chrome need no new reads.
    if(last&&last.key===signal.key&&same(last.outer,signal.outer)&&same(last.live,signal.live)&&same(last.layer,signal.layer)&&same(last.footer,signal.footer)&&same(last.singleFooter,signal.singleFooter))return;
    seen.current=signal;
    const items=[...(live.current?.children??[])].filter(e=>!(e as HTMLElement).hasAttribute('data-table-total')) as HTMLElement[];
    if(!items.length){
      rowRun.current=null;
      sizing?.report({min:outer,natural:outer,shown:outer});if(measurement)setMeasurement(null);
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
    sizing?.report({min:pixels(min),natural:pixels(Math.max(min,natural)),shown:outer});
    if(!sizes||!same(sizes.shell,shell)||!same(sizes.footer,multiFooter)||!same(sizes.singleFooter,singleFooter)||!same(sizes.border,border)||!same(sizes.fallback,base)||nextHeights.size!==sizes.heights.size||[...nextHeights].some(([key,height])=>!same(sizes.heights.get(key),height)))
      setMeasurement({scope,heights:nextHeights,fallback:base,shell,footer:multiFooter,singleFooter,border});
  };
  const keysKey=keys.join('\n'),columnsKey=columns.join(',');
  useLayoutEffect(()=>update.current(),[layout,scope,keysKey,sizing?.manual,sizing?.allocated,columnsKey]);
  useLayoutEffect(()=>{
    const body=sizing?.manual?measured.current:live.current;
    const rows=new Set([...(body?.children??[])].filter(row=>!row.hasAttribute('data-table-total')));
    const observer=new ResizeObserver(entries=>{
      const root=panel.current,entry=entries.find(entry=>entry.target===root),box=entry?.borderBoxSize;
      if(root&&box?.length===1&&box[0].inlineSize===0){suspended.current=root;return;}
      const resumed=!!root&&suspended.current===root&&!!entry;
      if(resumed){suspended.current=null;seen.current=null;rowRun.current=null;}
      if(suspended.current===root)return;
      const resized=resumed||entries.some(entry=>{
        if(!rows.has(entry.target))return false;
        const previous=rowBoxes.current.get(entry.target),box=entry.borderBoxSize?.length===1?entry.borderBoxSize[0]:undefined;
        return !previous||!box||!same(previous.width,box.inlineSize)||!same(previous.height,box.blockSize);
      });
      // Initial row notifications repeat the boxes already read by the layout effect.
      if(resized){seen.current=null;rowRun.current=null;}
      if(resized||entries.some(entry=>!rows.has(entry.target)))flushSync(()=>update.current(!resized));
    });
    for(const element of [panel.current,live.current,measured.current,footer.current,measuredFooter.current,measuredSingleFooter.current])if(element)observer.observe(element);
    for(const row of rows)observer.observe(row,{box:'border-box'});
    return ()=>observer.disconnect();
  },[panel,layout,measurable,!!keys.length,keysKey,from,to,sizing?.manual]);
  const report=sizing?.report;useLayoutEffect(()=>()=>report?.(null),[report]);
  return useMemo(()=>({layout,measurable,columnWidths:columns,from,to,page,count:keys.length,pages:starts.length,onPage:(page:number)=>setPosition({key:resetKey,page}),live,measured,footer,measuredFooter,measuredSingleFooter,
    measureFrom:from,measureTo:sizing?.manual?Math.min(keys.length,Math.max(from+TABLE_MEASURE_MIN_ROWS,to+1)):from}),[layout,measurable,columnsKey,from,to,page,starts.length,resetKey,sizing?.manual,keys.length]);
}
export type TableWidget=ReturnType<typeof useTableWidget>;
export function TableMeasure({table,children,metrics,columns}:{table:TableWidget;children:ReactNode;metrics?:readonly TableMetric[];columns?:readonly string[]}){
  if(!table.measurable)return null;
  return <div className="table-measure" aria-hidden="true" inert>{children}<TableFooter table={table} count={table.count} metrics={metrics} columns={columns} still body={table.measuredFooter}/><TableFooter table={table} count={table.count} metrics={metrics} columns={columns} still single body={table.measuredSingleFooter}/></div>;
}
export function WidgetPages({table,count,metrics,columns}:{table:TableWidget;count:number;metrics?:readonly TableMetric[];columns?:readonly string[]}){
  return <TableFooter table={table} count={count} metrics={metrics} columns={columns} body={table.footer}/>;
}
