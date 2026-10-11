import * as retention from '../../server/domain/periodRetention';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {PeriodTransport,type PeriodIntent} from '../lib/periodTransport';
import {HistoryPool} from '../lib/historyPool';
import {HistoryStore} from '../lib/history';
import {drain} from '../lib/prepare';
import {PeriodAccounting} from '../lib/periodAccounting';
import {PeriodIndex} from '../lib/periodIndex';
import {PeriodActivity} from '../lib/periodActivity';
import {ApiError} from '../lib/http';
import {evaluatedRange,periodKey,type PeriodRange} from '../../server/domain/period';
import {cellOf,expandHistory,type History} from '../../server/domain/history';
import {PERIOD_SCOPES,type PeriodScope,type PeriodRequest,type PeriodReply} from '../../server/domain/periodRead';
import {packWorkPrepared,workPreparationBytes,mergeWorkPrepared,type WorkTrace} from '../../server/domain/periodWork';
import {retainSamplesPrepared,sampleBytes,mergeTapePrepared} from '../../server/domain/periodTape';
import {hasPeriodValue,periodValueAt} from '../../server/domain/periodValues';
import {canShift,shifted} from '../../server/domain/periodShift';
import {periodOf} from '../lib/periods';
import {moneySelection,DEFAULT_MONEY} from '../lib/moneySelection';
import {subscriptionSelection} from '../lib/subscription';
import {sameJson} from '../lib/store';
import {EMPTY_VIEW} from '../../server/domain/view';
import {AGENTS,ACTIVITY,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,widgetVisible} from '../../server/domain/widgets';

