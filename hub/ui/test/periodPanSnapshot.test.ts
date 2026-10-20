import {planEventsAt,planEventsDeadline} from '../../server/domain/history';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Pan} from '../lib/pan';
import {shallowEqual} from '../lib/store';
import type {History} from '../lib/types';
import type {Shown} from '../lib/history';

const M=60_000,NOW=10*M;
const history:History={board:'b',range:'1m',live:true,since:NOW-M,to:NOW,cellMs:M,historyStart:0,events:[],series:[],activity:{since:NOW-M,known:null,barMs:M,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');
const body=source.slice(source.indexOf('function usePeriodHistory('),source.indexOf('export function useHistory('));

/** Real Pan notifications read the real hook before React chooses to render it. */
function harness(base=history,rolling=true){
  let now=NOW,clockNow=NOW,revision=0,ready=true,selected:{from:number;to:number}|null=null,projects=0,pending=false,board='b';
  let shown:Shown={history:base,loading:false,presentation:1},changesAt:(at:number)=>number|null=()=>null;
  const pan=new Pan({now:()=>now,commit:range=>{selected=range;},requestFrame:run=>run,cancelFrame:()=>{},setTimeout:()=>null,clearTimeout:()=>{}});
  const listeners=new Set<()=>void>(),projectionListeners=new Set<()=>void>();
  const loader={scope:'quota',get:()=>shown,subscribe:(listen:()=>void)=>{listeners.add(listen);return()=>listeners.delete(listen);}};
  const slots:any[]=[];let cursor=0;
  const useRef=(current:any)=>slots[cursor++]??(slots[cursor-1]={current});
  const useMemo=(read:()=>unknown,deps:unknown[])=>{const box=useRef(null);if(!box.current||deps.some((value,i)=>!Object.is(value,box.current.deps[i])))box.current={deps,value:read()};return box.current.value;};
  const subscriptions:{get:()=>unknown;value:unknown;stop:()=>unknown}[]=[];
  const useSyncExternalStore=(subscribe:(listener:()=>void)=>()=>unknown,get:()=>unknown)=>{
    const box=useRef(null);
    if(!box.current){
      const state={get,value:get(),stop:()=>{}};
      state.stop=subscribe(()=>{const next=state.get();if(!Object.is(next,state.value)){state.value=next;pending=true;}});
      subscriptions.push(state);box.current=state;
    }
    box.current.get=get;box.current.value=get();return box.current.value;
  };
  const context={useRef,useMemo,useSyncExternalStore,pan,planEventsAt,planEventsDeadline,shallowEqual,hubNow:()=>now,useClock:(changes:(at:number)=>number|null)=>{changesAt=changes;return clockNow;},usePanning:()=>useSyncExternalStore(pan.onPhase,pan.active),
    frameChangesAt:()=>null,
    fundsHistory:{},page:{get:()=>({board:{id:board}})},timeRange:()=>selected,timeRangeKey:(range:{from:number;to:number})=>`${range.from}-${range.to}`,prefs:()=>({range:'1m'}),
    boardPeriod:{subscribeProjection:(_scope:string,listen:()=>void)=>{projectionListeners.add(listen);return()=>projectionListeners.delete(listen);},getProjectionRevision:()=>revision,projectionChangesAt:()=>null,
      projectionState:()=>({ready,error:null}),project:(base:History,_scope:string,at:number)=>{projects++;return {...base,since:selected?.from??at-M,to:selected?.to??at,series:[...base.series]};}},
    read:null as unknown as (loader:unknown,rolling:boolean)=>Shown&{drawing:History|null}};
  runInNewContext(ts.transpileModule(body+'\nglobalThis.read=usePeriodHistory;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const render=()=>{cursor=0;pending=false;return context.read(loader,rolling);};
  const phase=()=>subscriptions.at(-1)!.get() as Shown;
  const begin=()=>pan.begin({source:Symbol(),input:'pointer',selected,length:M,now,historyStart:0,span:M,width:100})!;
  return {pan,render,phase,begin,pending:()=>pending,projects:()=>projects,jump:(ms:number)=>{now+=ms;},wake:()=>{clockNow=now;},
    changesAt:()=>changesAt(now),replace:(value:Shown)=>{shown=value;},retire:()=>{shown={...shown,history:null,loading:true,presentation:shown.presentation+1};},
    revision:()=>{revision++;},pendingRange:()=>{ready=false;shown={...shown,loading:true};},board:(id:string)=>{board=id;},
    close:()=>{for(const subscription of subscriptions)subscription.stop();}};
}

test('pan begin keeps the accounting snapshot and does not wake its table; release advances live quantities and drawing',()=>{
  const h=harness();try{
    const initial=h.render(),count=h.projects(),token=h.begin();
    assert.equal(h.pending(),false,'a gesture without new accounting must not render the table or its static measure');
    assert.equal(h.phase().history,initial.history);assert.equal(h.projects(),count);
    for(let i=0;i<20;i++)assert.equal(h.phase(),h.phase(),'repeated getSnapshot remains stable');
    h.jump(5_000);h.pan.finish(token);
    assert.equal(h.pending(),true);assert.equal(h.phase().history!.to,NOW+5_000,'release uses fresh hub time before a React clock context changes');
    const released=h.render();assert.equal(released.history!.to,NOW+5_000);assert.notEqual(released.drawing,initial.drawing);assert.equal(released.drawing,released.history);
  }finally{h.close();}
});

test('a skipped begin still marks the final pending range as folding without dimming retained accounting',()=>{
  const h=harness();try{
    const initial=h.render(),token=h.begin();assert.equal(h.pending(),false);
    h.pendingRange();h.pan.move(token,-20);h.pan.finish(token);
    const ending=h.phase();assert.equal(ending.history,initial.history);assert.equal(ending.loading,false,'begin bookkeeping survives a skipped consumer render');
    assert.equal(h.render().loading,false);
  }finally{h.close();}
});

test('a same-turn authority retirement reaches the phase getter before its former render closure can reuse evidence',()=>{
  const h=harness();try{
    const initial=h.render();assert.ok(initial.history);h.retire();h.begin();
    assert.equal(h.phase().history,null);assert.equal(h.pending(),true);assert.equal(h.render().drawing,null);
  }finally{h.close();}
});

test('phase release reads a new projection revision before React rerenders and repeated reads do not project again',()=>{
  const h=harness();try{
    h.render();const token=h.begin();h.jump(7_000);h.revision();h.pan.cancel(token);
    assert.equal(h.phase().history!.to,NOW+7_000);const count=h.projects();
    for(let i=0;i<20;i++)h.phase();assert.equal(h.projects(),count,'projection creates a new object and must run only for changed evidence, phase or clock');
    const release=h.render();h.jump(5_000);h.wake();const rolling=h.render();assert.equal(rolling.history!.to,NOW+12_000);assert.equal(rolling.drawing,release.drawing,'a real rolling clock changes quantities without rebuilding drawing evidence');
    const before=h.projects();h.revision();h.pan.setShift(true);
    assert.equal(h.projects(),before+1,'a same-turn projection revision must reach the getter even when the active pan token stays null');
    assert.notEqual(h.phase().history,rolling.history);
  }finally{h.close();}
});

test('retained plan facts expire before the stable getter fast path even after raw evidence loses its event',()=>{
  const event={kind:'plan' as const,sourceId:'s',at:NOW,plan:'New plan',previous:{at:NOW-M,plan:'Old plan'},expiresAt:NOW+2*M};
  const base={...history,events:[event]},h=harness(base,false);try{
    const initial=h.render(),token=h.begin(),count=h.projects();
    assert.equal(h.changesAt(),NOW+M,'a fixed range also uses the shared clock for the retained predecessor deadline');
    h.replace({history:{...base,events:[]},loading:false,presentation:1});
    assert.equal(h.phase().history,initial.history,'the gesture still retains accounting after its raw interval was replaced');
    h.jump(M);const withoutPrevious=h.phase();
    assert.equal(withoutPrevious.history!.events[0].kind,'plan');
    assert.equal((withoutPrevious.history!.events[0] as typeof event).previous,null);
    assert.equal(withoutPrevious.history!.series,initial.history!.series);assert.equal(withoutPrevious.history!.activity,initial.history!.activity);
    const drawing=h.render();assert.equal(drawing.drawing,withoutPrevious.history);assert.equal(h.changesAt(),NOW+2*M);
    assert.equal(event.previous.plan,'Old plan','expiry must not mutate the older snapshot');
    h.jump(M);const expired=h.phase();assert.equal(expired.history!.events.length,0);
    assert.equal(expired.history!.series,initial.history!.series);assert.equal(h.projects(),count,'event retirement does not project accounting');
    assert.equal(h.phase(),expired,'reads after retirement remain stable');
    assert.equal(h.render().drawing,expired.history);assert.equal(h.changesAt(),null);
    h.pan.cancel(token);assert.equal(h.phase().history!.events.length,0);
  }finally{h.close();}
});

test('a fresh accounting projection cannot revive expired facts from an unchanged raw snapshot',()=>{
  const event={kind:'plan' as const,sourceId:'s',at:NOW,plan:'Plan',previous:null,expiresAt:NOW+M};
  const h=harness({...history,events:[event]});try{
    const initial=h.render();h.jump(M);h.wake();const expired=h.render();
    assert.equal(expired.history!.events.length,0);assert.equal(expired.drawing!.events.length,0);
    assert.equal(initial.history!.events.length,1);assert.equal(h.phase(),h.phase());
  }finally{h.close();}
});
