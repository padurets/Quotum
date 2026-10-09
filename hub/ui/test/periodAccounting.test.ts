import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodAccounting} from '../lib/periodAccounting.js';
import {PeriodActivity} from '../lib/periodActivity.js';
import {PeriodIndex} from '../lib/periodIndex.js';
import {packSamples,type PeriodTape} from '../../server/domain/periodTape.js';
import type {History} from '../lib/types.js';
import type {Reading} from '../../server/domain/meters.js';
import {packWork,workedSessions,type WorkTrace} from '../../server/domain/periodWork.js';
import {union} from '../../server/domain/work.js';
import {fixedTape,fixedWork} from '../../server/periodFixed.js';
import {shifted} from '../../server/domain/periodShift.js';

test('shared work curves match exact session sums and concurrent unions across hour boundaries',()=>{
  const refs=Array.from({length:5},(_,i)=>({ref:String(i),source:String(i%2),device:{id:String(i%3),name:'Laptop'},origin:'terminal' as const,project:i%2?'P':null,folder:null,startedAt:0}));
  const trace:WorkTrace={anchor:0,cut:3*3_600_000,knownFrom:0,refs,spans:[]};
  for(let id=0;id<refs.length;id++)for(let n=0;n<43;n++){const from=n*237_117+id*913;trace.spans.push([id,from,from+111_023+id*7]);}
  const packed=packWork(trace),index=new PeriodIndex(packed),activity=new PeriodActivity(packed,index.curves);
  for(let from=0;from<9_000_000;from+=173_113){const range={from,to:from+899_997},expected=workedSessions(trace,range,range.to),rows=index.advance(range,range.to).rows;activity.update(rows);const shown=activity.project(blank.activity,range);assert.deepEqual(rows,expected);assert.equal(shown.agentMs,expected.reduce((n,r)=>n+r.workedMs,0));const active=union(trace.spans.map(([,a,b])=>({from:Math.max(a,from),to:Math.min(b,range.to)})).filter(s=>s.to>s.from)).reduce((n,[a,b])=>n+b-a,0);assert.equal(shown.activeMs,active);}
  const atStart=index.advance({from:0,to:237_117},237_117).rows.find(r=>r.ref==='0')!;
  assert.equal(atStart.lastWorkedAt,111_023,'an interval starting at the exclusive end contributes no last-work evidence');
});

const blank:History={range:'1h',live:true,since:0,to:60_000,cellMs:60_000,historyStart:0,events:[],series:[],activity:{since:0,known:{from:0,to:60_000},barMs:60_000,activeMs:0,agentMs:0,agents:0,cells:[],by:{source:[],project:[],device:[]}}};
const tape=():PeriodTape=>({from:0,cut:60_000,replaceFrom:0,cursor:'cursor',quota:[],money:[]});
test('exact endpoints exclude later samples of the same cell and stop validity at reset',()=>{
  const evidence=tape();evidence.quota=[{source:'s',window:'w',samples:packSamples([{at:0,used:10,resetAt:50_000,staleAfterMs:60_000},{at:20_000,used:25,resetAt:50_000,staleAfterMs:60_000},{at:40_000,used:90,resetAt:50_000,staleAfterMs:60_000}])}];
  const frame={...blank,series:[{sourceId:'s',windowId:'w',consumed:80,coveredMs:40_000,remainingAtStart:90,remainingAtEnd:10,staleAfterMs:60_000,points:[[0,10,1] as [number,number,number]],work:null}]};
  const accounting=new PeriodAccounting(evidence,null);
  const selected=accounting.project(frame,{from:0,to:30_000}).series[0];
  assert.equal(selected.consumed,15);assert.equal(selected.remainingAtEnd,75);assert.equal(selected.coveredMs,20_000);
  assert.equal(accounting.project(frame,{from:0,to:20_000}).series[0].remainingAtEnd,90,'a sample exactly at to is excluded');
  assert.equal(accounting.project(frame,{from:10_000,to:30_000}).series[0].consumed,0,'an uncertain boundary movement is not divided proportionally');
  assert.equal(accounting.project(frame,{from:10_000,to:50_000}).series[0].remainingAtEnd,null,'exclusive reset expires availability');
});

