import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PageClock} from '../lib/clock';
import {crossingAt,forecastComparator,nextForecastSort,sortValue,visibleForecastSort,type SortRow,type ForecastSort} from '../lib/forecastSort';
import {planOrderAt} from '../lib/plan';
import {workLeftChangesAt} from '../lib/work';
import {PeriodAccounting} from '../lib/periodAccounting';
import {packSamples} from '../../server/domain/periodTape';
const H=3_600_000;

test('actual Forecast order consumer crosses rolling union and agent hours without replacing cells or waking unchanged rows',()=>{
  let now=H,sort:ForecastSort={column:'work',descending:true},index=0,dirty=false,renders=0;
  const timers=new Map<object,{run:()=>void;at:number}>(),slots:any[]=[],effects:(()=>void)[]=[];
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:(run,ms)=>{const id={};timers.set(id,{run,at:now+ms});return id;},clearTimeout:id=>{timers.delete(id as object);}});
  const accounting=new PeriodAccounting({from:0,cut:2*H,replaceFrom:0,cursor:'c',money:[],quota:['A','B'].map(source=>({source,window:'w',samples:packSamples([{at:0,used:1,resetAt:4*H,staleAfterMs:4*H},{at:H,used:2,resetAt:4*H,staleAfterMs:4*H}])}))},{anchor:0,knownFrom:0,cut:2*H,refs:['a','parallel','b'].map((ref,i)=>({ref,source:i<2?'A':'B',device:{id:'d',name:'Device'},origin:'terminal',project:null,folder:null,startedAt:0})),spans:[[0,0,160_000],[1,0,100_000],[2,300_000,455_000]]});
  const models:SortRow[]=['A','B'].map(name=>({line:{key:name,sourceId:name,windowId:'w',provider:'codex',kind:'weekly',label:null,minutes:10080,name,color:'blue',dash:'',points:[],current:98,remainingAtStart:99,remainingAtEnd:98,consumed:1,coveredMs:H,staleAfterMs:4*H,work:null},live:{id:'w',kind:'weekly',label:null,minutes:10080,remaining:98,used:2,resetAt:4*H},measuredAt:H,ahead:null,context:{windows:[],freeResets:0,announced:null},plan:null}));
  const rows=models.map(model=>({key:model.line.key,name:model.line.name,cells:{work:{content:'kept'},agenthours:{content:'kept'}}}));
  const props={rows,models,columns:[{id:'work',title:'Work'},{id:'agenthours',title:'Agent hours'}],fixed:false,rangeKey:'1h'};
  const slot=(make:()=>any)=>{const at=index++;return slots[at]??(slots[at]=make());};
  const context={exports:{} as {SortedForecast:(props:unknown)=>{props:{children:any[]}}},require:()=>({jsxs:(_type:unknown,props:unknown)=>({props}),jsx:(_type:unknown,props:unknown)=>({props})}),memo:(fn:unknown)=>fn,
    usePref:()=>sort,useLocale:()=> 'en',useRef:(current:unknown)=>slot(()=>({current})),useState:(make:()=>unknown)=>[slot(make)],useMemo:(make:()=>unknown)=>make(),useCallback:(fn:unknown)=>fn,
    useLayoutEffect:(run:()=>void)=>effects.push(run),
    useSyncExternalStore:(subscribe:(notify:()=>void)=>()=>void,read:()=>unknown)=>{const state=slot(()=>{const state={value:read(),stop:()=>{}};state.stop=subscribe(()=>{const next=read();if(next!==state.value){state.value=next;dirty=true;}});return state;});state.value=read();return state.value;},
    clock,hubNow:()=>now,sortValue,forecastComparator,crossingAt,nextForecastSort,visibleForecastSort,planOrderAt,workLeftChangesAt,
    boardPeriod:{quotaAt:(line:SortRow['line'],at:number)=>({...line,...accounting.quotaSummary(line.sourceId,line.windowId,{from:at-H,to:at})}),quotaOrderAt:(line:SortRow['line'],at:number,_range:string,active:boolean)=>accounting.quotaWorkSlope(line.sourceId,line.windowId,at,H,active)},
    FORECAST_WIDTHS:{limit:100},AnalyticsPanel:()=>{},TableSortMenu:()=>{},TableMeasure:()=>{},WidgetPages:()=>{},useTableWidget:(_panel:unknown,_columns:unknown,_name:unknown,keys:string[])=>({layout:'table',from:0,to:keys.length,measureFrom:0,measureTo:0}),AnalyticsTable:()=>{},setPrefs:()=>{},t:()=> 'Limit'};
  const source=readFileSync(new URL('../components/Forecast.tsx',import.meta.url),'utf8'),start=source.indexOf('const SortedForecast=');
  runInNewContext(ts.transpileModule(`export ${source.slice(start,source.indexOf('/**',start))}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const render=()=>{index=0;dirty=false;renders++;const value=context.exports.SortedForecast(props).props.children[1].props.children[0].props.rows as typeof rows;effects.splice(0).forEach(run=>run());return value;};
  let ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['A','B']);
  now=H+5000;clock.wakeDue();assert.equal(dirty,false,'equality keeps the existing default tie');
  now++;clock.wakeDue();assert.equal(dirty,true);ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['B','A']);assert.equal(ordered[0],rows[1]);assert.equal(ordered[1].cells,rows[0].cells);
  const commits=renders;now+=10_000;clock.wakeDue();assert.equal(dirty,false);assert.equal(renders,commits);
  sort={column:'agenthours',descending:true};ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['A','B']);
  now=H+52_501;clock.wakeDue();ordered=render();assert.deepEqual(Array.from(ordered,row=>row.key),['B','A']);
  for(const state of slots)state.stop?.();assert.equal(timers.size,0);
});
