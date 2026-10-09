import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodAccounting} from '../lib/periodAccounting.js';
import {retainSamplesPrepared,sampleBytes,mergeTapePrepared} from '../../server/domain/periodTape.js';
import {drain} from '../lib/prepare.js';
import {PeriodIndex} from '../lib/periodIndex.js';
import {PeriodTransport,type PeriodIntent} from '../lib/periodTransport.js';
import {HistoryPool} from '../lib/historyPool.js';
import {packWorkPrepared,mergeWorkPrepared,packWork,type WorkTrace} from '../../server/domain/periodWork.js';
import {PeriodActivity} from '../lib/periodActivity.js';
import type {PeriodReply,PeriodRequest} from '../../server/domain/periodRead.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {evaluatedRange,periodKey} from '../../server/domain/period.js';
import {fixedTape,fixedWork} from '../../server/periodFixed.js';

const ref=(id:string)=>({ref:id,source:'s',device:{id:'d',name:'Laptop'},origin:'terminal' as const,project:id,folder:null,startedAt:0});
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('returning from settings resumes the actual period coordinator after preferences changed while hidden',()=>{
  let reads=0;
  const board={id:'board',lineup:[],view:{hidden:[]}},state={board};
  const context={exports:{} as {BoardPeriod:new()=>{activate(active:boolean):void;changed():void}},
    hubNow:()=>5_000_000,historyPool:{register:()=>{}},clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},
    PeriodTransport:class{change(){reads++;}reset(){}},fetchPeriod:()=>{},page:{get:()=>state},preparations:()=>null,
    evaluatedRange,periodKey,empty:()=>({value:null,basis:null,loading:false,error:null}),
    timeRange:()=>({from:1_400_000,to:5_000_000}),prefs:()=>({range:'1h'}),periodOf:()=>({ms:3_600_000}),
    PERIOD_SCOPES:['quota','budget','funds'],widgetVisible:()=>true,AGENTS:'agents',ACTIVITY:'activity',noSessions:[],noValue:{},
  };
  const source=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('class BoardPeriod'),source.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod');
  runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const period=new context.exports.BoardPeriod();period.changed();assert.equal(reads,0,'compact and other shells start without period work');
  period.activate(true);assert.equal(reads,1);
  period.activate(false);period.changed();assert.equal(reads,1,'hidden preferences cannot create work');
  period.activate(true);assert.equal(reads,2,'a fresh visible intent must be scheduled on return');
});

test('a complete temporal index distinguishes equal totals, changes ranking and expires without another read',()=>{
  const trace:WorkTrace={anchor:0,knownFrom:0,refs:[ref('a'),ref('b')],spans:[[0,0,10],[0,20,30],[1,0,5],[1,15,30]]};
  const index=new PeriodIndex(trace);
  assert.deepEqual(index.advance({from:0,to:30},30).rows.map(r=>r.workedMs),[20,20]);
  assert.deepEqual(index.advance({from:6,to:36},36).rows.map(r=>r.workedMs),[14,15]);
  assert.equal(index.advance({from:30,to:60},60).rows.length,0);
  assert.equal(index.changesAt(60,30),null);
  const large:WorkTrace={anchor:0,knownFrom:0,refs:Array.from({length:51},(_,i)=>ref(String(i))),spans:Array.from({length:51},(_,i)=>[i,i===50?20:0,i===50?29:10])};
  const roster=new PeriodIndex(large);
  assert.equal(roster.advance({from:0,to:30},30).rows.length,51);
  assert.deepEqual(roster.advance({from:10,to:40},40).rows.map(r=>r.ref),['50']);
  const fixed=new PeriodIndex(trace),range={from:0,to:30};
  assert.deepEqual(fixed.advance(range,30).rows,fixed.advance(range,10_000).rows);
});

