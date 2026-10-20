import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ActivitySelection,type ActivityScope} from '../lib/activitySelection';
import {HistoryPool} from '../lib/historyPool';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import {periodKey} from '../../server/domain/period';
import {cellOf} from '../../server/domain/history';
import {expandPeriod} from '../../server/domain/periodWire';
import type {PeriodRequest} from '../../server/domain/periodRead';
import {fixture,flush,NOW,H,M} from './periodRuntimeFixture';
import {packWork,type WorkTrace} from '../../server/domain/periodWork';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};

for(const days of [1,30])test(`production fixed subset ${days}d replaces dirty cells with exact totals and keeps clean cells`,async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true,periodName:days===1?'24h':'30d'}),requests:PeriodRequest[]=[],pool=new HistoryPool();
  let gate:ReturnType<typeof deferred>|null=null,inFlight=0,peak=0;
  const reader=new ActivitySelection({pool,now:()=>NOW,read:()=>({trace:null,ready:false,error:null}),scheduler:()=>null,
    send:async(_board,body,_signal,reserve)=>{requests.push(body);peak=Math.max(peak,++inFlight);try{const wire=h.reader.read(h.board,h.alice.id,body);assert.ok(reserve(wire.length*3));const reply=expandPeriod(JSON.parse(wire)),waiting=gate;gate=null;await waiting?.promise;return reply;}finally{inFlight--;}}
  });
  const add=(project:string,from:number,to:number,id=project)=>{h.store.creditWork(h.device,from,to,[{source:h.source,client:'codex',origin:'terminal',project,folder:'',startedAt:NOW-days*24*H,identity:{kind:'stable',sessionId:id}}]);h.events.flush();};
  try{
    add('A',NOW-50*M,NOW-30*M);add('B',NOW-40*M,NOW-20*M);add('C',NOW-20*M,NOW-10*M);
    const selection={mode:'range' as const,from:NOW-days*24*H+123,to:NOW-123};
    const scope:ActivityScope={board:h.board,authority:'one',by:'project',muted:['"C"','"Work project"'],filters:workFilter(defaultFilters()),selection,rangeKey:periodKey(selection),barMs:cellOf(days*24*H)};
    reader.configure(scope);await flush();
    assert.equal(reader.get().error,null);assert.equal(requests.length,1);
    const value=reader.numbers(NOW)!;assert.deepEqual([value.agentMs,value.activeMs,value.agents],[40*M,30*M,2]);
    assert.equal(value.by.project.reduce((n,g)=>n+g.activeMs,0),40*M);
    assert.equal(requests[0].quota?.sources,'[]');assert.equal(requests[0].quota?.evidence,'skip');
    assert.deepEqual(Object.keys(requests[0]).sort(),['evaluatedAt','quota','selection','sessions','version','workFilter']);
    const tiles=(reader as unknown as {tiles:Map<number,unknown>}).tiles,first=[...tiles][0];
    add('A',NOW-12*M,NOW-7*M);reader.changed(NOW-12*M);await flush();
    assert.equal(requests.length,2);assert.equal(Number(requests[1].quota!.from),Math.floor((NOW-12*M)/cellOf(days*24*H))*cellOf(days*24*H));
    assert.deepEqual(requests[1].selection,selection,'narrow cell replacement retains the entire exact period');
    assert.equal((reader as unknown as {tiles:Map<number,unknown>}).tiles.get(first[0]),first[1],'a clean tile keeps its actual buffer');
    const fresh=reader.numbers(NOW)!;assert.deepEqual([fresh.agentMs,fresh.activeMs,fresh.agents],[45*M,35*M,2]);
    reader.changed(NOW+1);await flush();assert.equal(requests.length,2,'an event after the upper bound reads nothing');
    add('B',NOW-6*M,NOW-5*M);reader.changed(NOW-6*M);reader.changed(NOW-5*M);await flush();assert.equal(requests.length,3,'queued news coalesces');
    gate=deferred();const waiting=gate;reader.changed(NOW-10*M);await flush();assert.equal(requests.length,4);
    add('A',NOW-4*M,NOW-3*M);reader.changed(NOW-4*M);assert.equal(reader.numbers(NOW),null,'an older answer cannot label newer work');waiting.resolve();await flush();
    assert.equal(peak,1);assert.equal(requests.length,5);assert.deepEqual([reader.numbers(NOW)!.agentMs,reader.numbers(NOW)!.activeMs],[47*M,37*M]);
    reader.configure(null);await flush();assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);
  }finally{reader.reset();await flush();await h.close();}
});