test('money uses exact native steps and historical allowance, including an inside-cell end',()=>{
  const value=(at:number,amount:string,limit:string|null=null):Reading=>({id:'cap',kind:limit===null?'counter':'cap',unit:'credits:zai',amount,limit,at,previousAt:at?0:null,staleAfterMs:60_000,resetAt:null,minutes:300,scope:null,label:null});
  const evidence=tape();evidence.money=[{source:'s',meter:'cap',accounting:{spending:'unavailable',topups:'unavailable'},readings:[value(0,'9007199254740993','18014398509481986'),value(40_000,'9007199254740993','36028797018963972')],spans:[{from:0,to:40_000,staleAfterMs:60_000}]}];
  const frame:History={...blank,meterSeries:[{sourceId:'s',meterId:'cap',unit:'credits:zai',kind:'cap',start:null,end:null,spent:null,topup:null,coveredMs:0,unlocated:[],topupUnlocated:[],semantics:null,points:[]}]};
  const accounting=new PeriodAccounting(evidence,null),old=accounting.project(frame,{from:0,to:30_000}).meterSeries![0];
  assert.equal(old.end,'9007199254740993');assert.equal(old.semantics?.limit,'18014398509481986');
  assert.equal(accounting.project(frame,{from:0,to:50_000}).meterSeries![0].end,'27021597764222979');
  evidence.money=[{source:'s',meter:'cap',accounting:{spending:'counter',topups:'unavailable'},readings:[value(0,'0'),value(20_000,'9007199254740993'),value(40_000,'9007199254741093')],spans:[{from:0,to:40_000,staleAfterMs:60_000}]}];
  const counter=new PeriodAccounting(evidence,null),cut=counter.project(frame,{from:10_000,to:30_000}).meterSeries![0];
  assert.equal(cut.spent,'0');assert.deepEqual(cut.unlocated.map(s=>s.amount),['9007199254740993']);
  assert.equal(counter.project(frame,{from:0,to:40_000}).meterSeries![0].spent,'9007199254740993');
});

test('the roster and activity share exact rolling duration, union, counts and bounded edge bars',()=>{
  const refs=['a','b'].map(ref=>({ref,source:'s',device:{id:'d',name:'Laptop'},origin:'terminal' as const,project:'P',folder:null,startedAt:0}));
  const trace={anchor:0,cut:30,knownFrom:0,refs,spans:[[0,0,10],[0,20,30],[1,0,5],[1,15,30]] as [number,number,number][]};
  const index=new PeriodIndex(trace),activity=new PeriodActivity(trace);
  const base={...blank.activity,barMs:30,cells:[[0,25,40,2] as [number,number,number,number]],by:{source:[{key:'s',name:null,agentMs:40,activeMs:25,agents:2,cells:[[0,40] as [number,number]]}],project:[],device:[]}};
  for(const [from,total,active] of [[0,40,25],[6,29,19],[30,0,0]]) {
    const range={from,to:from+30},rows=index.advance(range,range.to).rows;activity.update(rows);const shown=activity.project(base,range);
    assert.equal(shown.agentMs,total);assert.equal(shown.activeMs,active);assert.equal(shown.agentMs,rows.reduce((sum,r)=>sum+r.workedMs,0));
    assert.equal(shown.by.source.reduce((sum,g)=>sum+g.agentMs,0),total);assert.equal(shown.cells.reduce((sum,c)=>sum+c[2],0),total);
  }
});


test('fixed boundary geometry keeps the old native window and cap allowance inside a coarse cell',()=>{
  const evidence=tape();
  evidence.quota=[{source:'s',window:'gone',member:true,windowValue:{id:'gone',kind:'weekly',label:'Retained',minutes:10080},samples:packSamples([{at:0,used:10,resetAt:null,staleAfterMs:60_000},{at:40_000,used:90,resetAt:null,staleAfterMs:60_000}])}];
  const accounting=new PeriodAccounting(evidence,null),shown=accounting.project({...blank,live:false},{from:10_000,to:30_000});
  assert.equal(shown.series[0].windowValue?.label,'Retained');assert.equal(shown.series[0].remainingAtEnd,90);
  assert.deepEqual(shown.series[0].points,[[10_000,90,1,30_000]]);
});

