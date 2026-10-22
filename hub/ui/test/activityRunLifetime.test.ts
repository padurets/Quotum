import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {ActivitySelection} from '../lib/activitySelection';
import {HistoryPool} from '../lib/historyPool';
import {defaultFilters,matchesSource,workFilter} from '../../server/domain/dataFilters';
import {expandPeriod} from '../../server/domain/periodWire';
import type {PeriodRequest} from '../../server/domain/periodRead';
import {workChange} from '../lib/workChanges';
import {num,stamp,workHours} from '../lib/format';
import {atOnce,mutedKey} from '../lib/activity';
import {t,setLocale} from '../i18n';
import {fixture,drawings,consumer,flush,NOW,H,M} from './periodRuntimeFixture';

const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../components/Activity.tsx',import.meta.url),'utf8');
const compile=(body:string)=>ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
type Fixture=Awaited<ReturnType<typeof fixture>>;
type Drawing=Awaited<ReturnType<typeof drawings>>;

/** Run the actual subset hook, summary renderer and shared drawing on one producer. */
function mounted(h:Fixture,frame:ReturnType<Drawing['renderActivity']>,send:(board:string,request:PeriodRequest)=>Promise<ReturnType<typeof expandPeriod>>) {
  const pool=new HistoryPool(),cleanups:(()=>void)[]=[],ref={current:()=>{}};
  let reader:ActivitySelection|undefined,hooked=false;
  const context={exports:{} as any,ActivitySelection,workChange,matchesSource,historyPool:pool,hubNow:()=>NOW,page:h.page,boardPeriod:h.period,
    fetchPeriod:send,useState:(init:()=>ActivitySelection)=>[reader??(reader=init())],useRef:()=>ref,useTimeRange:()=>h.selectedRange(),timeRange:()=>h.selectedRange(),usePref:()=> '1h',
    useLayoutEffect:(effect:()=>void)=>effect(),useEffect:(effect:()=>()=>void)=>{if(!hooked){hooked=true;cleanups.push(effect());}},
    activityMutedKeys:()=>['"Work project"'],effectiveFilters:()=>defaultFilters(),workFilter,defaultFilters,timeRangeKey:(range:{from:number;to:number})=>`${range.from}-${range.to}`,periodOf:()=>({ms:H}),
    onDataFilters:()=>()=>{},UNAUTHORIZED:'unauthorized',window:{dispatchEvent:()=>{throw Error('unexpected access loss');}}};
  runInNewContext(compile(source.slice(source.indexOf('function useActivitySubset('),source.indexOf('function useSubsetNumbers('))+'\nexports.hook=useActivitySubset;'),context);
  const rerender=(next:typeof frame)=>context.exports.hook(next.history,'project',{},next.presentation,false,true) as ActivitySelection;
  const subset=rerender(frame);
  const output={exports:{} as any,require,memo:(value:unknown)=>value,useLocale:()=>{},useSyncExternalStore:(_subscribe:unknown,get:()=>unknown)=>get(),usePanning:()=>null,
    useRef:(current:unknown)=>({current}),useClock:()=>NOW,boardPeriod:h.period,num,stamp,workHours,atOnce,mutedKey,t,ReadState:()=>null};
  const body=source.slice(source.indexOf('function Metrics('),source.indexOf('/** Keyboard descriptions'))+
    source.slice(source.indexOf('function useSubsetNumbers('),source.indexOf('/** Only this small region'))+
    source.slice(source.indexOf('const Totals=memo'),source.indexOf('type ActivityRegistry='))+'\nexports.Totals=Totals;';
  runInNewContext(compile(body),output);
  const render=(next:typeof frame)=>require('react-dom/server').renderToStaticMarkup(output.exports.Totals({history:next.drawing,by:'project',subset,scoped:true,allOff:false,since:null,focus:{subscribe:()=>()=>{},get:()=>null}})) as string;
  return {reader:subset,rerender,pool,render,async close(){cleanups.forEach(stop=>stop());subset.reset();await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);}};
}

