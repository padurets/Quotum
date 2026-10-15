import * as retention from '../../server/domain/periodRetention';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Store} from '../../server/store/store';
import {Directory} from '../../server/store/directory';
import {buildApp,type Hub} from '../../server/api';
import {Ingest} from '../../server/ingest';
import {Duty} from '../../server/duty';
import {Cadence} from '../../server/cadence';
import {Pairing} from '../../server/pairing';
import {Setup} from '../../server/setup';
import {ResetFeed} from '../../server/resets';
import {Projection} from '../../server/projection';
import {newSecret} from '../../server/domain/auth';
import {deepSeekMeasurement} from '../../server/connectors/deepseek';
import {expandPeriod,type PeriodWireReply} from '../../server/domain/periodWire';
import {evaluatedRange,periodKey,type PeriodRange} from '../../server/domain/period';
import {cellOf,type History} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodScope,type PeriodRequest,type PeriodReply} from '../../server/domain/periodRead';
import {packWorkPrepared,workPreparationBytes,mergeWorkPrepared,type WorkTrace} from '../../server/domain/periodWork';
import {retainSamplesPrepared,sampleBytes,mergeTapePrepared} from '../../server/domain/periodTape';
import {hasPeriodValue,periodValueAt} from '../../server/domain/periodValues';
import {canShift,shifted} from '../../server/domain/periodShift';
import {AGENTS,ACTIVITY,WIDGETS,QUOTA_WIDGETS,BUDGET_WIDGETS,BUDGET_TABLE,SUBSCRIPTION_FUNDS,widgetVisible} from '../../server/domain/widgets';
import {PeriodTransport} from '../lib/periodTransport';
import {HistoryPool} from '../lib/historyPool';
import {drain} from '../lib/prepare';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import {periodOf} from '../lib/periods';
import {moneyReadSelection,DEFAULT_MONEY} from '../lib/moneySelection';
import {subscriptionSelection} from '../lib/subscription';
import {sameJson} from '../lib/store';
import {draggedRange} from '../lib/timeRange';