test('one collection combines all three history sections and the roster, including their shared budget',async()=>{
  const pool=new HistoryPool(),sent:PeriodRequest[]=[];
  const intent:PeriodIntent={board:'b',generation:1,revision:1,request:{version:1,selection:{mode:'live',periodMs:3_600_000},evaluatedAt:5_000_000,sessions:{}}};
  const basis={run:'r',revision:'1',evaluatedAt:5_000_000,evidenceCut:5_000_000,range:{from:1_400_000,to:5_000_000}};
  const history={run:'r',now:5_000_000,historyStart:0,known:{work:0,sources:{}},chunks:[]};
  let applied=0;
  const transport=new PeriodTransport(pool,()=>intent,()=>{applied++;},async(_board,body,_signal,reserve)=>{sent.push(body);assert.equal(reserve(1024),true);return {basis,quota:{state:'complete',basis,value:history},budget:{state:'complete',basis,value:history},funds:{state:'complete',basis,value:history},sessions:{state:'complete',basis,value:{anchor:0,knownFrom:0,refs:[],spans:[],cursor:'one'}}};});
  transport.change();
  const quota=transport.read('quota',{cell:'1',from:'0',to:'60'}),budget=transport.read('budget',{cell:'1',from:'0',to:'60'}),funds=transport.read('funds',{cell:'1',from:'0',to:'60'});
  await Promise.all([quota,budget,funds]);await settle();
  assert.equal(sent.length,1);assert.ok(sent[0].quota);assert.ok(sent[0].budget);assert.ok(sent[0].funds);assert.ok(sent[0].sessions);assert.equal(applied,1);assert.equal(pool.estimatedBytes,0);
  transport.change();await settle();assert.equal(sent.length,1,'clock-like reevaluation alone creates no read');
});

test('a stale A response cannot publish after A to B to A or after new evidence during its flight',async()=>{
  const pool=new HistoryPool(),pending:((reply:PeriodReply)=>void)[]=[],applied:number[]=[];
  let generation=1,revision=1;
  const intent=():PeriodIntent=>({board:'b',generation,revision,request:{version:1,selection:{mode:'live',periodMs:3_600_000},evaluatedAt:5_000_000,sessions:{}}});
  const basis={run:'r',revision:'1',evaluatedAt:5_000_000,evidenceCut:5_000_000,range:{from:1_400_000,to:5_000_000}};
  const answer:PeriodReply={basis,sessions:{state:'complete',basis,value:{anchor:0,knownFrom:0,refs:[],spans:[],cursor:'one'}}};
  const transport=new PeriodTransport(pool,intent,(_reply,intent)=>{applied.push(intent.generation);},()=>new Promise(resolve=>pending.push(resolve)));
  transport.change();await settle();generation=3;transport.change();await settle();
  pending[0](answer);await settle();assert.deepEqual(applied,[]);
  revision++;pending[1](answer);await settle();assert.deepEqual(applied,[]);
  transport.change();await settle();pending[2](answer);await settle();assert.deepEqual(applied,[3]);
});

test('a cold drawing releases its decoded response before the exact baseline starts',async()=>{
  const pool=new HistoryPool(),sent:PeriodRequest[]=[],basis={run:'r',revision:'1',evaluatedAt:5_000_000,evidenceCut:5_000_000,range:{from:1_400_000,to:5_000_000}};
  const query={cell:'1',from:'0',to:'60',cells:'skip' as const};
  const intent:PeriodIntent={board:'b',generation:1,revision:1,request:{version:1,selection:{mode:'live',periodMs:3_600_000},evaluatedAt:5_000_000,quota:query,sessions:{}}};
  const transport=new PeriodTransport(pool,()=>intent,()=>{},async(_board,body,_signal,reserve)=>{
    assert.equal(pool.estimatedBytes,0,'a prior decoded body cannot overlap the baseline');assert.equal(reserve(1024),true);sent.push(body);
    return {basis,quota:{state:'complete',basis,value:{run:'r',now:5_000_000,historyStart:0,known:{work:0,sources:{}},chunks:[]}}};
  });
  transport.change();await transport.read('quota',{cell:'1',from:'0',to:'60'});await settle();
  assert.equal(sent.length,2);assert.equal(sent[0].quota?.evidence,'skip');assert.equal(sent[0].sessions,undefined);
  assert.equal(sent[1].quota?.cells,'skip');assert.ok(sent[1].sessions);assert.equal(pool.estimatedBytes,0);
});

test('a failed cold family reports its error while the other baselines still complete',async()=>{
  const pool=new HistoryPool(),sent:string[]=[],received:PeriodReply[]=[];
  const query={cell:'1',from:'0',to:'60',cells:'skip' as const};
  const intent:PeriodIntent={board:'b',generation:1,revision:1,request:{version:1,selection:{mode:'live',periodMs:3_600_000},evaluatedAt:5_000_000,quota:query,budget:query,funds:query}};
  const basis={run:'r',revision:'1',evaluatedAt:5_000_000,evidenceCut:5_000_000,range:{from:1_400_000,to:5_000_000}};
  const transport=new PeriodTransport(pool,()=>intent,reply=>{received.push(reply);},async(_board,body)=>{
    const scope=body.quota?'quota':body.funds?'funds':'budget';sent.push(scope);if(scope==='funds')throw new Error('network failed');
    return {basis,[scope]:{state:'complete',basis,value:{run:'r',now:5_000_000,historyStart:0,known:{work:0,sources:{}},chunks:[]}}};
  });
  transport.change();for(let i=0;i<4;i++)await settle();
  assert.deepEqual(sent,['quota','funds','budget']);assert.equal(received[1].funds?.state,'error');assert.equal(received[2].budget?.state,'complete');
});


