import * as retention from '../../server/domain/periodRetention';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PageClock} from '../lib/clock';
import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import {HistoryPool} from '../lib/historyPool';
import {PeriodTransport} from '../lib/periodTransport';
import {drain,type Preparation} from '../lib/prepare';
import {evaluatedRange,periodKey} from '../../server/domain/period';
import {PERIOD_SCOPES,type PeriodRequest} from '../../server/domain/periodRead';
import {packWorkPrepared,workPreparationBytes,mergeWorkPrepared,type WorkedSession,type WorkTrace} from '../../server/domain/periodWork';
import {sampleBytes} from '../../server/domain/periodTape';
import {byActivity,columnsOf,groupsOf,sortedGroups,visibleAgentsSort,type AgentsBy,type AgentsSort} from '../lib/agents';
import {AGENTS,ACTIVITY,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS} from '../../server/domain/widgets';
import {columnShown} from '../lib/view';
import {EMPTY_VIEW} from '../../server/domain/view';
import {selector,sameJson} from '../lib/store';
import {periodOf} from '../lib/periods';
import {periodTextChangesAt} from '../lib/periodClock';
import {workHours} from '../lib/format';
import type {SessionOrder} from '../lib/period';

const H=3_600_000,ref=(id:string,project:string,source:string|null='s')=>({ref:id,source,device:{id:project,name:project},origin:'terminal' as const,project,folder:null,startedAt:0});
const compile=(body:string)=>ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const coordinator=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
type Order=(rows:WorkedSession[])=>SessionOrder|null;

/** Read the component's actual filtered group/dialog demand, before DOM hooks. */
function agentOrder({by='project',hidden=[] as string[],open=false,sort={column:'worked',descending:true} as AgentsSort}={}):Order{
  let order:Order=()=>null;const done={};
  const source=readFileSync(new URL('../components/Agents.tsx',import.meta.url),'utf8');
  const context={exports:{} as {AgentsPanel:(props:unknown)=>unknown},memo:(f:unknown)=>f,useLocale:()=>{},useLineup:()=>['s','hidden'],useTitles:()=>({s:{title:'Source',provider:'codex'},hidden:{title:'Hidden',provider:'codex'}}),
    usePrefs:()=>({agentsSort:sort,agentsBy:by as AgentsBy}),useState:()=>[open?{group:null}:null,()=>{}],useCallback:(f:unknown)=>f,
    usePeriodSessions:(read:Order)=>{order=read;throw done;},columnsOf,columnShown,AGENTS,groupsOf,sortedGroups,visibleAgentsSort,byActivity,require:()=>({})};
  runInNewContext(compile(source.slice(source.indexOf('export const AgentsPanel'))),context);
  try{context.exports.AgentsPanel({arrange:{view:{...EMPTY_VIEW,hidden}}});}catch(error){assert.equal(error,done);}
  return order;
}