const M=60_000,H=60*M,NOW=1_800_000_025_000;
const source=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
const coordinatorCode=ts.transpileModule(source.slice(source.indexOf('class BoardPeriod'),source.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
type Coordinator={activate(active:boolean):void;changed():void;refreshWorkClock():void;projectionState(history:Pick<History,'range'>,scope:PeriodScope):{ready:boolean};get():{value:WorkTrace|null;loading:boolean;error:string|null}};

/** The production coordinator consumes authenticated HTTP replies from real stored observations. */
async function harness(t:TestContext,initial:PeriodRange|null,emptyWidgets?:string[]) {
  let now=NOW,selected=initial,held:Promise<void>|null=null;
  t.mock.method(Date,'now',()=>now);
  const store=new Store(':memory:',NOW-3*H),directory=new Directory(store.db);
  const user=directory.createUser('coverage@example.com','Coverage','unused',NOW-3*H),boardId=emptyWidgets?directory.createBoard('Empty',user.id,NOW-3*H).id:directory.boards(user.id)[0].id;
  const token=newSecret('qt_s');directory.createSession(token,user.id,NOW-3*H,24*H);
  const subscription=store.source('codex','a'.repeat(24),NOW-3*H),wallet=store.source('deepseek','b'.repeat(24),NOW-3*H);
  for(const id of [subscription,wallet])store.hold(id,user.id,NOW-3*H);
  for(const [at,used,credits,amount] of [[NOW-H-2*M,10,'2500','20'],[NOW-5*M,17,'2400','15']] as const){
    store.record(subscription,{observedAt:at,plan:'',resets:null,staleAfterMs:2*H,windows:[{id:'weekly',kind:'weekly',label:null,minutes:10080,used,remaining:100-used,resetAt:NOW+H}],balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount:credits,hasCredits:true}]});
    store.record(wallet,deepSeekMeasurement({is_available:true,balance_infos:[{currency:'USD',total_balance:amount,granted_balance:'0',topped_up_balance:amount}]},at));
  }
  const hub:Hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null};
  const app=await buildApp(hub),snapshot=new Projection(hub).snapshot(user.id,boardId,NOW)!;
  const board={id:boardId,meta:snapshot.board,lineup:snapshot.sources.map(s=>s.id),cards:Object.fromEntries(snapshot.sources.map(s=>[s.id,s])),currencies:snapshot.currencies,view:{...snapshot.view,shown:['quota-history','budget-history',SUBSCRIPTION_FUNDS],hidden:[ACTIVITY]}};
  if(emptyWidgets){board.view.shown=emptyWidgets;board.view.hidden=WIDGETS.filter(id=>!emptyWidgets.includes(id));}
  const workReads=t.mock.method(store,'agentWork');
  const pool=new HistoryPool(),attempts:PeriodRequest[]=[],replies:PeriodReply[]=[];
  const settings={range:'1h',kind:'weekly',money:{...DEFAULT_MONEY},funds:{...DEFAULT_MONEY}};
  const read=(body:PeriodRequest)=>app.inject({method:'POST',url:`/api/boards/${boardId}/period`,headers:{origin:'http://localhost',cookie:`quotum_session=${token}`},payload:body});
  const context={exports:{} as {BoardPeriod:new()=>Coordinator},hubNow:()=>now,retention,historyPool:pool,clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},PeriodTransport,
    fetchPeriod:async(_board:string,body:PeriodRequest)=>{attempts.push(body);await held;const response=await read(body);assert.equal(response.statusCode,200,response.body);const reply=expandPeriod(response.json<PeriodWireReply>());replies.push(reply);if(emptyWidgets)now++;return reply;},
    page:{get:()=>({board})},pan:{get:()=>null},preparations:()=>null,prepareAsync:async(_owner:object,work:Parameters<typeof drain>[0])=>drain(work),evaluatedRange,periodKey,PeriodAccounting,PeriodIndex,PeriodActivity,packWorkPrepared,workPreparationBytes,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,canShift,shifted,hasPeriodValue,periodValueAt,
    empty:()=>({value:null,basis:null,loading:false,error:null}),sameJson,timeRange:()=>selected,prefs:()=>settings,periodOf,cellOf,moneyReadSelection,subscriptionSelection,PERIOD_SCOPES,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,ACTIVITY,AGENTS,widgetVisible,noSessions:[],noValue:{}};
  runInNewContext(coordinatorCode,context);const period=new context.exports.BoardPeriod();
  t.after(async()=>{period.activate(false);await app.close();store.close();});
  const settle=async()=>{for(let i=0;i<300;i++){await new Promise(setImmediate);if(i>20&&!pool.activeFlights)return;}assert.fail('period request did not settle');};
  const ready=(expected:boolean)=>{const range=selected?periodKey({mode:'range',...selected}):settings.range;for(const scope of PERIOD_SCOPES)assert.equal(period.projectionState({range},scope).ready,expected,scope);};
  const part=(scope:PeriodScope)=>{const part=[...replies].reverse().find(r=>r[scope])?.[scope];assert.equal(part?.state,'complete');if(part?.state!=='complete')throw Error('incomplete');return part;};
  period.activate(true);await settle();
  return {period,pool,attempts,replies,read,settle,ready,part,now:()=>now,workReads:()=>workReads.mock.callCount(),show:(widgets:string[])=>{board.view.shown=widgets;board.view.hidden=WIDGETS.filter(id=>!widgets.includes(id));period.changed();},select:(range:PeriodRange|null)=>{selected=range;period.changed();},advance:(at:number)=>{now=at;period.refreshWorkClock();},hold:()=>{let release!:()=>void;held=new Promise(resolve=>{release=resolve;});return()=>{held=null;release();};}};
}

for(const widget of [...QUOTA_WIDGETS,...BUDGET_WIDGETS,SUBSCRIPTION_FUNDS])test(`a standalone empty ${widget} retains its own live evidence without sessions`,async t=>{
  const scope:PeriodScope=widget===SUBSCRIPTION_FUNDS?'funds':widget.startsWith('budget-')?'budget':'quota';
  const h=await harness(t,null,[widget]),tape=h.part(scope).value.tape!;
  assert.ok(h.now()>tape.cut,'the response arrives after its actual observation cut');
  assert.deepEqual(tape.quota,[]);assert.deepEqual(tape.money,[]);assert.equal(tape.cut,NOW);
  const ready=()=>assert.equal(h.period.projectionState({range:'1h'},scope).ready,true);
  ready();assert.equal(h.period.get().value,null);assert.equal(h.period.get().loading,false);
  const attempts=h.attempts.length;
  for(const elapsed of [1,M]){h.advance(h.now()+elapsed);h.period.changed();await h.settle();ready();assert.equal(h.attempts.length,attempts,'clock movement does not reread the completed empty resource');}
  const range={from:NOW-2*H,to:NOW-H};h.select(range);await h.settle();
  assert.equal(h.period.projectionState({range:periodKey({mode:'range',...range})},scope).ready,true);
  h.select(null);await h.settle();ready();
  assert.ok(h.attempts.every(request=>!request.sessions&&!request.values));
  if(scope!=='quota')assert.equal(h.workReads(),0,'money evidence does not read agent work');
});

