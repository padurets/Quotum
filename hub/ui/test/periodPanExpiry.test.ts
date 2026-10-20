import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {HistoryStore, type Shown} from '../lib/history';
import {PageClock} from '../lib/clock';
import {Pan} from '../lib/pan';
import {shallowEqual} from '../lib/store';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {planEventsAt,planEventsDeadline} from '../../server/domain/history';
import type {History} from '../lib/types';
import type {TimeRange} from '../lib/timeRange';

const M=60_000,H=60*M;
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const historySource=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');
const hook=historySource.slice(historySource.indexOf('function usePeriodHistory('),historySource.indexOf('export function useHistory('));
const clockSource=readFileSync(new URL('../lib/clock.ts',import.meta.url),'utf8');
const clockHook=clockSource.slice(clockSource.indexOf('export function useClock(')).replace('export function','function');

/** Real owners and hooks keep validity independent of a frozen quantity frame. */
async function fixture(detached:boolean){
  let now=H,selected:TimeRange|null=null,ready=true,reads=0,projects=0,pending=false;
  const clock=new PageClock({now:()=>now,visible:()=>true,setTimeout:()=>null,clearTimeout:()=>{}});
  const store=new HistoryStore({clock,now:()=>now,preparations:null,
    read:async(_board,_cell,from,to)=>{reads++;return {run:'r',now,historyStart:0,known:{work:0,sources:{s:0}},chunks:[{from,to,series:[],activity:{sessions:[],devices:{},cells:[]},resets:[],grants:[],plans:[['s',M,'max',{at:0,plan:'old plan'},H+M+1]]}]};},
    dropTimeRange:()=>{},setTimeout:()=>null,clearTimeout:()=>{},
  },undefined,'quota');
  const pan=new Pan({now:()=>now,commit:range=>{selected=range;},requestFrame:run=>run,cancelFrame:()=>{},setTimeout:()=>null,clearTimeout:()=>{}});
  const accounting=new PeriodAccounting({from:0,cut:H,replaceFrom:0,cursor:'r',quota:[],money:[]},null);
  const slots:any[]=[];let cursor=0;
  const useRef=(current:any)=>slots[cursor++]??(slots[cursor-1]={current});
  const useMemo=(read:()=>unknown,deps:unknown[])=>{const box=useRef(null);if(!box.current||deps.some((value,i)=>!Object.is(value,box.current.deps[i])))box.current={deps,value:read()};return box.current.value;};
  const stops:(()=>void)[]=[],effects:(()=>void)[]=[];
  const useSyncExternalStore=(subscribe:(listener:()=>void)=>()=>void,get:()=>unknown)=>{
    const box=useRef(null);
    if(!box.current){const state={get,value:get()};stops.push(subscribe(()=>{const next=state.get();if(!Object.is(next,state.value)){state.value=next;pending=true;}}));box.current=state;}
    box.current.get=get;box.current.value=get();return box.current.value;
  };
  const context={useRef,useMemo,useSyncExternalStore,
    useState:(value:any)=>{const box=useRef(null);box.current??={value:typeof value==='function'?value():value};return [box.current.value,()=>{}];},
    useLayoutEffect:(effect:()=>void,deps:unknown[])=>{const box=useRef(null);if(!box.current||deps.some((value,i)=>!Object.is(value,box.current[i]))){box.current=deps;effects.push(effect);}},
    clock,hubNow:clock.hubNow,pan,shallowEqual,planEventsAt,planEventsDeadline,fundsHistory:{},page:{get:()=>({board:{id:'b'}})},
    timeRange:()=>selected,timeRangeKey:(range:TimeRange)=>`${range.from}-${range.to}`,prefs:()=>({range:'1h'}),
    boardPeriod:{subscribeProjection:()=>()=>{},getProjectionRevision:()=>0,projectionChangesAt:()=>null,projectionState:()=>({ready}),
      project:(base:History,_scope:string,at:number)=>{projects++;return accounting.project(base,selected??{from:at-H,to:at});}},
    read:null as unknown as (loader:HistoryStore,rolling:boolean)=>Shown&{drawing:History|null}};
  runInNewContext(ts.transpileModule(clockHook+'\n'+hook+'\nglobalThis.read=usePeriodHistory;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const render=()=>{cursor=0;pending=false;const value=context.read(store,false);for(const effect of effects.splice(0))effect();return value;};
  store.choose('1h',null);store.open('b');store.hello('r');store.snapshot(['s'],[],0);await flush();
  const initial=render(),initialReads=reads,presentation=store.get().presentation;
  assert.equal(initial.history!.events[0].kind==='plan'&&initial.history!.events[0].previous?.plan,'old plan');
  if(detached){
    selected={from:2*M,to:H};ready=false;store.choose('1h',selected);await flush();
    assert.equal(store.get().history!.events.length,0);assert.equal(render().history,initial.history);
    // Eviction removes the raw owner's deadline while the hook retains its frame.
    (store as unknown as {grids:Map<number,unknown>}).grids.clear();
  }
  const token=pan.begin({source:Symbol(),input:'pointer',selected,length:H,now,historyStart:0,span:H,width:100})!;
  if(!detached){store.pan({from:0,to:H,length:H,token,direction:-1});await flush();}
  render();const rawBefore=store.get(),initialProjects=projects;
  return {initial,initialReads,initialProjects,presentation,rawBefore,render,store,pending:()=>pending,reads:()=>reads,projects:()=>projects,
    async advance(at:number){now=at;clock.wakeDue();await flush();},
    close(){for(const stop of stops)stop();pan.cancel();store.close();}};
}

for(const detached of [false,true])test(`retained plan expiry uses the shared clock with ${detached?'detached raw interval':'active plot'} without HTTP or accounting work`,async()=>{
  const h=await fixture(detached);try{
    for(const [predecessor,at] of [[true,H+1],[false,H+M+1]] as const){
      await h.advance(at);assert.equal(h.pending(),true,'the retained deadline wakes even a fixed-range consumer');
      const raw=h.store.get(),result=h.render();
      assert.equal(raw.presentation,h.presentation);assert.equal(h.reads(),h.initialReads);assert.equal(h.projects(),h.initialProjects);
      if(detached)assert.equal(raw,h.rawBefore,'the retained clock works without changing or notifying raw inputs');
      for(const history of [result.history!,result.drawing!]){
        if(predecessor)assert.equal(history.events[0].kind==='plan'&&history.events[0].previous,null);
        else assert.equal(history.events.length,0);
        assert.equal(history.series,h.initial.history!.series);assert.equal(history.activity,h.initial.history!.activity);
      }
      assert.equal(h.initial.history!.events[0].kind==='plan'&&h.initial.history!.events[0].previous?.plan,'old plan','older published evidence stays immutable');
    }
  }finally{h.close();}
});
