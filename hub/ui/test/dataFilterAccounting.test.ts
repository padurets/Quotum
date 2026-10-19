import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodCurves,sourceWorkTape,sourceWorkCurves,mergeSourceWorkTape,sameSourceWork} from '../../server/domain/periodCurves';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {packSamples} from '../../server/domain/periodTape';
import {drain} from '../lib/prepare';
import type {WorkTrace} from '../../server/domain/periodWork';
import type {PeriodTape} from '../../server/domain/periodTape';
import {moneyWorkValues} from '../lib/moneyTable';
import type {MeterHistory} from '../lib/moneyView';
import {lineWork} from '../lib/work';
const M=60_000,H=60*M;
const trace=(spans:WorkTrace['spans']):WorkTrace=>({anchor:0,knownFrom:0,cut:2*H,refs:['A','B','C'].map(project=>({ref:project,source:'s',clientId:'codex',device:{id:'d',name:'Device'},origin:'terminal',project,folder:null,startedAt:0})),spans});

test('selected quota and money hours distinguish unavailable periods from a known empty suffix',()=>{
  const selected={...trace([]),knownFrom:H},full={...trace([[0,H,2*H]]),knownFrom:H};
  const source=sourceWorkCurves(sourceWorkTape(new PeriodCurves(full),0,2*H,new Map([['s',H]]),()=>{}));
  const readings=[0,2*H].map((at,i)=>({id:'usage',at,previousAt:i?0:null,kind:'counter' as const,unit:'USD',amount:i?'1000000':'0',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:4*H}));
  const spans=[{from:0,to:2*H,observedFrom:0,staleAfterMs:4*H}];
  const tape:PeriodTape={from:0,cut:2*H,replaceFrom:0,cursor:'c',quota:[{source:'s',window:'w',workFrom:H,samples:packSamples([{at:0,used:0,resetAt:4*H,staleAfterMs:4*H},{at:2*H,used:10,resetAt:4*H,staleAfterMs:4*H}])}],money:[{source:'s',meter:'balance',role:'total',readings:readings.map(row=>({...row,id:'balance',kind:'balance',amount:'14000000'})),spans,workCounter:{source:'s',unit:'USD',knownFrom:0,workFrom:H,readings,spans}}]};
  const accounting=drain(PeriodAccounting.prepare(tape,selected,undefined,undefined,undefined,undefined,source));
  const series={sourceId:'s',meterId:'balance',kind:'balance',unit:'USD',end:'14000000',role:'total'} as MeterHistory;
  for(const to of [H/2,H,H+M,2*H]){
    const range={from:0,to},expected=to>H?0:null,quota=accounting.quotaSummary('s','w',range)!,money=accounting.moneyWorkSummary('s',range)!;
    assert.equal(quota.selectedWork.ms,expected);assert.equal(money.selectedWork?.activeMs,expected);
    const cells=lineWork({...quota,current:90,minutes:10080},true,4*H,2*H)!;
    assert.deepEqual(cells.work,{none:expected===null?'unknown':'none'});
    assert.deepEqual(cells.agenthours,{none:expected===null?'unknown':'none'});
    assert.equal(moneyWorkValues(series,money).active,expected===null?null:'0');
    const snapshot=accounting.fixed(range,M),fixed=new PeriodAccounting({...tape,fixed:snapshot},null);
    assert.equal(snapshot.quota[0].selectedWork?.ms,expected);
    assert.equal(fixed.moneyWorkSummary('s',range)?.selectedWork?.activeMs,expected);
  }
  assert.equal(accounting.quotaSummary('s','w',{from:H,to:2*H})!.work!.ms,H,'an empty selection does not erase source-wide work');
});

test('an empty selected cohort wakes when a rolling period first enters known work',()=>{
  const tape:PeriodTape={from:-H,cut:3*H,replaceFrom:-H,cursor:'c',money:[],quota:[{source:'s',window:'w',workFrom:H,samples:packSamples([{at:-H,used:0,resetAt:6*H,staleAfterMs:6*H},{at:3*H,used:10,resetAt:6*H,staleAfterMs:6*H}])}]};
  const accounting=drain(PeriodAccounting.prepare(tape,{...trace([]),anchor:-H,cut:3*H,knownFrom:H}));
  assert.equal(accounting.quotaSummary('s','w',{from:0,to:H})!.selectedWork.ms,null);
  assert.equal(accounting.changesAt(H,H,'s'),H+1,'the exclusive right edge must enter the known suffix before the native sample changes');
  assert.equal(accounting.quotaSummary('s','w',{from:1,to:H+1})!.selectedWork.ms,0);
});