test('credit heartbeats keep exact coefficients and their own valuation without inventing spending',()=>{
  const evidence=tape(),rate=(to:string)=>[{id:to,base:'credits:codex',from:'1000000',to,source:'manual',date:0,fetchedAt:0}];
  evidence.money=[{source:'s',meter:'balance:credits',displayUnit:'USD',accounting:{spending:'unavailable',topups:'unavailable'},
    readings:[{id:'balance:credits',kind:'balance',unit:'credits:codex',amount:'2500000000001',scale:12,limit:null,at:0,previousAt:null,staleAfterMs:60000,resetAt:null,minutes:null,scope:null,label:null}],
    spans:[{from:0,to:40000,staleAfterMs:60000}],rates:{'credits:codex\n0':rate('40000'),'credits:codex\n40000':rate('30000')}}];
  const frame:History={...blank,live:false,meterSeries:[{sourceId:'s',meterId:'balance:credits',unit:'USD',kind:'balance',start:null,end:null,spent:null,topup:null,coveredMs:0,unlocated:[],topupUnlocated:[],semantics:null,points:[]}]};
  const accounting=new PeriodAccounting(evidence,null);
  const before=accounting.project(frame,{from:0,to:40000}).meterSeries![0];
  assert.equal(before.end,'100000');
  const after=accounting.project(frame,{from:0,to:50000}).meterSeries![0];
  assert.equal(after.end,'75000');assert.equal(after.spent,null);assert.equal(after.topup,null);
  assert.equal(after.points.find(p=>p.at===40000)?.value,'75000');
  const summary=fixedTape(evidence,null,{from:0,to:50000},frame.cellMs,()=>{}).fixed!.money[0];
  assert.equal(summary.end,'75000');assert.equal(summary.endScale,6);
  assert.deepEqual(summary.semantics?.conversion?.original,{meterId:'balance:credits',amount:'2500000000001',unit:'credits:codex',at:40000,scale:12,limit:null});
  assert.equal(summary.semantics?.conversion?.rate.to,'30000');
});


test('quota evidence can precede work without fabricating dates, and keeps the source sharing boundary',()=>{
  const evidence=tape();evidence.quota=[{source:'s',window:'w',workFrom:20000,samples:packSamples([{at:0,used:10,resetAt:null,staleAfterMs:60000},{at:30000,used:20,resetAt:null,staleAfterMs:60000}])}];
  const frame={...blank,live:false};
  const pending=new PeriodAccounting(evidence,null).project(frame,{from:0,to:40000});
  assert.equal(pending.series[0].remainingAtEnd,80);assert.equal(pending.series[0].work,null,'measurement-only replies cannot create a work date');
  const refs=[{ref:'one',source:'s',device:{id:'d',name:'D'},origin:'terminal' as const,project:null,folder:null,startedAt:0}];
  const accounting=new PeriodAccounting(evidence,{anchor:0,cut:60000,knownFrom:0,refs,spans:[[0,20000,30000]]});
  const before=accounting.project(frame,{from:0,to:15000}).series[0].work!;
  assert.equal(before.from,20000);assert.equal(before.ms,null,'work before sharing remains unknown');
  const after=accounting.project(frame,{from:0,to:40000}).series[0].work!;
  assert.equal(after.from,20000);assert.equal(after.ms,10000);
});

