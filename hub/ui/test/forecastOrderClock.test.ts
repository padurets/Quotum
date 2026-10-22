import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PageClock} from '../lib/clock';
import {crossingAt,forecastComparator,nextForecastSort,sortValue,visibleForecastSort,type SortRow,type ForecastSort} from '../lib/forecastSort';
import {planOrderAt} from '../lib/plan';
import {outlookChangesAt} from '../lib/forecast';
import {workLeftChangesAt} from '../lib/work';
import {PeriodAccounting} from '../lib/periodAccounting';
import {packSamples} from '../../server/domain/periodTape';
const H=3_600_000;

test('actual Forecast order consumer crosses rolling union and agent hours without replacing cells or waking unchanged rows',()=>{
  let now=H,sort:ForecastSort={column:'work',descending:true},index=0,dirty=false,renders=0,quotaReads=0,orderReads=0,hasOrderHistory=true;
  const requested:unknown[]=[];
  const timers=new Map<object,{run:()=>void;at:number}>(),slots:any[]=[],effects:(()=>void)[]=[];
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const id={};timers.set(id,{run,at:now+ms});return id;},clearTimeout:id=>{timers.delete(id as object);}});
  const accounting=new PeriodAccounting({from:0,cut:2*H,replaceFrom:0,cursor:'c',money:[],quota:['A','B'].map(source=>({source,window:'w',samples:packSamples([{at:0,used:1,resetAt:4*H,staleAfterMs:4*H},{at:H,used:2,resetAt:4*H,staleAfterMs:4*H}])}))},{anchor:0,knownFrom:0,cut:2*H,refs:['a','parallel','b'].map((ref,i)=>({ref,source:i<2?'A':'B',device:{id:'d',name:'Device'},origin:'terminal',project:null,folder:null,startedAt:0})),spans:[[0,0,160_000],[1,0,100_000],[2,300_000,455_000]]});
  const models:SortRow[]=['A','B'].map(name=>({line:{key:name,sourceId:name,windowId:'w',provider:'codex',kind:'weekly',label:null,minutes:10080,name,color:'blue',dash:'',points:[],current:98,remainingAtStart:99,remainingAtEnd:98,consumed:1,coveredMs:H,staleAfterMs:4*H,work:null},live:{id:'w',kind:'weekly',label:null,minutes:10080,remaining:98,used:2,resetAt:4*H},measuredAt:H,ahead:null,context:{windows:[],freeResets:0,announced:null},plan:null}));
  const rows=models.map(model=>({key:model.line.key,name:model.line.name,cells:{work:{content:'kept'},agenthours:{content:'kept'}}}));
  const props={rows,models,columns:[{id:'work',title:'Work'},{id:'agenthours',title:'Agent hours'}],fixed:false,rangeKey:'1h',loading:false};
  const slot=(make:()=>any)=>{const at=index++;return slots[at]??(slots[at]=make());};
  const context={exports:{} as {SortedForecast:(props:unknown)=>{props:{children:any[]}}},require:()=>({jsxs:(_type:unknown,props:unknown)=>({props}),jsx:(_type:unknown,props:unknown)=>({props})}),memo:(fn:unknown)=>fn,
    usePref:()=>sort,useLocale:()=> 'en',useRef:(current:unknown)=>slot(()=>({current})),useState:(make:()=>unknown)=>[slot(make)],useMemo:(make:()=>unknown)=>make(),useCallback:(fn:unknown)=>fn,
    useLayoutEffect:(run:()=>void)=>effects.push(run),
    useSyncExternalStore:(subscribe:(notify:()=>void)=>()=>void,read:()=>unknown)=>{const state=slot(()=>{const state={value:read(),stop:()=>{}};state.stop=subscribe(()=>{const next=read();if(next!==state.value){state.value=next;dirty=true;}});return state;});state.value=read();return state.value;},
    clock,hubNow:()=>now,sortValue:(...args:Parameters<typeof sortValue>)=>{requested.push(args[4]);return sortValue(...args);},forecastComparator,crossingAt,nextForecastSort,visibleForecastSort,planOrderAt,workLeftChangesAt,outlookChangesAt,
    boardPeriod:{quotaAt:(line:SortRow['line'],at:number)=>(quotaReads++,{...line,...accounting.quotaSummary(line.sourceId,line.windowId,{from:at-H,to:at})}),quotaOrderAt:(line:SortRow['line'],at:number,_range:string,active:boolean)=>(orderReads++,hasOrderHistory?accounting.quotaWorkSlope(line.sourceId,line.windowId,at,H,active):{slope:0,next:Infinity})},
    FORECAST_WIDTHS:{limit:100},AnalyticsPanel:()=>{},TableSortMenu:()=>{},TableMeasure:()=>{},WidgetPages:()=>{},TableSurface:'surface',useTableWidget:(_panel:unknown,_columns:unknown,_name:unknown,keys:string[])=>({layout:'table',from:0,to:keys.length,measureFrom:0,measureTo:0}),AnalyticsTable:()=>{},setPrefs:()=>{},t:()=> 'Limit'};
  const source=readFileSync(new URL('../components/Forecast.tsx',import.meta.url),'utf8'),start=source.indexOf('const SortedForecast=');
  runInNewContext(ts.transpileModule(`export ${source.slice(start,source.indexOf('/**',start))}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{index=0;dirty=false;renders++;const value=context.exports.SortedForecast(props).props.children[0].props.children[1].props.rows as typeof rows;effects.splice(0).forEach(run=>run());return value;};
  let ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['A','B']);
  // A presentation-only prop changes the memoized consumer's props, not its models.
  const initialTimer=[...timers][0];assert.ok(initialTimer);assert.equal(timers.size,1);assert.ok(initialTimer[1].at>now);
  const retained=ordered,beforeCommit=quotaReads;props.loading=true;ordered=render();
  assert.deepEqual(Array.from(ordered,row=>row.key),['A','B']);
  ordered.forEach((row,i)=>{assert.equal(row,retained[i]);assert.equal(row.cells,retained[i].cells);});
  assert.equal(timers.size,1);assert.equal(timers.get(initialTimer[0]),initialTimer[1],'the same order keeps its armed clock');
  assert.equal(quotaReads-beforeCommit,models.length,'a mounted presentation commit evaluates quota models once through its snapshot, without a second layout pass');
  const beforeWake=quotaReads;
  now=H+5000;clock.wakeDue();const unchangedReads=quotaReads-beforeWake;assert.equal(dirty,false,'equality keeps the existing default tie');
  now++;clock.wakeDue();assert.equal(dirty,true);ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['B','A']);assert.equal(ordered[0],rows[1]);assert.equal(ordered[1].cells,rows[0].cells);
  const commits=renders;now+=10_000;clock.wakeDue();assert.equal(dirty,false);assert.equal(renders,commits);
  sort={column:'agenthours',descending:true};ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['A','B']);
  now=H+52_501;clock.wakeDue();ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['B','A']);
  const liveDeadline=[...timers.values()][0]?.at;assert.ok(liveDeadline!==undefined);
  props.fixed=true;const fixed=render();assert.deepEqual(Array.from(fixed,row=>row.key),['A','B']);assert.equal(timers.size,0,'fixed summaries cancel the ordering wake');
  props.fixed=false;ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['B','A']);assert.equal(timers.size,1);assert.equal([...timers.values()][0].at,liveDeadline,'returning live restores its current ordering deadline');
  ordered.forEach(row=>assert.equal(row,rows.find(original=>original.key===row.key)));
  for(const state of slots)state.stop?.();assert.equal(timers.size,0);slots.length=0;
  ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['B','A']);assert.equal(timers.size,1);assert.equal([...timers.values()][0].at,liveDeadline,'a remounted watch subscribes with the deadline computed by its snapshot');
  for(const selected of [null,{column:'name' as const,descending:false},{column:'name' as const,descending:true}]){
    sort=selected;const beforeQuota=quotaReads,beforeOrder=orderReads,beforeKeys=requested.length;
    ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),selected?.descending?['B','A']:['A','B']);
    assert.equal(quotaReads,beforeQuota,'live default and name order read current values without a history summary');
    assert.equal(orderReads,beforeOrder,'work-history edges do not affect default or name ordering');
    assert.ok(requested.length>beforeKeys);assert.ok(requested.slice(beforeKeys).every(column=>column==='name'),'the actual snapshot reader requests no unused numeric keys');
    assert.equal([...timers.values()][0].at,now+H,'a distant window reset keeps the shared clock’s hourly recheck');
    const quietRenders=renders;now+=60_000;clock.wakeDue();assert.equal(orderReads,beforeOrder);assert.equal(dirty,false);assert.equal(renders,quietRenders);
    assert.equal(timers.size,1);ordered.forEach(row=>assert.equal(row,rows.find(original=>original.key===row.key)));
  }
  // A forecast's own boundary must reorder rows even when no work-history edge wakes the table.
  hasOrderHistory=false;
  for(const selected of [null,{column:'name' as const,descending:false},{column:'name' as const,descending:true}]){
    sort=selected;const at=now+1,reset=at+H;now=at;
    const edgeModels:SortRow[]=models.map((model,i)=>({...model,
      line:{...model.line,key:`edge-${i}`,name:'Same',kind:i?'weekly':'session',minutes:i?10080:300,current:i?5:19.9},
      live:{id:'w',kind:i?'weekly':'session',label:null,minutes:i?10080:300,remaining:i?5:19.9,used:i?95:80.1,resetAt:i?reset+10*H:reset},measuredAt:at}));
    const edgeRows=rows.map((row,i)=>({...row,key:`edge-${i}`,name:'Same'}));props.models=edgeModels;props.rows=edgeRows;
    const beforeOrder=orderReads,zero=Math.ceil(at+(19.9/(80.1/4))*H);
    ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['edge-1','edge-0']);
    assert.equal([...timers.values()][0].at,zero,'an on-pace session still reaches zero before its reset');
    now=zero-1000;clock.wakeDue();assert.equal(dirty,false);
    now=zero;clock.wakeDue();assert.equal(dirty,true);ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['edge-0','edge-1']);
    ordered.forEach(row=>assert.equal(row,edgeRows.find(original=>original.key===row.key)));
    now=reset;clock.wakeDue();assert.equal(dirty,true);ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['edge-1','edge-0']);
    assert.equal(orderReads,beforeOrder,'forecast and reset boundaries need no work-summary planning');
    // Cap availability has its own exclusive deadline, without a supplier quota window.
    const until=now+1000;props.models=[{...edgeModels[0],line:{...edgeModels[0].line,current:0,capCells:[]},live:undefined,validUntil:until},edgeModels[1]];
    ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['edge-0','edge-1']);assert.equal([...timers.values()][0].at,until);
    now=until;clock.wakeDue();assert.equal(dirty,true);ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['edge-1','edge-0']);
    ordered.forEach(row=>assert.equal(row.cells,edgeRows.find(original=>original.key===row.key)!.cells));
  }
  for(const state of slots)state.stop?.();assert.equal(timers.size,0);
  assert.equal(unchangedReads,models.length,'an unchanged order wake evaluates each model once through the snapshot reader');
});