test('selected hours use the subset union while quota estimates use the independent source sweep',()=>{
  const full=trace([[0,0,H],[1,30*M,90*M],[2,75*M,120*M]]),selected=trace(full.spans.filter(([id])=>id<2));
  const source=sourceWorkCurves(sourceWorkTape(new PeriodCurves(full),0,2*H,new Map([['s',0]]),()=>{}));
  const tape={from:0,cut:2*H,replaceFrom:0,cursor:'c',money:[],quota:[{source:'s',window:'w',workFrom:0,samples:packSamples([{at:0,used:0,resetAt:4*H,staleAfterMs:4*H},{at:2*H,used:10,resetAt:4*H,staleAfterMs:4*H}])}]};
  const accounting=drain(PeriodAccounting.prepare(tape,selected,undefined,undefined,undefined,undefined,source));
  const value=accounting.quotaSummary('s','w',{from:0,to:2*H})!;
  assert.equal(value.selectedWork.ms,90*M);assert.equal(value.selectedWork.agentMs,120*M);
  assert.equal(value.work!.ms,120*M);assert.equal(value.work!.agentMs,165*M);
  assert.deepEqual(accounting.fixed({from:0,to:2*H},M).quota[0].selectedWork,value.selectedWork);
  assert.equal(accounting.quotaWorkSlope('s','w',90*M+1,H,true)?.slope,-1,'rolling direct hours follow the selected curve');
});

test('a source sweep delta replaces an empty interval inside an hour without losing either edge',()=>{
  const full=trace([[0,0,2*H]]),before=sourceWorkTape(new PeriodCurves(full),0,2*H,new Map([['s',0]]),()=>{});
  const patch={...sourceWorkTape(new PeriodCurves(trace([])),0,2*H,new Map([['s',0]]),()=>{}),replaceFrom:30*M,replaceTo:90*M};
  const merged=sourceWorkCurves(mergeSourceWorkTape(before,patch)).groups.source.get('s')!;
  assert.equal(merged.read({from:0,to:2*H}),H);assert.equal(merged.read({from:30*M,to:90*M}),0);
  assert.equal(merged.read({from:0,to:30*M}),30*M);assert.equal(merged.read({from:90*M,to:2*H}),30*M);
  assert.throws(()=>sourceWorkCurves({...before,patterns:[[0,-1,H,1]]}),/invalid_source_work/);
});

test('sparse source deltas retain known empty sources and compare curves independently of dictionary indices',()=>{
  const before=sourceWorkTape(new PeriodCurves(trace([[0,0,2*H]])),0,2*H,new Map([['s',0],['empty',null]]),()=>{});
  const patch={version:1 as const,from:0,cut:2*H,patterns:[],sources:[],replaceFrom:30*M,replaceTo:90*M};
  const merged=mergeSourceWorkTape(before,patch),curves=sourceWorkCurves(merged);
  assert.equal(curves.groups.source.get('s')!.read({from:0,to:2*H}),H);
  assert.equal(merged.sources.find(row=>row.id==='empty')?.knownFrom,null);
  assert.equal(sameSourceWork(before,merged,'s'),false);
  assert.equal(sameSourceWork(before,merged,'empty'),true);
  const unchanged=mergeSourceWorkTape(before,{...patch,replaceFrom:2*H,replaceTo:2*H});
  assert.equal(sameSourceWork(before,unchanged,'s'),true);
});

test('a month of unchanged source hours shares its patterns through a clipped empty tail',()=>{
  const values=[0,1,H,-1],before={version:1 as const,from:0,cut:720*H,patterns:[values],sources:[{id:'s',knownFrom:0,blocks:Array.from({length:720},(_,hour)=>[hour,0]).flat()}]};
  const patch={version:1 as const,from:1,cut:720*H+1,replaceFrom:720*H,replaceTo:720*H+1,patterns:[],sources:[]};
  const original=JSON.stringify(before);let reserved=0;
  const merged=mergeSourceWorkTape(before,patch,bytes=>{reserved+=bytes;assert.ok(reserved<32*1024,'an empty tail must not allocate a sweep for every retained hour');});
  assert.equal(JSON.stringify(before),original);assert.ok(merged.patterns.includes(values),'whole hours retain the original immutable pattern');
  const curve=sourceWorkCurves(merged).groups.source.get('s')!;
  assert.equal(curve.read({from:0,to:720*H+1}),720*H-1);
  assert.equal(curve.read({from:0,to:1}),0);assert.equal(curve.read({from:720*H,to:720*H+1}),0);
  assert.throws(()=>mergeSourceWorkTape(before,patch,()=>{throw Error('capacity');}),/capacity/);
  assert.equal(JSON.stringify(before),original,'a refused merge leaves the retained tape intact');
});