test('live local projection consumes board intervals without reads and rejects obsolete generations',async()=>{
  const trace:WorkTrace=packWork({anchor:0,knownFrom:0,cut:100,refs:['A','B','C'].map((project,i)=>({ref:String(i),identityRef:i<2?'one':'two',source:null,project,device:{id:'d',name:'D'},origin:'terminal',folder:null,startedAt:0})),spans:[[0,0,30],[1,10,40],[2,20,60]]});
  const pool=new HistoryPool(),reader=new ActivitySelection({pool,now:()=>35,read:()=>({trace,ready:true,error:null}),scheduler:()=>null,send:async()=>{throw new Error('unexpected request');}});
  const scope:ActivityScope={board:'b',authority:'one',by:'project',muted:['"C"'],filters:workFilter(defaultFilters()),selection:{mode:'live',periodMs:30},rangeKey:'live',barMs:10};
  reader.configure(scope);await flush();assert.deepEqual([reader.numbers(35)!.agentMs,reader.numbers(35)!.activeMs,reader.numbers(35)!.agents],[50,30,1]);
  assert.deepEqual([reader.numbers(35,10)!.agentMs,reader.numbers(35,10)!.activeMs],[20,10]);
  reader.configure({...scope,muted:['"A"','"C"']});assert.equal(reader.numbers(35),null);await flush();assert.equal(reader.numbers(35)!.agentMs,25);
  reader.configure(scope);reader.configure(null);await flush();assert.equal(reader.numbers(35),null);assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);
});

test('a refused local preparation publishes an error and releases its reservation',async()=>{
  const trace:WorkTrace={anchor:0,knownFrom:0,cut:100,refs:[],spans:[]},pool=new HistoryPool(100);
  const reader=new ActivitySelection({pool,now:()=>50,read:()=>({trace,ready:true,error:null}),scheduler:()=>null,send:async()=>{throw new Error('unexpected request');}});
  reader.configure({board:'b',authority:'one',by:'source',muted:['unknown'],filters:workFilter(defaultFilters()),selection:{mode:'live',periodMs:50},rangeKey:'live',barMs:10});await flush();
  assert.equal(reader.get().error,'history_limit');assert.equal(reader.numbers(50),null);assert.equal(pool.estimatedBytes,0);assert.equal(pool.activeFlights,0);reader.reset();
});

test('a live work event waits for replacement board evidence and empty coverage has its own deadline',async()=>{
  let trace:WorkTrace={anchor:0,knownFrom:0,cut:100,refs:[],spans:[]};
  const pool=new HistoryPool(),reader=new ActivitySelection({pool,now:()=>100,read:()=>({trace,ready:true,error:null}),scheduler:()=>null,send:async()=>{throw new Error('unexpected request');}});
  const scope:ActivityScope={board:'b',authority:'one',by:'source',muted:['unknown'],filters:workFilter(defaultFilters()),selection:{mode:'live',periodMs:50},rangeKey:'live',barMs:10};
  try{
    reader.configure(scope);await flush();assert.ok(reader.numbers(100)?.known);
    assert.equal(reader.changesAt(100,at=>String(!!reader.numbers(at)?.known)),150);
    reader.changed(90);await flush();assert.equal(reader.numbers(100),null,'the event cannot publish the pre-event C intervals again');
    trace={...trace,cut:110};reader.refresh();await flush();assert.ok(reader.numbers(100)?.known);
    assert.equal(reader.changesAt(100,at=>String(!!reader.numbers(at)?.known)),160);
  }finally{reader.reset();await flush();assert.equal(pool.estimatedBytes,0);}
});
