import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {ActivitySelection,type ActivitySelectionEnv} from '../lib/activitySelection';
import {HistoryPool} from '../lib/historyPool';
import {Preparations} from '../lib/prepare';
import {defaultFilters,matchesSource,workFilter} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';
import type {PeriodRequest} from '../../server/domain/periodRead';
import {workChange} from '../lib/workChanges';
import {num,stamp,workHours} from '../lib/format';
import {atOnce,mutedKey} from '../lib/activity';
import {t,setLocale} from '../i18n';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';

const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
const require=createRequire(import.meta.url),{renderToStaticMarkup}=require('react-dom/server');
const compile=(body:string)=>ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;

for(const fixed of [false,true])for(const baseline of ['hello','snapshot','mine','lineup'] as const)test(`mounted ${fixed?'fixed':'live'} Activity retains all four metrics through a compatible ${baseline}`,async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true}),pool=new HistoryPool(),cleanups:(()=>void)[]=[];
  h.store.creditWork(h.device,NOW-20*M,NOW-5*M,[{source:h.source,client:'codex',origin:'terminal',project:'A',folder:'',startedAt:NOW-H,identity:{kind:'stable',sessionId:'A'}}]);
  h.events.flush();h.reconnect();await flush();
  const snapshot=[...h.frames].reverse().find(frame=>frame.type==='snapshot')!;
  let waiting:Promise<void>|null=null,release=()=>{},paused=false,reads=0;
  const queued:(()=>void)[]=[],scheduler=new Preparations({now:()=>performance.now(),post:run=>paused?queued.push(run):queueMicrotask(run)});
  class ScheduledSelection extends ActivitySelection {constructor(env:ActivitySelectionEnv){super({...env,scheduler:()=>scheduler});}}
  const range=fixed?{from:NOW-H,to:NOW}:null;
  const context={exports:{} as {hook:(...args:any[])=>ActivitySelection},ActivitySelection:ScheduledSelection,workChange,matchesSource,
    historyPool:pool,hubNow:()=>NOW,page:h.page,boardPeriod:h.period,timeRange:()=>range,useTimeRange:()=>range,usePref:()=> '1h',
    fetchPeriod:async(_board:string,body:PeriodRequest)=>{reads++;const answer=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,body)));await waiting;return answer;},
    useState:(init:()=>unknown)=>[init()],useRef:(current:unknown)=>({current}),useLayoutEffect:(effect:()=>void)=>effect(),useEffect:(effect:()=>()=>void)=>cleanups.push(effect()),
    activityMutedKeys:()=>['"Work project"'],effectiveFilters:()=>defaultFilters(),workFilter,defaultFilters,timeRangeKey:()=> 'fixed',periodOf:()=>({ms:H}),
    onDataFilters:()=>()=>{},UNAUTHORIZED:'unauthorized',window:{dispatchEvent:()=>{throw Error('unexpected access loss');}}};
  runInNewContext(compile(source.slice(source.indexOf('function useActivitySubset('),source.indexOf('function useSubsetNumbers('))+'\nexports.hook=useActivitySubset;'),context);
  const reader=context.exports.hook({board:h.board,activity:{barMs:M}},'project',{},1,false,true);
  const output:any={exports:{},require,memo:(value:unknown)=>value,useLocale:()=>{},useSyncExternalStore:(_subscribe:unknown,get:()=>unknown)=>get(),usePanning:()=>null,useRef:(current:unknown)=>({current}),useClock:()=>NOW,
    boardPeriod:h.period,num,workHours,stamp,atOnce,mutedKey,t,ReadState:()=>null};
  runInNewContext(compile(source.slice(source.indexOf('function Metrics('),source.indexOf('/** Keyboard descriptions'))+source.slice(source.indexOf('function useSubsetNumbers('),source.indexOf('/** Only this small region'))+source.slice(source.indexOf('const Totals=memo'),source.indexOf('type ActivityRegistry='))+'\nexports.Totals=Totals;'),output);
  let upstream:ReturnType<typeof h.hold>|null=null;
  try{
    await flush();assert.equal(reader.numbers(NOW)?.agentMs,15*M);
    const model=reader.get().model!,authority=h.page.get().board!.workAuthority,previousReads=reads;
    const render=()=>renderToStaticMarkup(output.exports.Totals({history:{range:fixed?'fixed':'1h',activity:model.activity},by:'project',subset:reader,scoped:true,allOff:false,since:null,focus:{subscribe:()=>()=>{},get:()=>null}}));
    const before=new Map<string,string>();
    for(const locale of ['en','ru'] as const){setLocale(locale);before.set(locale,render());assert.ok(render().includes('data-agent-ms="900000"'));assert.equal((render().match(/<b>—<\/b>/g)??[]).length,0);}
    paused=true;waiting=new Promise<void>(yes=>{release=yes;});
    h.event(baseline==='snapshot'?{type:'snapshot',data:JSON.parse(snapshot.data)}:baseline==='hello'?{type:'hello',data:{epoch:h.events.epoch}}:baseline==='mine'?{type:'mine',data:{sources:[]}}:{type:'lineup',data:{sources:[...h.page.get().board!.lineup]}});
    assert.equal(reader.get().model,model,'a compatible baseline cannot synchronously retire the complete numerical frame');
    await flush();assert.equal(h.page.get().board!.workAuthority,authority);
    assert.equal(reader.get().model,model,'retain the complete frame while transport or cooperative preparation is held');
    for(const locale of ['en','ru'] as const){setLocale(locale);assert.equal(render(),before.get(locale),'the actual four-value renderer stays complete throughout the held replacement');}
    assert.equal(reads-previousReads,fixed?1:0,'a fixed baseline has one bounded replacement; live uses board evidence');
    paused=false;release();waiting=null;queued.splice(0).forEach(run=>queueMicrotask(run));await flush();
    assert.equal(reader.numbers(NOW)?.agentMs,15*M);

    // A restarted hub has no right to retain the previous run's numerical evidence.
    paused=true;waiting=new Promise<void>(yes=>{release=yes;});upstream=h.hold();
    h.event({type:'hello',data:{epoch:'replacement-hub-run'}});
    assert.equal(reader.numbers(NOW),null,'a different hub run retires old work before a render');
    await flush();assert.equal(reader.get().model,null,'neither a held reply nor old board evidence can revive it');
  }finally{
    cleanups.forEach(stop=>stop());paused=false;release();upstream?.release();queued.splice(0).forEach(run=>queueMicrotask(run));await flush();scheduler.dispose();setLocale('en');
    assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);await h.close();
  }
});