test('empty resource families keep independent live readiness while a sibling response waits',async t=>{
  const h=await harness(t,null,[BUDGET_TABLE]),release=h.hold();
  h.show([BUDGET_TABLE,SUBSCRIPTION_FUNDS]);
  assert.equal(h.period.projectionState({range:'1h'},'budget').ready,true);
  assert.equal(h.period.projectionState({range:'1h'},'funds').ready,false);
  release();await h.settle();
  assert.equal(h.period.projectionState({range:'1h'},'funds').ready,true);
  assert.equal(h.attempts.length,2);assert.ok(!h.attempts[1].budget&&h.attempts[1].funds);
  assert.ok(h.attempts.every(request=>!request.sessions&&!request.values));assert.equal(h.workReads(),0);
});

test('a rounded drag endpoint beyond now completes quota, budget and funds without extending their evidence cut',async t=>{
  const range=draggedRange(NOW-H,NOW,NOW)!;assert.equal(range.to-NOW,35_000);
  const h=await harness(t,range);h.ready(true);
  for(const scope of PERIOD_SCOPES){
    const part=h.part(scope),tape=part.value.tape!;
    assert.equal(part.basis.evidenceCut,NOW);assert.equal(tape.cut,NOW);assert.deepEqual(tape.fixed!.range,range);
    assert.ok(scope==='quota'?tape.fixed!.quota.length>0:tape.fixed!.money.length>0,`${scope} has actual observations`);
    assert.deepEqual(tape.quota,[]);assert.deepEqual(tape.money,[],'the response is an exact summary, not a live ledger');
  }
  assert.equal(h.period.get().loading,false);assert.equal(h.period.get().value!.fixed!.activity.known!.to,NOW);
  const requests=h.attempts.length;h.period.changed();await h.settle();h.ready(true);
  assert.equal(h.attempts.length,requests,'completed fixed evidence is not reread');
});

test('complete rounded fixed summaries survive cached return and only reuse proven shifts',async t=>{
  const range=draggedRange(NOW-H,NOW,NOW)!,h=await harness(t,range);h.ready(true);
  const shiftedRange={from:range.from-40_000,to:range.to-40_000};
  for(const scope of PERIOD_SCOPES)assert.equal(canShift(h.part(scope).value.tape!.fixed!,shiftedRange),true,scope);
  const past={from:NOW-2*H,to:NOW-H};h.select(past);await h.settle();h.ready(true);
  const requests=h.attempts.length;
  h.select(range);await h.settle();h.ready(true);assert.equal(h.attempts.length,requests,'return restores the complete fixed target');
  h.select(shiftedRange);await h.settle();h.ready(true);assert.equal(h.attempts.length,requests,'a proved shift needs no HTTP request');
  assert.deepEqual(h.period.get().value!.fixed!.range,shiftedRange);
  const outside={from:range.from+2*M,to:range.to+2*M};
  for(const scope of PERIOD_SCOPES)assert.equal(canShift(h.part(scope).value.tape!.fixed!,outside),false,scope);
  const release=h.hold();h.select(outside);h.ready(false);release();await h.settle();h.ready(true);
  assert.equal(h.attempts.length,requests+1,'an unsupported shift reads a new exact target');
});

test('past and live coverage retain their guards against wrong targets and future-only requests',async t=>{
  const past={from:NOW-2*H,to:NOW-H},h=await harness(t,past);h.ready(true);
  for(const scope of PERIOD_SCOPES)assert.equal(h.period.projectionState({range:'another-period'},scope).ready,false);
  h.select(null);await h.settle();h.ready(true);
  for(const scope of PERIOD_SCOPES)assert.equal(h.part(scope).value.tape!.fixed,undefined);
  const requests=h.attempts.length;h.advance(NOW+M);await h.settle();h.ready(true);
  assert.equal(h.attempts.length,requests,'the live edge advances over its retained evidence without polling');
  const response=await h.read({version:1,selection:{mode:'range',from:NOW+2*M,to:NOW+H},evaluatedAt:NOW+M,sessions:{}});
  assert.equal(response.statusCode,400);assert.equal(response.json().error,'history_range_invalid');
});