test('presence expires at the confirmation deadline even when neither accounting boundary crosses work',()=>{
  const trace:WorkTrace={anchor:0,knownFrom:0,refs:[{...ref('a'),currentPresence:{working:true,through:100,workingThrough:50,startedAt:0}}],spans:[[0,0,10]]};
  const index=new PeriodIndex(trace),range={from:0,to:30};
  assert.equal(index.advance(range,30).rows[0].working,true);assert.equal(index.changesAt(30,100),50);
  const expired=index.advance(range,50);assert.equal(expired.changed,true);assert.equal(expired.rows[0].working,false);assert.equal(expired.rows[0].workedMs,10);
  assert.equal(index.presenceChangesAt(),100);assert.equal(index.advance(range,100).rows[0].currentPresence,undefined);
});


test('a sibling chart reply cannot cancel the coordinator preparation of historical card values',async()=>{
  const pending:(()=>void)[]=[],value={id:'s',provider:'codex',windows:[],meters:[],keys:[]};
  const context={exports:{} as {BoardPeriod:new()=>{receive(reply:PeriodReply,intent:PeriodIntent):Promise<void>;getValue(id:string):{value:unknown}}},
    hubNow:()=>5_000_000,historyPool:{register:()=>{},reserve:()=>true,release:()=>{}},clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},
    PeriodTransport:class{},fetchPeriod:()=>{},page:{get:()=>({})},preparations:()=>null,
    prepareAsync:(_owner:unknown,work:Parameters<typeof drain>[0])=>new Promise(resolve=>pending.push(()=>resolve(drain(work)))),
    evaluatedRange,periodKey,PeriodAccounting,PeriodIndex,PeriodActivity,packWorkPrepared,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,empty:()=>({value:null,basis:null,loading:false,error:null}),
    prefs:()=>({range:'1h'}),PERIOD_SCOPES:['quota','budget','funds'],noSessions:[],noValue:{},
  };
  const source=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('class BoardPeriod'),source.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod');
  runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const period=new context.exports.BoardPeriod(),selection={mode:'range' as const,from:1_400_000,to:5_000_000};
  const basis={run:'r',revision:'1',evaluatedAt:5_000_000,evidenceCut:5_000_000,range:selection};
  const intent:PeriodIntent={board:'b',generation:0,revision:0,request:{version:1,selection,evaluatedAt:5_000_000}};
  const first=period.receive({basis,values:{state:'complete',basis,value:[value]}},intent);await settle();
  const second=period.receive({basis,funds:{state:'complete',basis,value:{run:'r',now:5_000_000,historyStart:0,known:{work:0,sources:{}},chunks:[],tape:{from:1_400_000,cut:5_000_000,replaceFrom:1_400_000,cursor:'c',quota:[],money:[]}}}},intent);await settle();
  assert.equal(pending.length,1,'only the first reply owns the preparation slot');
  pending.shift()!();await first;await settle();assert.equal(period.getValue('s').value,value);
  assert.equal(pending.length,1);pending.shift()!();await second;
  assert.equal(period.getValue('s').value,value,'the sibling starts from the committed values');
});