async function harness(trace:WorkTrace){
  let now=H+1000,visible=true,reads=0;
  const timers=new Map<object,{at:number;run:()=>void}>(),pool=new HistoryPool();
  const clock=new PageClock({now:()=>now,visible:()=>visible,setTimeout:(run,ms)=>{const token={};timers.set(token,{at:now+ms,run});return token;},clearTimeout:token=>{timers.delete(token as object);}});
  const board={id:'b',meta:{personal:true},lineup:['s','hidden'],view:EMPTY_VIEW,cards:{s:{id:'s'},hidden:{id:'hidden'}}};
  const context={exports:{} as any,hubNow:clock.hubNow,clock,retention,historyPool:pool,PeriodTransport,
    fetchPeriod:async(_board:string,request:PeriodRequest)=>{reads++;const basis={run:'r',revision:'1',evaluatedAt:now,evidenceCut:now,range:evaluatedRange(request.selection,now)};return {basis,sessions:{state:'complete',basis,value:trace}};},
    page:{get:()=>({board}),dispatch:()=>{}},pan:{get:()=>null},preparations:()=>null,prepareAsync:async(_owner:unknown,work:Preparation<unknown>)=>drain(work),
    evaluatedRange,periodKey,PeriodIndex,PeriodActivity,packWorkPrepared,workPreparationBytes,mergeWorkPrepared,sampleBytes,periodTextChangesAt,
    empty:()=>({value:null,basis:null,loading:false,error:null}),sameJson,timeRange:()=>null,prefs:()=>({range:'1h'}),periodOf,cellOf:()=>60_000,
    PERIOD_SCOPES,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,ACTIVITY,AGENTS,widgetVisible:(_view:unknown,id:string)=>id===AGENTS,noSessions:[],noValue:{}};
  runInNewContext(compile(coordinator.slice(coordinator.indexOf('class BoardPeriod'),coordinator.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod')),context);
  const period=new context.exports.BoardPeriod();period.activate(true);
  for(let i=0;i<50;i++)await Promise.resolve();
  assert.equal(period.get().loading,false);assert.equal(period.get().error,null);assert.equal(reads,1);
  function advance(to:number){
    for(let i=0;;i++){
      assert.ok(i<100,'the common clock cannot spin');const entry=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
      if(!entry||entry[1].at>to)break;now=entry[1].at;timers.delete(entry[0]);entry[1].run();
    }
    now=to;
  }
  return {period,clock,pool,timers,advance,now:()=>now,reads:()=>reads,setVisible:(value:boolean)=>{visible=value;clock.wakeDue();},close:()=>{period.activate(false);assert.equal(timers.size,0);assert.equal(pool.activeFlights,0);}};
}

/** Effects and external-store equality from the actual hook, including remount. */
function panel(period:any,initial:Order){
  let order=initial,cursor=0,dirty=false,renders=0,value:any;
  const slots:any[]=[],pending:(()=>void)[]=[];
  const slot=(make:()=>any)=>{const i=cursor++;return slots[i]??(slots[i]=make());};
  const context={exports:{} as {usePeriodSessions:(order:Order)=>unknown},boardPeriod:period,selector,sameJson,
    useRef:(current:unknown)=>slot(()=>({current})),useState:(make:()=>unknown)=>[slot(()=>({value:make()})).value],
    useLayoutEffect:(effect:()=>void|(()=>void),deps?:unknown[])=>{const state=slot(()=>({deps:null,stop:null,effect}));state.effect=effect;if(!deps||!state.deps||deps.some((v,i)=>!Object.is(v,state.deps[i]))){state.deps=deps;pending.push(()=>{state.stop?.();state.stop=effect();});}},
    useSyncExternalStore:(subscribe:(listener:()=>void)=>()=>void,read:()=>unknown)=>{
      const state=slot(()=>{const state={value:read(),stop:()=>{}};state.stop=subscribe(()=>{const next=read();if(next!==state.value){state.value=next;dirty=true;}});return state;});
      state.value=read();return state.value;
    }};
  runInNewContext(compile(coordinator.slice(coordinator.indexOf('const roster='),coordinator.indexOf('export function useSourcePeriodSessions'))),context);
  function render(){for(let i=0;;i++){assert.ok(i<5,'selector and clock effects cannot render in a loop');cursor=0;dirty=false;value=context.exports.usePeriodSessions(order);renders++;while(pending.length)pending.shift()!();if(!dirty)break;}return value;}
  render();
  return {render:()=>dirty?render():value,setOrder:(next:Order)=>{order=next;return render();},rows:()=>value.rows as WorkedSession[],renders:()=>renders,
    strictRemount:()=>{for(const state of slots)if(state.effect){state.stop?.();state.stop=state.effect();}},
    close:()=>{for(const state of slots)state.stop?.();}};
}

test('the real common clock updates worked order before its labels diverge, without reading or rerendering duration-only panels',async()=>{
  const h=await harness({anchor:0,knownFrom:0,refs:[ref('a','A'),ref('b','B')],spans:[[0,0,160_000],[1,300_000,455_000]]});
  const order=agentOrder(),sorted=panel(h.period,order),passive=panel(h.period,agentOrder({sort:null})),initialPassive=passive.renders();
  const labels=()=>['a','b'].map(id=>workHours(h.period.workedAt([id],null,h.now())));
  const keys=()=>JSON.parse(JSON.stringify(order(sorted.render().rows)!.key))[0];
  assert.deepEqual(keys(),['"A"','"B"']);assert.deepEqual(labels(),['3m','3m']);
  h.advance(H+10_250);assert.deepEqual(labels(),['2m','3m']);assert.deepEqual(keys(),['"B"','"A"']);
  passive.render();assert.equal(passive.renders(),initialPassive,'duration labels own their work; an unchanged roster/order does not rerender the panel');
  assert.equal(h.reads(),1);assert.ok(h.pool.estimatedBytes<=h.pool.budget);
  h.advance(H+455_250);assert.equal(sorted.render().rows.length,0);assert.equal(passive.render().rows.length,0);
  assert.equal(h.timers.size,0,'the final membership edge leaves no polling timer');assert.equal(h.reads(),1);
  sorted.close();passive.close();h.close();
});

test('visible subgroup sums and an opened dialog register their own crossing demand, including unknown work and ties',async()=>{
  // Each visible A context remains below B. Only their visible sum crosses B;
  // the hidden A context prevents the full prepared project curve from crossing.
  const trace:WorkTrace={anchor:0,knownFrom:0,refs:[ref('a1','A'),ref('a2','A',null),ref('hidden','A','hidden'),ref('b','B')],spans:[[0,0,90_000],[1,0,90_000],[2,300_000,900_000],[3,300_000,470_000]]};
  const h=await harness(trace),order=agentOrder({hidden:['source:hidden']}),consumer=panel(h.period,order);
  assert.deepEqual(JSON.parse(JSON.stringify(order(consumer.rows())!.worked)),[[['a1','a2'],['b']]]);
  h.advance(H+10_250);assert.deepEqual(JSON.parse(JSON.stringify(order(consumer.render().rows)!.key))[0],['"B"','"A"']);
  consumer.close();h.close();

  const dialog=await harness({anchor:0,knownFrom:0,refs:[ref('a','A'),ref('b','A')],spans:[[0,0,160_000],[1,300_000,455_000]]});
  const closed=agentOrder(),opened=agentOrder({open:true}),rows=panel(dialog.period,closed);
  dialog.advance(H+4000);rows.setOrder(opened);rows.strictRemount();assert.equal(dialog.period.workOrders.size,1,'StrictMode replaces the watch instead of leaking it');
  dialog.advance(H+10_250);const signature=JSON.parse(JSON.stringify(opened(rows.render().rows)!.key));
  assert.deepEqual(signature,[['"A"'],[['"A"',['b','a']]]]);assert.equal(dialog.reads(),1);
  rows.close();assert.equal(dialog.period.workOrders.size,0);dialog.close();
});

test('enabling worked sort reevaluates retained rows immediately, and closing it cancels the crossing wake',async()=>{
  const h=await harness({anchor:0,knownFrom:0,refs:[ref('a','A'),ref('b','B')],spans:[[0,0,160_000],[1,300_000,455_000]]});
  const passive=agentOrder({sort:null}),sorted=agentOrder(),consumer=panel(h.period,passive);
  h.advance(H+10_250);consumer.setOrder(sorted);
  assert.deepEqual(JSON.parse(JSON.stringify(sorted(consumer.rows())!.key))[0],['"B"','"A"']);assert.equal(h.reads(),1);
  consumer.close();h.close();
  const fresh=await harness({anchor:0,knownFrom:0,refs:[ref('a','A'),ref('b','B')],spans:[[0,0,160_000],[1,300_000,455_000]]}),watched=panel(fresh.period,sorted);
  const deadline=()=>[...fresh.timers.values()][0]?.at;
  assert.equal(deadline(),H+5000);watched.setOrder(passive);assert.equal(deadline(),H+160_000,'removing the demand removes only its extra crossing wake');
  fresh.setVisible(false);assert.equal(fresh.timers.size,0);fresh.advance(H+20_000);fresh.setVisible(true);assert.equal(fresh.reads(),1);
  watched.close();fresh.close();
});

test('domain crossing boundaries cover ties and future membership without minute polling',()=>{
  const index=new PeriodIndex({anchor:0,knownFrom:0,refs:[ref('a','A'),ref('b','B')],spans:[[0,0,160_000],[1,300_000,455_000]]});
  index.advance({from:1000,to:H+1000},H+1000);
  assert.equal(index.changesAt(H+1000,H,[[['a'],['b']]]),H+5000);
  assert.equal(index.changesAt(H+5000,H,[[['a'],['b']]]),H+5001,'the first strict inversion after equality must also wake');
  assert.equal(index.changesAt(H+1000,H),H+160_000,'no visible worked sort means no order crossings');
  const later=new PeriodIndex({anchor:0,knownFrom:0,refs:[ref('future','F')],spans:[[0,H+2000,H+3000]]});
  later.advance({from:1000,to:H+1000},H+1000);assert.equal(later.changesAt(H+1000,H),H+2000);
  later.advance({from:2000,to:H+2000},H+2000);assert.equal(later.changesAt(H+2000,H),H+2001,'a context enters on the first credited millisecond');
});
