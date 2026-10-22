import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {ActivitySelection} from '../lib/activitySelection';
import type {Preparations} from '../lib/prepare';
import {HistoryPool} from '../lib/historyPool';
import {defaultFilters,matchesSource,workFilter} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';
import type {PeriodRequest} from '../../server/domain/periodRead';
import {workChange} from '../lib/workChanges';
import {num,stamp,workHours} from '../lib/format';
import {atOnce,mutedKey} from '../lib/activity';
import {t} from '../i18n';
import {ACTIVITY} from '../../server/domain/widgets';
import {chartMuteKey} from '../lib/prefs';
import {fixture,drawings,flush,NOW,H} from './periodRuntimeFixture';

const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
const compile=(body:string)=>ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
type Fixture=Awaited<ReturnType<typeof fixture>>;
type Drawing=Awaited<ReturnType<typeof drawings>>;

/** Run the actual subset hook, summary renderer and shared drawing on one producer. */
export function mounted(h:Fixture,frame:ReturnType<Drawing['renderActivity']>,send:(board:string,request:PeriodRequest)=>Promise<ReturnType<typeof expandPeriod>>,scheduler?:Preparations,mutedKeys=['"Work project"'],onMute:(key:string,on:boolean)=>void=()=>{}) {
  const keyContext={exports:{} as any,ACTIVITY};runInNewContext(compile(source.slice(source.indexOf('export function activityMutedKeys('),source.indexOf('function useActivitySubset('))+'\nexports.keys=activityMutedKeys;'),keyContext);
  const initialMask=Object.fromEntries(mutedKeys.map(key=>['activity:project:'+key,true]));
  const pool=new HistoryPool(),cleanups:(()=>void)[]=[],ref={current:()=>{}};
  let reader:ActivitySelection|undefined,hooked=false;
  const context={exports:{} as any,ActivitySelection:scheduler?class extends ActivitySelection{constructor(env:ConstructorParameters<typeof ActivitySelection>[0]){super({...env,scheduler:()=>scheduler??null});}}:ActivitySelection,workChange,matchesSource,historyPool:pool,hubNow:()=>NOW,page:h.page,boardPeriod:h.period,
    fetchPeriod:send,useState:(init:()=>ActivitySelection)=>[reader??(reader=init())],useRef:()=>ref,useTimeRange:()=>h.selectedRange(),timeRange:()=>h.selectedRange(),usePref:()=> '1h',
    useLayoutEffect:(effect:()=>void)=>effect(),useEffect:(effect:()=>()=>void)=>{if(!hooked){hooked=true;cleanups.push(effect());}},
    activityMutedKeys:keyContext.exports.keys,effectiveFilters:()=>defaultFilters(),workFilter,defaultFilters,timeRangeKey:(range:{from:number;to:number})=>`${range.from}-${range.to}`,periodOf:()=>({ms:H}),
    onDataFilters:()=>()=>{},UNAUTHORIZED:'unauthorized',window:{dispatchEvent:()=>{throw Error('unexpected access loss');}}};
  runInNewContext(compile(source.slice(source.indexOf('function useActivitySubset('),source.indexOf('function useSubsetNumbers('))+'\nexports.hook=useActivitySubset;'),context);
  const rerender=(next:typeof frame)=>context.exports.hook(next.history,'project',initialMask,next.presentation,false,mutedKeys.length>0) as ActivitySelection;
  const subset=rerender(frame);
  const output={exports:{} as any,require,ACTIVITY,chartMuteKey,setMuted:onMute,memo:(value:unknown)=>value,useLocale:()=>{},useId:()=> 'legend',useState:()=>[false,()=>{}],seriesFocusStyle:()=>({}),useSyncExternalStore:(_subscribe:unknown,get:()=>unknown)=>get(),usePanning:()=>null,
    useRef:(current:unknown)=>({current}),useClock:()=>h.clock.hubNow(),boardPeriod:h.period,num,stamp,workHours,atOnce,mutedKey,t,ReadState:()=>null};
  const body=source.slice(source.indexOf('function Metrics('),source.indexOf('/** Keyboard descriptions'))+
    source.slice(source.indexOf('function useSubsetNumbers('),source.indexOf('/** Only this small region'))+
    source.slice(source.indexOf('const Totals=memo'),source.indexOf('type ActivityRegistry='))+source.slice(source.indexOf('const LegendItem = memo'),source.indexOf('/** Keep dormant'))+'\nexports.Totals=Totals;exports.LegendItem=LegendItem;';
  runInNewContext(compile(body),output);
  const render=(next:typeof frame)=>require('react-dom/server').renderToStaticMarkup(output.exports.Totals({history:next.drawing,by:'project',subset,scoped:true,allOff:false,since:null,focus:{subscribe:()=>()=>{},get:()=>null}})) as string;
  const renderProps=(props:Record<string,unknown>)=>require('react-dom/server').renderToStaticMarkup(output.exports.Totals(props)) as string;
  const legend=(props:Record<string,unknown>)=>require('react-dom/server').renderToStaticMarkup(output.exports.LegendItem(props)) as string;
  return {click:(props:Record<string,unknown>)=>{const node=output.exports.LegendItem(props);node.props.children[0].props.onClick();},hook:(...args:any[])=>context.exports.hook(...args),reader:subset,rerender,pool,render,renderProps,legend,async close(){cleanups.forEach(stop=>stop());subset.reset();await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);}};
}