for(const mode of ['same-run','restart-before-first','restart-before-replacement'] as const)test(`a fixed subset ${mode} admits only the observed producer before stream delivery`,async test=>{
  test.mock.method(Date,'now',()=>NOW);
  const h=await fixture({fixed:true,personal:true,initialFilters:defaultFilters()});
  const credit=(project:string,from:number,to:number)=>h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:`${project} full folder`,startedAt:NOW-H,identity:{kind:'stable',sessionId:project}}]);
  credit('Keep project',NOW-20*M,NOW-18*M);h.events.flush();await flush();
  const d=await drawings(h),shared=consumer({...h,...d}),frameA=d.renderActivity(),paintA=shared.settle(),runA=h.events.epoch;
  const queued:Parameters<typeof h.page.dispatch>[0][]=[],dispatch=h.page.dispatch,receipts:{run:string;observed:string|undefined}[]=[];
  let holdStream=false,fail=false;
  h.page.dispatch=event=>{if(holdStream&&event.type==='hub')queued.push(event);else dispatch(event);};
  const restart=()=>{holdStream=true;const baseline=h.restart();baseline();assert.notEqual(h.events.epoch,runA);assert.equal(h.page.get().hubEpoch,runA);};
  if(mode==='restart-before-first'){restart();credit('New run project',NOW-17*M,NOW-14*M);h.events.flush();await flush();}
  const local=mounted(h,frameA,async(_board,request)=>{
    if(fail){fail=false;throw Error('subset unavailable');}
    // HTTP always uses the current reader; only the real stream frames wait.
    const reply=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,request)));
    receipts.push({run:reply.basis.run,observed:h.page.get().hubEpoch});return reply;
  });
  try{
    await flush();
    const first=local.reader.get().model;
    if(mode!=='restart-before-first'){
      assert.equal(local.reader.numbers(NOW)?.agentMs,2*M);
      fail=true;local.reader.retry();await flush();
      assert.equal(local.reader.get().error,'history_failed');assert.equal(local.reader.get().model,first);
      if(mode==='restart-before-replacement')restart();
      credit('New run project',NOW-17*M,NOW-14*M);h.events.flush();await flush();
      local.reader.retry();await flush();
    }
    const beforeHello=d.renderActivity(),paint=shared.settle();
    assert.equal(local.pool.activeFlights,0,'a rejected producer releases its flight');
    const reads=receipts.length;await flush();assert.equal(receipts.length,reads,'waiting for stream authority does not poll');
    if(mode==='same-run'){
      assert.equal(receipts.at(-1)!.run,h.page.get().hubEpoch);
      assert.equal(local.reader.numbers(NOW)?.agentMs,5*M);
      assert.ok(paint.names.includes('New run project'));
    }else{
      assert.equal(h.page.get().hubEpoch,runA);assert.notEqual(receipts.at(-1)!.run,runA);
      assert.equal(beforeHello.history,frameA.history);assert.deepEqual(paint.paths,paintA.paths);assert.deepEqual(paint.names,paintA.names);
      assert.equal(local.reader.get().model,first,'a different producer cannot replace the complete local basis');
      assert.equal(local.reader.numbers(NOW)?.agentMs??null,mode==='restart-before-first'?null:2*M);
    }
    for(const language of ['en','ru'] as const){
      setLocale(language);const html=local.render(beforeHello);
      if(mode==='restart-before-first'){assert.equal((html.match(/<b>—<\/b>/g)??[]).length,4);assert.ok(!html.includes('data-agent-ms="300000"'));}
      else assert.ok(html.includes(`data-agent-ms="${mode==='same-run'?5*M:2*M}"`),'the actual summary uses the same admitted cohort as its drawing');
    }
    if(mode!=='same-run'){
      holdStream=false;queued.splice(0).forEach(dispatch);
      assert.equal(h.page.get().hubEpoch,h.events.epoch);assert.equal(local.reader.get().model,null,'the real new-run hello retires the old subset');
      await flush();const fresh=d.renderActivity();local.rerender(fresh);await flush();
      assert.equal(local.reader.numbers(NOW)?.agentMs,5*M);assert.equal(receipts.at(-1)!.run,h.events.epoch);
      assert.ok(shared.settle().names.includes('New run project'));
      for(const language of ['en','ru'] as const){setLocale(language);assert.ok(local.render(fresh).includes('data-agent-ms="300000"'));}
    }
  }finally{
    holdStream=false;h.page.dispatch=dispatch;queued.splice(0).forEach(dispatch);
    await local.close();d.close();await h.close();setLocale('en');
  }
});