test('a dense retained month adopts its decoded reservation within the shared memory budget',async()=>{
  const pool=new HistoryPool(),flight={role:'visible' as const};
  pool.register({estimatedBytes:6*1024*1024,evictionCandidates:()=>[]});
  const context={exports:{} as {BoardPeriod:new()=>{receive(reply:PeriodReply,intent:PeriodIntent,reserve:(bytes:number)=>boolean):Promise<void>;estimatedBytes:number}},
    hubNow:()=>2_700_000_000,historyPool:pool,clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},
    PeriodTransport:class{},fetchPeriod:()=>{},page:{get:()=>({})},preparations:()=>null,
    prepareAsync:async(_owner:unknown,work:Parameters<typeof drain>[0])=>drain(work),
    evaluatedRange,periodKey,PeriodAccounting,PeriodIndex,PeriodActivity,packWorkPrepared,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,empty:()=>({value:null,basis:null,loading:false,error:null}),
    prefs:()=>({range:'30d'}),PERIOD_SCOPES:['quota','budget','funds'],noSessions:[],noValue:{},
  };
  const source=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('class BoardPeriod'),source.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod');
  runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const period=new context.exports.BoardPeriod(),selection={mode:'range' as const,from:0,to:2_700_000_000};
  const basis={run:'r',revision:'1',evaluatedAt:selection.to,evidenceCut:selection.to,range:selection};
  const samples=Array.from({length:9000},(_,i)=>[i?300000:0,(i%100)+.125,0,i?0:600000,0]).flat();
  const reply:PeriodReply={basis,quota:{state:'complete',basis,value:{run:'r',now:selection.to,historyStart:0,known:{work:0,sources:{}},chunks:[],tape:{from:0,cut:selection.to,replaceFrom:0,cursor:'a',money:[],quota:Array.from({length:12},(_,i)=>({source:String(i),window:'w',samplesEncoding:'delta',samples:[...samples]}))}}}};
  const trace:WorkTrace={anchor:0,cut:selection.to,knownFrom:0,refs:Array.from({length:20},(_,i)=>({...ref(String(i)),source:String(i%12)})),spans:[]};
  for(let id=0;id<trace.refs.length;id++)for(let at=0;at<selection.to;at+=1_200_000)trace.spans.push([id,at+id*1000,at+id*1000+600_000]);
  reply.sessions={state:'complete',basis,value:{...packWork(trace),cursor:'work'}};
  assert.equal(pool.reserve(flight,JSON.stringify(reply).length*3),true);
  await period.receive(reply,{board:'b',generation:0,revision:0,request:{version:1,selection,evaluatedAt:selection.to}},bytes=>pool.reserve(flight,bytes));
  assert.equal(reply.quota!.state,'complete','lossless evidence must fit without dropping the period');
  assert.equal(reply.quota!.state==='complete'&&reply.quota!.value.tape!.quota.reduce((n,s)=>n+s.samples.length/5,0),108000);assert.ok(pool.estimatedBytes<=15*1024*1024);
  pool.release(flight);
  const delta:PeriodReply={basis,quota:{state:'complete',basis,value:{run:'r',now:selection.to,historyStart:0,known:{work:0,sources:{}},chunks:[],tape:{from:0,cut:selection.to,replaceFrom:2_699_000_000,cursor:'b',money:[],quota:[{source:'0',window:'w',samples:[2_699_400_000,12.5,-1,600000,-1]}]}}}};
  assert.equal(pool.reserve(flight,JSON.stringify(delta).length*3),true);
  await period.receive(delta,{board:'b',generation:0,revision:0,request:{version:1,selection,evaluatedAt:selection.to}},bytes=>pool.reserve(flight,bytes));
  assert.equal(delta.quota!.state,'complete','the next observation must rebuild exact prefixes while the old presentation stays available');
  assert.equal(reply.sessions!.state,'complete','the complete month of credited intervals shares the same ceiling');
  assert.ok(pool.estimatedBytes<=15*1024*1024);pool.release(flight);
});

test('an empty replacement period clears the previous roster and card disclosures',async()=>{
  const context={exports:{} as {BoardPeriod:new()=>{active:boolean;receive(reply:PeriodReply,intent:PeriodIntent):Promise<void>;get():{rows:unknown[]};getSource(id:string):unknown[]}},
    hubNow:()=>5_000_000,historyPool:{register:()=>{},reserve:()=>true,release:()=>{}},clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},
    PeriodTransport:class{},fetchPeriod:()=>{},page:{get:()=>({})},preparations:()=>null,
    prepareAsync:async(_owner:unknown,work:Parameters<typeof drain>[0])=>drain(work),
    evaluatedRange,periodKey,PeriodAccounting,PeriodIndex,PeriodActivity,packWorkPrepared,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,empty:()=>({value:null,basis:null,loading:false,error:null}),
    sameJson:(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),prefs:()=>({range:'1h'}),PERIOD_SCOPES:['quota','budget','funds'],noSessions:[],noValue:{},
  };
  const source=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('class BoardPeriod'),source.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod');
  runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const period=new context.exports.BoardPeriod();period.active=true;
  for(const populated of [true,false,true]){
    const selection={mode:'range' as const,from:populated?1_400_000:0,to:populated?5_000_000:1_400_000};
    const basis={run:'r',revision:'1',evaluatedAt:5_000_000,evidenceCut:5_000_000,range:selection};
    const value={anchor:selection.from,cut:selection.to,knownFrom:selection.from,refs:populated?[ref('a')]:[],spans:populated?[[0,0,60_000] as [number,number,number]]:[],cursor:'work'};
    await period.receive({basis,sessions:{state:'complete',basis,value}},{board:'b',generation:0,revision:0,request:{version:1,selection,evaluatedAt:5_000_000}});
    assert.equal(period.get().rows.length,Number(populated));assert.equal(period.getSource(ref('a').source).length,Number(populated));
  }
});