const NOW=5_000_000;
const flush=async()=>{for(let i=0;i<180;i++)await Promise.resolve();};
type Coordinator={activate(active:boolean):void;changed():void;retry():void;retryHistory(scope:PeriodScope):void;transport:PeriodTransport;get():{value:WorkTrace|null;loading:boolean;error:string|null};getValue(id:string):{loading:boolean;error:string|null};projectionState(history:Pick<History,'range'>,scope:PeriodScope):{ready:boolean;error?:string}};
type Attempt={body:PeriodRequest;signal:AbortSignal};
const source=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
const coordinatorCode=ts.transpileModule(source.slice(source.indexOf('class BoardPeriod'),source.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;

/** Only the clock, page and HTTP boundary are stand-ins; selection and the coordinator are production code. */
function harness(visible:string[]=['quota-history']) {
  const cards=Object.fromEntries(['A','B'].map(id=>[id,{id,provider:'openrouter',windows:[],meters:[]}])) as Record<string,{id:string;provider:string;windows:never[];meters:never[]}>;
  const board={id:'b',meta:{personal:true},lineup:['A','B'],cards,view:{...EMPTY_VIEW,hidden:[ACTIVITY],shown:[...visible]}};
  const settings={range:'1h',kind:'session',money:{...DEFAULT_MONEY,selected:{USD:[['A','balance']] as [string,string][]}},funds:{...DEFAULT_MONEY}};
  const pool=new HistoryPool(),attempts:Attempt[]=[],fail=new Set<PeriodScope>();
  let selected:PeriodRange|null=null,held:((attempt:Attempt)=>Promise<void>)|null=null,failWork=false,failValues=false;
  const send=async(_board:string,body:PeriodRequest,signal:AbortSignal):Promise<PeriodReply>=>{
    const attempt={body,signal};attempts.push(attempt);await held?.(attempt);
    const range=evaluatedRange(body.selection,NOW),basis={run:'run',revision:'1',evaluatedAt:NOW,evidenceCut:NOW,range},reply:PeriodReply={basis};
    for(const scope of PERIOD_SCOPES)if(body[scope])reply[scope]=fail.has(scope)?{state:'error',error:'unavailable'}:{state:'complete',basis,value:{run:'run',now:NOW,historyStart:0,known:{work:0,sources:{}},chunks:[],...(body[scope]!.evidence==='skip'?{}:{tape:{from:range.from,cut:NOW,replaceFrom:range.from,cursor:scope,quota:[],money:[]}})}};
    if(body.sessions)reply.sessions=failWork?{state:'error',error:'unavailable'}:{state:'complete',basis,value:{anchor:range.from,cut:NOW,knownFrom:0,refs:[],spans:[],cursor:'work'}};
    if(body.values)reply.values=failValues?{state:'error',error:'unavailable'}:{state:'complete',basis,value:body.values.map(id=>({id,provider:'openrouter',windows:[],meters:[],keys:[]}))};
    return reply;
  };
  const context={exports:{} as {BoardPeriod:new()=>Coordinator},hubNow:()=>NOW,retention,historyPool:pool,clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},PeriodTransport,fetchPeriod:send,page:{get:()=>({board})},pan:{get:()=>null},preparations:()=>null,
    prepareAsync:async(_owner:object,work:Parameters<typeof drain>[0])=>drain(work),evaluatedRange,periodKey,PeriodAccounting,PeriodIndex,PeriodActivity,packWorkPrepared,workPreparationBytes,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,canShift,shifted,hasPeriodValue,periodValueAt,
    empty:()=>({value:null,basis:null,loading:false,error:null}),sameJson,timeRange:()=>selected,prefs:()=>settings,periodOf,cellOf,moneySelection,subscriptionSelection,PERIOD_SCOPES,QUOTA_WIDGETS,BUDGET_WIDGETS,SUBSCRIPTION_FUNDS,ACTIVITY,AGENTS,widgetVisible,noSessions:[],noValue:{}};
  runInNewContext(coordinatorCode,context);
  const period=new context.exports.BoardPeriod();
  return {board,settings,pool,period,attempts,fail,select:(range:PeriodRange|null)=>{selected=range;period.changed();},hold:(fn:typeof held)=>{held=fn;},failWork:(value:boolean)=>{failWork=value;},failValues:(value:boolean)=>{failValues=value;}};
}
const scopes=(body:PeriodRequest)=>PERIOD_SCOPES.filter(scope=>body[scope]);

test('showing a hidden family obtains its exact evidence without rereading the ready families or sessions',async()=>{
  const h=harness();h.period.activate(true);await flush();
  assert.equal(h.period.projectionState({range:'1h'},'quota').ready,true);
  const work=h.period.get().value;h.attempts.length=0;
  h.board.view.shown.push('budget-history');h.period.changed();await flush();
  assert.equal(h.attempts.length,1);assert.deepEqual(scopes(h.attempts[0].body),['budget']);
  assert.notEqual(h.attempts[0].body.budget?.evidence,'skip');assert.equal(h.attempts[0].body.sessions,undefined);
  assert.equal(h.period.get().value,work);assert.equal(h.period.projectionState({range:'1h'},'budget').ready,true);
  h.period.changed();await flush();assert.equal(h.attempts.length,1,'unchanged demand does not poll');
  h.period.activate(false);assert.equal(h.pool.estimatedBytes,0);
});

test('a runtime money selection retires its old evidence without changing other families or presentation-only preferences',async()=>{
  const h=harness(['quota-history','budget-history']);h.period.activate(true);await flush();h.attempts.length=0;
  let finish!:()=>void;h.hold(()=>new Promise(resolve=>{finish=resolve;}));
  h.settings.money.selected.USD=[['B','balance']];h.period.changed();await flush();
  assert.equal(h.period.projectionState({range:'1h'},'budget').ready,false,'the old resource tape is not the new selection');
  assert.equal(h.period.projectionState({range:'1h'},'quota').ready,true);
  assert.equal(h.attempts.length,1);assert.deepEqual(scopes(h.attempts[0].body),['budget']);
  assert.deepEqual(JSON.parse(h.attempts[0].body.budget!.meters!),[['B','balance']]);
  assert.equal(h.attempts[0].body.sessions,undefined);finish();await flush();
  assert.equal(h.period.projectionState({range:'1h'},'budget').ready,true);
  h.settings.money.view='spending';h.settings.kind='weekly';h.period.changed();await flush();
  assert.equal(h.attempts.length,1,'view and quota kind change presentation, not evidence');
  h.period.activate(false);
});

test('hiding a pending family aborts it and a late authorization failure cannot close the remaining board',async()=>{
  const h=harness();h.period.activate(true);await flush();h.attempts.length=0;
  let reject!:(error:unknown)=>void;h.hold(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  h.board.view.shown.push('budget-history');h.period.changed();await flush();
  assert.equal(h.attempts.length,1);
  h.board.view.shown=['quota-history'];h.period.changed();await flush();
  assert.equal(h.attempts[0].signal.aborted,true);
  reject(new ApiError(404,'board_not_found'));await flush();
  assert.equal(h.period.projectionState({range:'1h'},'quota').ready,true);
  assert.equal(h.attempts.length,1);h.period.activate(false);
});

test('returning to a retained period restores only the same resource demand',async()=>{
  const h=harness(['quota-history','budget-history']);h.period.activate(true);await flush();
  const fixed={from:1_000_000,to:2_000_000};h.select(fixed);await flush();
  h.settings.money.selected.USD=[['B','balance']];h.period.changed();await flush();h.attempts.length=0;
  h.select(null);await flush();
  assert.equal(h.attempts.length,2,'the cached live A answer cannot satisfy live B');
  assert.deepEqual(JSON.parse(h.attempts.find(a=>a.body.budget)!.body.budget!.meters!),[['B','balance']]);
  h.attempts.length=0;h.select(fixed);await flush();
  assert.equal(h.attempts.length,0,'the complete fixed B target restores without a read');
  assert.equal(h.period.projectionState({range:periodKey({mode:'range',...fixed})},'budget').ready,true);
  h.period.activate(false);assert.equal(h.pool.estimatedBytes,0);
});

test('a failed family can read a new period without carrying the old error into its demand',async()=>{
  const h=harness();h.fail.add('quota');h.period.activate(true);await flush();h.attempts.length=0;
  assert.equal(h.period.projectionState({range:'1h'},'quota').error,'history_failed');
  h.fail.clear();const fixed={from:1_000_000,to:2_000_000};h.select(fixed);await flush();
  assert.equal(h.attempts.length,1);assert.ok(h.attempts[0].body.quota);
  assert.equal(h.period.projectionState({range:periodKey({mode:'range',...fixed})},'quota').ready,true);
  h.period.activate(false);
});

test('period-only navigation replaces active and queued targets before obsolete requests reach HTTP',async()=>{
  const pool=new HistoryPool(),sent:{generation:number;signal:AbortSignal}[]=[],pending:((reply:PeriodReply)=>void)[]=[];
  let generation=1;
  const intent=():PeriodIntent=>({board:'b',generation,revision:generation,request:{version:1,selection:{mode:'range',from:generation*1_000_000,to:generation*1_000_000+900_000},evaluatedAt:9_000_000,values:['s']}});
  const transport=new PeriodTransport(pool,intent,()=>{},(_board,_body,signal)=>{sent.push({generation,signal});return new Promise(resolve=>pending.push(resolve));});
  transport.change();await flush();generation=2;transport.change();await flush();
  assert.equal(sent[0].signal.aborted,true);assert.deepEqual(sent.map(s=>s.generation),[1,2]);
  transport.reset();
  const blockers=[{role:'visible' as const},{role:'visible' as const}];
  for(const flight of blockers)pool.request({estimatedBytes:0,evictionCandidates:()=>[]},flight,()=>{},()=>{});
  await flush();
  for(generation=3;generation<=7;generation++){transport.change();await flush();}
  generation=7;assert.equal(sent.length,2);
  pool.release(blockers[0]);await flush();
  assert.deepEqual(sent.map(s=>s.generation),[1,2,7],'only the latest queued target starts');
  assert.equal(pool.activeFlights,2);transport.reset();pool.release(blockers[1]);
  const basis={run:'run',revision:'1',evaluatedAt:9_000_000,evidenceCut:9_000_000,range:{from:0,to:1}};
  for(const resolve of pending)resolve({basis});await flush();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);
});

test('retiring an answer during preparation retains its slot and bytes until preparation settles',async()=>{
  const pool=new HistoryPool(4096),sent:number[]=[],published:number[]=[];
  let generation=1,finish!:()=>void;
  const basis={run:'run',revision:'1',evaluatedAt:9_000_000,evidenceCut:9_000_000,range:{from:0,to:1}};
  const intent=():PeriodIntent=>({board:'b',generation,revision:generation,request:{version:1,selection:{mode:'live',periodMs:1_000_000},evaluatedAt:9_000_000,sessions:{}}});
  const transport=new PeriodTransport(pool,intent,async(_reply,request,reserve)=>{
    if(request.generation===1){assert.equal(reserve!(1024),true);await new Promise<void>(resolve=>{finish=resolve;});}
    if(request.generation===generation)published.push(request.generation);
  },async()=>{sent.push(generation);return {basis};});
  transport.change();await flush();assert.equal(pool.activeFlights,1);assert.equal(pool.estimatedBytes,1024);
  generation=2;transport.change();await flush();
  assert.deepEqual(sent,[1]);assert.equal(pool.activeFlights,1);assert.equal(pool.estimatedBytes,1024);
  finish();await flush();assert.deepEqual(sent,[1,2]);assert.deepEqual(published,[2]);
  assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);transport.reset();
});