test('fixed summaries preserve exact totals, native credit precision and boundary geometry',()=>{
  const evidence=tape(),range={from:123,to:49_999};
  evidence.quota=[{source:'s',window:'w',samples:packSamples([{at:0,used:10.125,resetAt:null,staleAfterMs:60_000},{at:25_000,used:22.375,resetAt:null,staleAfterMs:60_000}])}];
  evidence.money=[{source:'s',meter:'balance:credits',accounting:{spending:'unavailable',topups:'unavailable'},readings:[{id:'balance:credits',kind:'balance',unit:'credits:codex',amount:'2500000000001',scale:12,limit:null,at:0,previousAt:null,staleAfterMs:60_000,resetAt:null,minutes:null,scope:null,label:null}],spans:[{from:0,to:40_000,staleAfterMs:60_000}]}];
  const trace:WorkTrace={anchor:0,cut:60_000,knownFrom:0,refs:[{ref:'r',source:'s',device:{id:'d',name:'D'},origin:'terminal',project:null,folder:null,startedAt:0}],spans:[[0,0,5000],[0,25_000,55_000]]};
  const frame:History={...blank,live:false,cellMs:15_000,meterSeries:[{sourceId:'s',meterId:'balance:credits',kind:'balance',unit:'credits:codex',start:null,end:null,semantics:null,spent:null,topup:null,coveredMs:0,unlocated:[],topupUnlocated:[],points:[]}]};
  frame.series=[{sourceId:'s',windowId:'w',consumed:0,coveredMs:0,remainingAtStart:null,remainingAtEnd:null,staleAfterMs:60000,work:null,points:[[15000,77.625,2,30000]]}];
  const full=new PeriodAccounting(evidence,trace),summary=fixedTape(evidence,trace,range,frame.cellMs,()=>{}),compact=new PeriodAccounting(summary,null).project(frame,range),expected=full.project(frame,range);
  assert.deepEqual(summary.fixed!.quota[0].points,[[123,89.875,1,15000],[45000,77.625,2,49999]],'only boundary geometry travels beside cached interior cells');
  assert.deepEqual(compact.series,expected.series);assert.equal(compact.meterSeries![0].end,'2500000000001');assert.equal(compact.meterSeries![0].endScale,12);assert.equal(compact.meterSeries![0].points[0].semantics!.scale,12);
  assert.deepEqual(compact.meterSeries![0].points,expected.meterSeries![0].points);assert.equal(compact.meterSeries![0].spent,null);assert.deepEqual(summary.quota,[]);assert.deepEqual(summary.money,[]);
  const work=fixedWork(trace,range,frame.cellMs,60_000,()=>{});assert.deepEqual(workedSessions(work,range,60_000),workedSessions(trace,range,60_000));
  const index=new PeriodIndex(work);assert.deepEqual(index.advance(range,60_000).rows,workedSessions(trace,range,60_000));assert.equal(index.advance({from:0,to:50_000},60_000).limited,true);
  const activity=new PeriodActivity(work).project({...blank.activity,barMs:frame.cellMs,cells:[[0,5000,5000,1],[15000,5000,5000,1],[30000,15000,15000,1],[45000,10000,10000,1]]},range);
  assert.equal(activity.agentMs,29_876);assert.equal(activity.activeMs,29_876);assert.equal(activity.agents,1);assert.equal(activity.cells.reduce((n,c)=>n+c[2],0),29876);
});

test('fixed reuse preserves exact totals across recorded evidence and cell boundaries',()=>{
  const evidence=tape(),range={from:123,to:49_123},cell=15_000;
  evidence.quota=[{source:'s',window:'w',samples:packSamples([{at:0,used:10.125,resetAt:55_000,staleAfterMs:60_000},{at:25_000,used:22.375,resetAt:55_000,staleAfterMs:60_000}])}];
  evidence.money=[{source:'s',meter:'credits',accounting:{spending:'counter',topups:'unavailable'},readings:[0,25_000,55_000].map((at,i)=>({id:'credits',kind:'counter' as const,unit:'credits:codex',amount:String(9007199254740993n+BigInt(i)),scale:12,limit:null,at,previousAt:i?at-25_000:null,staleAfterMs:60_000,resetAt:null,minutes:null,scope:null,label:null})),spans:[{from:0,to:60_000,staleAfterMs:60_000}]}];
  const trace:WorkTrace={anchor:0,cut:60_000,knownFrom:0,refs:[{ref:'r',source:'s',device:{id:'d',name:'D'},origin:'terminal',project:null,folder:null,startedAt:0}],spans:[[0,0,5000],[0,25_000,55_000]]};
  const compact=fixedTape(evidence,trace,range,cell,()=>{}).fixed!,work=fixedWork(trace,range,cell,60_000,()=>{}).fixed!;
  assert.ok(compact.shift);assert.ok(work.shift);
  const withoutProof=<T extends {shift?:unknown}>(value:T)=>{const {shift:_,...summary}=value;return summary;};
  for(const offset of [-123,-1,1,17,1023,5000,5877,5878,6000,10876,10877]){
    const next={from:range.from+offset,to:range.to+offset};
    assert.deepEqual(withoutProof(shifted(compact,next)!),withoutProof(fixedTape(evidence,trace,next,cell,()=>{}).fixed!));
    const moved=shifted(work,next)!;
    assert.deepEqual(withoutProof(moved),withoutProof(fixedWork(trace,next,cell,60_000,()=>{}).fixed!));
    assert.deepEqual(workedSessions({...trace,spans:[],fixed:moved},next,60_000),workedSessions(trace,next,60_000));
  }
  for(const fixed of [compact,work])for(const offset of [-124,10878])assert.equal(shifted(fixed,{from:range.from+offset,to:range.to+offset}),null);
});