test('complete live and fixed targets share the LRU and cached return performs no read',async()=>{
  let selected:{from:number;to:number}|null=null,reads=0;
  const board={id:'b',lineup:['s'],view:{hidden:[]},cards:{s:{budget:false}}},state={board};
  const pool=new HistoryPool();
  const send=async(_board:string,body:PeriodRequest):Promise<PeriodReply>=>{
    reads++;const range=evaluatedRange(body.selection,5_000_000),basis={run:'r',revision:'1',evaluatedAt:5_000_000,evidenceCut:range.to,range};
    const work:WorkTrace={anchor:range.from,cut:range.to,knownFrom:0,refs:[ref('a')],spans:[[0,0,60_000]]};
    const tape={from:range.from,cut:range.to,replaceFrom:range.from,cursor:'q',money:[],quota:[{source:'s',window:'w',samples:[range.from,10,-1,3_600_000,-1]}]};
    return {basis,...(body.quota?{quota:{state:'complete',basis,value:{run:'r',now:5_000_000,historyStart:0,known:{work:0,sources:{}},chunks:[],tape:body.selection.mode==='live'?tape:fixedTape(tape,work,range,60_000,()=>{})}}}:{}),
      ...(body.sessions?{sessions:{state:'complete',basis,value:{...(body.selection.mode==='live'?work:fixedWork(work,range,60_000,5_000_000,()=>{})),cursor:'w'}}}:{}),
      ...(body.values?{values:{state:'complete',basis,value:[{id:'s',provider:'codex',windows:[],meters:[],keys:[]}]}}:{})};
  };
  const context={exports:{} as {BoardPeriod:new()=>{activate(active:boolean):void;changed(event?:unknown):void;get():{rows:{workedMs:number}[]};estimatedBytes:number}},
    hubNow:()=>5_000_000,historyPool:pool,clock:{watch:()=>({}),subscribe:()=>{},due:()=>{}},PeriodTransport,fetchPeriod:send,page:{get:()=>state},pan:{get:()=>null},preparations:()=>null,
    prepareAsync:async(_owner:unknown,work:Parameters<typeof drain>[0])=>drain(work),evaluatedRange,periodKey,PeriodAccounting,PeriodIndex,PeriodActivity,packWorkPrepared,mergeWorkPrepared,retainSamplesPrepared,sampleBytes,mergeTapePrepared,
    empty:()=>({value:null,basis:null,loading:false,error:null}),sameJson:(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),timeRange:()=>selected,prefs:()=>({range:'1h'}),periodOf:()=>({ms:3_600_000}),cellOf:()=>60_000,
    widgetVisible:(_view:unknown,id:string)=>id==='history',subscriptionSelection:()=>null,PERIOD_SCOPES:['quota','budget','funds'],QUOTA_WIDGETS:['history'],BUDGET_WIDGETS:['budget'],SUBSCRIPTION_FUNDS:'funds',ACTIVITY:'activity',AGENTS:'agents',noSessions:[],noValue:{},
  };
  const source=readFileSync(new URL('../lib/period.ts',import.meta.url),'utf8'),body=source.slice(source.indexOf('class BoardPeriod'),source.indexOf('export const boardPeriod')).replace('class BoardPeriod','export class BoardPeriod');
  runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  const period=new context.exports.BoardPeriod(),flush=async()=>{for(let i=0;i<8;i++)await settle();};period.activate(true);await flush();
  assert.equal(reads,1);assert.equal(period.get().rows[0].workedMs,60_000);
  selected={from:0,to:1_400_000};period.changed();await flush();assert.equal(reads,2);assert.equal(period.get().rows[0].workedMs,60_000);
  selected=null;period.changed();await flush();assert.equal(reads,2,'the live ledger is retained in the shared budget');
  selected={from:0,to:1_400_000};period.changed();await flush();assert.equal(reads,2,'fixed summaries and exact edges are reusable');assert.ok(period.estimatedBytes>0);assert.ok(pool.estimatedBytes<15*1024*1024);
  period.changed({type:'hub',event:{type:'history',data:{sources:['s'],since:4_000_000}}});await flush();assert.equal(reads,2,'later live work cannot rewrite this past target');
  selected=null;period.changed();await flush();assert.equal(reads,3,'live evidence invalidated while hidden is refreshed on return');
});