test('a chart sharing retired period extras immediately reads its current cells without an error or retry timer',async()=>{
  const pool=new HistoryPool(),sent:{generation:number;body:PeriodRequest;signal:AbortSignal}[]=[],timers:number[]=[];
  let generation=1;
  const intent=():PeriodIntent=>({board:'b',generation,revision:generation,request:{version:1,selection:{mode:'live',periodMs:86_400_000},evaluatedAt:NOW,sessions:{}}});
  const transport=new PeriodTransport(pool,intent,()=>{},async(_board,body,signal)=>{sent.push({generation,body,signal});return new Promise(()=>{});});
  const reader=new HistoryStore({now:()=>NOW,preparations:null,read:(_board,cell,from,to,signal)=>transport.read('quota',{cell:String(cell),from:String(from),to:String(to)},signal).then(reply=>expandHistory(reply)),
    setTimeout:(_run,ms)=>{timers.push(ms);return {};},clearTimeout:()=>{},dropTimeRange:()=>{}},pool.budget,'quota',pool);
  reader.open('b');reader.hello('run');reader.snapshot(['s'],['s w']);await flush();
  assert.equal(sent.length,1);assert.ok(sent[0].body.quota);assert.ok(sent[0].body.sessions);
  generation=2;transport.change();await flush();
  assert.equal(sent[0].signal.aborted,true);assert.ok(sent.some(a=>a.generation===2&&a.body.quota));
  assert.equal(reader.get().error,undefined);assert.deepEqual(timers,[]);
  reader.close();transport.reset();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);
});

