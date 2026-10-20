import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {planEventsAt,planEventsDeadline} from '../../server/domain/history';
import {frameChangesAt} from '../lib/periods';
import {timeRangeKey} from '../lib/timeRange';
import {shallowEqual} from '../lib/store';

for(const values of ['complete','error'] as const)test(`the actual quota financial hook expires with ${values} card values without rereading or rebuilding drawing`,async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now);const h=await fixture({clocked:true,personal:true});
  const slots:any[]=[],effects:(()=>void)[]=[];let index=0,wakes=0;
  const useRef=(current:any)=>slots[index++]??(slots[index-1]={current});
  const useState=(initial:any)=>{const at=index++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;return [slots[at]];};
  const useMemo=(read:()=>unknown,deps:unknown[])=>{const box=useRef(null);if(!box.current||deps.some((v,i)=>!Object.is(v,box.current.deps[i])))box.current={deps,value:read()};return box.current.value;};
  const useSyncExternalStore=(subscribe:any,get:any)=>{
    const at=index++,old=slots[at];if(!old||old.subscribe!==subscribe){old?.stop();const next={subscribe,get,value:get(),stop:()=>{}};next.stop=subscribe(()=>{const value=next.get();if(!Object.is(value,next.value)){wakes++;next.value=value;}});slots[at]=next;}else old.get=get;return get();
  };
  const useLayoutEffect=(run:()=>void,deps:unknown[])=>{const at=index++,old=slots[at];if(!old||deps.some((v,i)=>!Object.is(v,old[i]))){slots[at]=deps;effects.push(run);}};
  try{
    if(values==='error'){
      const send=h.period.transport.send.bind(h.period.transport);
      h.period.transport.send=async(...args:any[])=>{const reply=await send(...args);if(args[1].values)reply.values={state:'error',error:'history_limit'};return reply;};
    }
    h.selectRange({from:NOW-H,to:NOW+2*H});await flush();h.requests.length=0;
    const entry=h.period.tapes.get('quota'),history={range:entry.rangeKey,live:false,since:NOW-H,to:NOW+2*H,cellMs:entry.tape.fixed.cell,historyStart:0,series:[],meterSeries:[],events:[],activity:{since:NOW-H,known:null,barMs:M,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
    const shown={history,loading:false,error:null,presentation:1},loader={scope:'quota',getFinancial:()=>shown,get:()=>shown,subscribeFinancial:()=>()=>{},subscribe:()=>()=>{}};
    const context={exports:{} as any,useRef,useState,useMemo,useSyncExternalStore,useLayoutEffect,clock:h.clock,hubNow:h.clock.hubNow,boardPeriod:h.period,pan:{active:()=>null,onPhase:()=>()=>{}},fundsHistory:{},page:h.page,timeRange:h.selectedRange,timeRangeKey,prefs:()=>h.settings,planEventsAt,planEventsDeadline,frameChangesAt,shallowEqual,read:null as any,useClock:null as any};
    const clock=readFileSync(new URL('../lib/clock.ts',import.meta.url),'utf8');
    runInNewContext(ts.transpileModule(clock.slice(clock.indexOf('export function useClock(')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);context.useClock=context.exports.useClock;
    const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');
    runInNewContext(ts.transpileModule(source.slice(source.indexOf('function usePeriodHistory('),source.indexOf('export function useHistory('))+'\nglobalThis.read=usePeriodHistory;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
    const render=()=>{index=0;const result=context.read(loader,false,true);effects.splice(0).forEach(run=>run());return result;};
    const before=render();assert.deepEqual(before.history.series.map((s:any)=>s.remainingAtEnd),[83]);
    const deadline=NOW-2*M+H+1;now=deadline-1;h.jump(now);await flush();assert.equal(wakes,0,'unchanged native state leaves the financial hook asleep');
    now=deadline;h.jump(now);await flush();assert.ok(wakes>0,'the shared deadline must notify the actual financial hook');
    const after=render();assert.deepEqual(after.history.series.map((s:any)=>s.remainingAtEnd),[null]);assert.equal(after.drawing,before.drawing);
    const settled=wakes;now+=M;h.jump(now);await flush();assert.equal(wakes,settled,'expiry is not a minute poll');
    now=NOW+2*H;h.jump(now);await flush();assert.deepEqual(render().history.series.map((s:any)=>s.remainingAtEnd),[null]);assert.equal(h.requests.length,0);
  }finally{for(const slot of slots)slot?.stop?.();await h.close();}
});
