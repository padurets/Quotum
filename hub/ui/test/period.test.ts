import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodAccounting} from '../lib/periodAccounting.js';
import {mergeTapePrepared} from '../../server/domain/periodTape.js';
import {drain} from '../lib/prepare.js';
import {PeriodIndex} from '../lib/periodIndex.js';
import {PeriodTransport,type PeriodIntent} from '../lib/periodTransport.js';
import {HistoryPool} from '../lib/historyPool.js';
import type {WorkTrace} from '../../server/domain/periodWork.js';
import type {PeriodReply,PeriodRequest} from '../../server/domain/periodRead.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {evaluatedRange,periodKey} from '../../server/domain/period.js';

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
    evaluatedRange,periodKey,PeriodAccounting,mergeTapePrepared,empty:()=>({value:null,basis:null,loading:false,error:null}),
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