/** Exercise the real reader factory, including its retry callback, with an isolated pool. */
function readerFor(period:Coordinator,pool:HistoryPool,scope:'quota'|'budget',family:'budget'|'funds'='budget') {
  const source=readFileSync(new URL('../lib/history.ts',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function reader('),source.indexOf('export const quotaHistory'));
  const context={reader:null as unknown as (scope:'quota'|'budget',family:'budget'|'funds')=>HistoryStore,HistoryStore,boardPeriod:period,retention,historyPool:pool,STORED_BYTES:15*1024*1024,hubNow:()=>NOW,pan:{get:()=>null},expandHistory,setTimeout,clearTimeout};
  runInNewContext(ts.transpileModule(code+'\nglobalThis.reader=reader;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return context.reader(scope,family);
}

test('chart retry repeats only the failed exact family through the actual HistoryStore wiring',async()=>{
  const h=harness(['quota-history','budget-history']);h.fail.add('quota');h.fail.add('budget');h.period.activate(true);await flush();
  assert.equal(h.period.projectionState({range:'1h'},'budget').error,'history_failed');
  const work=h.period.get().value;h.attempts.length=0;h.fail.delete('budget');
  const reader=readerFor(h.period,h.pool,'budget');reader.retry();await flush();
  assert.equal(h.attempts.length,1);assert.deepEqual(scopes(h.attempts[0].body),['budget']);
  assert.notEqual(h.attempts[0].body.budget?.evidence,'skip');assert.equal(h.attempts[0].body.sessions,undefined);
  assert.equal(h.period.projectionState({range:'1h'},'budget').error,undefined);assert.equal(h.period.projectionState({range:'1h'},'budget').ready,true);
  assert.equal(h.period.projectionState({range:'1h'},'quota').error,'history_failed');assert.equal(h.period.get().value,work);
  h.period.activate(false);reader.close();
});

test('the subscription funds reader retries its own exact evidence and leaves wallet errors independent',async()=>{
  const h=harness(['budget-history',SUBSCRIPTION_FUNDS]);h.fail.add('budget');h.fail.add('funds');h.period.activate(true);await flush();
  h.attempts.length=0;h.fail.delete('funds');const reader=readerFor(h.period,h.pool,'budget','funds');reader.retry();await flush();
  assert.equal(h.attempts.length,1);assert.deepEqual(scopes(h.attempts[0].body),['funds']);
  assert.equal(h.period.projectionState({range:'1h'},'funds').ready,true);assert.equal(h.period.projectionState({range:'1h'},'budget').error,'history_failed');
  h.period.activate(false);reader.close();
});

test('session retry publishes its loading state and keeps completed chart evidence',async()=>{
  const h=harness();h.failWork(true);h.period.activate(true);await flush();h.attempts.length=0;
  assert.equal(h.period.get().error,'unavailable');h.failWork(false);
  h.period.retry();assert.equal(h.period.get().loading,true);assert.equal(h.period.get().error,null);await flush();
  assert.equal(h.attempts.length,1);assert.deepEqual(scopes(h.attempts[0].body),[]);assert.ok(h.attempts[0].body.sessions);
  assert.equal(h.period.get().loading,false);assert.equal(h.period.get().error,null);h.period.activate(false);
});

test('card retry restores only failed values, and a failed value target cannot enter the complete cache',async()=>{
  const h=harness(),fixed={from:1_000_000,to:2_000_000};h.select(fixed);h.failValues(true);h.period.activate(true);await flush();
  assert.equal(h.period.getValue('A').error,'unavailable');
  h.failValues(false);h.select({from:2_000_000,to:3_000_000});await flush();h.attempts.length=0;
  h.failValues(true);h.select(fixed);await flush();assert.equal(h.attempts.length,1,'a failed target must not restore as complete');
  h.attempts.length=0;h.failValues(false);h.period.retry();assert.equal(h.period.getValue('A').loading,true);assert.equal(h.period.getValue('A').error,null);await flush();
  assert.equal(h.attempts.length,1);assert.deepEqual(scopes(h.attempts[0].body),[]);assert.equal(h.attempts[0].body.sessions,undefined);assert.deepEqual([...h.attempts[0].body.values!],['A','B']);
  assert.equal(h.period.getValue('A').loading,false);assert.equal(h.period.getValue('A').error,null);h.period.activate(false);
});
