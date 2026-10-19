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
const M=60_000,H=60*M;
const trace=(spans:WorkTrace['spans']):WorkTrace=>({anchor:0,knownFrom:0,cut:2*H,refs:['A','B','C'].map(project=>({ref:project,source:'s',clientId:'codex',device:{id:'d',name:'Device'},origin:'terminal',project,folder:null,startedAt:0})),spans});

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