test('retained source curve bytes count shared pattern buffers once and each timeline separately',()=>{
  const tape={version:1 as const,from:0,cut:720*H,patterns:[[0,1,H,-1]],sources:['a','b'].map(id=>({id,knownFrom:0,blocks:Array.from({length:720},(_,hour)=>[hour,0]).flat()}))};
  let scratch=0;const curves=sourceWorkCurves(tape,bytes=>scratch+=bytes);
  const timelines=[...curves.groups.source.values()];
  // One pattern has two changes in four Float64 columns. Each hour has three
  // Float64 prefixes and a shared pattern reference; source maps own their rows.
  assert.equal(curves.bytes,160+2*4*8+timelines.reduce((sum,t)=>sum+t.bytes,0)+2*(256+2));
  assert.ok(scratch>curves.bytes!,'construction tuples are temporary, not retained buffers');
  assert.equal(timelines[0].read({from:0,to:720*H}),720*H);assert.equal(timelines[1].read({from:0,to:720*H}),720*H);
  const emptyTail=mergeSourceWorkTape(tape,{version:1,from:0,cut:720*H+1,replaceFrom:720*H,replaceTo:720*H+1,patterns:[],sources:[]});
  const shared=sourceWorkCurves(emptyTail,()=>{},{tape,curves});
  for(const id of ['a','b'])assert.equal(shared.groups.source.get(id),curves.groups.source.get(id),'unchanged accounting and its decoder must own the same timeline');
  assert.equal(shared.bytes,curves.bytes);
  const edited={...emptyTail,sources:emptyTail.sources.map(row=>row.id==='a'?{...row,blocks:row.blocks.slice(2)}:row)},changed=sourceWorkCurves(edited,()=>{},{tape:emptyTail,curves:shared});
  assert.notEqual(changed.groups.source.get('a'),shared.groups.source.get('a'));assert.equal(changed.groups.source.get('b'),shared.groups.source.get('b'));
  assert.equal(changed.groups.source.get('a')!.read({from:0,to:720*H}),719*H);
});

test('shared source patterns preserve exact replacement integrals across whole and partial hours',()=>{
  const tape=(spans:WorkTrace['spans'])=>sourceWorkTape(new PeriodCurves({...trace(spans),cut:4*H}),0,4*H,new Map([['s',0]]),()=>{});
  const before=tape([[0,0,3*H],[1,H/2,2*H+H/2],[2,3*H,4*H]]),patch=tape([[0,H,4*H],[1,0,H/2]]);
  const old=sourceWorkCurves(before).groups.source.get('s')!,next=sourceWorkCurves(patch).groups.source.get('s')!;
  for(const from of [0,1,H/2,H])for(const cut of [3*H,4*H])for(const lo of [from,H,3*H])for(const hi of [lo,lo+1,cut].filter(at=>at>=lo&&at<=cut)){
    const merged=sourceWorkCurves(mergeSourceWorkTape(before,{...patch,from,cut,replaceFrom:lo,replaceTo:hi})).groups.source.get('s')!;
    for(const active of [false,true])for(const start of [0,H/2,H,2*H,3*H])for(const end of [start,3*H,4*H].filter(at=>at>=start)){
      const read=(curve:typeof old,a:number,b:number)=>curve.read({from:Math.max(start,from,a),to:Math.min(end,cut,b)},active);
      assert.equal(merged.read({from:start,to:end},active),read(old,from,lo)+read(next,lo,hi)+read(old,hi,cut));
    }
  }
});

test('half an hour selected never halves the full-hour supplier rate or remaining-work estimate',()=>{
  const full=trace([[0,0,H]]),selected=trace([[0,0,H/2]]),range={from:0,to:H+1};
  const source=sourceWorkCurves(sourceWorkTape(new PeriodCurves(full),0,H,new Map([['s',0]]),()=>{}));
  const readings=[0,H].map((at,i)=>({id:'usage',at,previousAt:i?0:null,kind:'counter' as const,unit:'USD',amount:i?'1000000':'0',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:H}));
  const spans=[{from:0,to:H,observedFrom:0,staleAfterMs:H}];
  const tape:PeriodTape={from:0,cut:H+1,replaceFrom:0,cursor:'c',quota:[],money:[{source:'s',meter:'balance',role:'total',readings:readings.map(row=>({...row,id:'balance',kind:'balance',amount:'14000000'})),spans,workCounter:{source:'s',unit:'USD',knownFrom:0,workFrom:0,readings,spans}}]};
  const series={sourceId:'s',meterId:'balance',kind:'balance',unit:'USD',end:'14000000',role:'total'} as MeterHistory;
  const accounting=drain(PeriodAccounting.prepare(tape,selected,undefined,undefined,undefined,undefined,source)),value=accounting.moneyWorkSummary('s',range)!;
  assert.equal(value.activeMs,H);assert.equal(value.selectedWork?.activeMs,H/2);
  assert.deepEqual(moneyWorkValues(series,value),{active:String(H/2),rate:'1000000',remaining:'50400000'});
  const fixed=new PeriodAccounting({...tape,fixed:accounting.fixed(range,M)},null);
  assert.deepEqual(moneyWorkValues(series,fixed.moneyWorkSummary('s',range)),moneyWorkValues(series,value));
  const empty=drain(PeriodAccounting.prepare(tape,trace([]),undefined,undefined,undefined,undefined,source));
  assert.deepEqual(moneyWorkValues(series,empty.moneyWorkSummary('s',range)),{active:'0',rate:'1000000',remaining:'50400000'});
  const unavailable=drain(PeriodAccounting.prepare(tape,null,undefined,undefined,undefined,undefined,source));
  assert.deepEqual(moneyWorkValues(series,unavailable.moneyWorkSummary('s',range)),{active:null,rate:'1000000',remaining:'50400000'});
});
