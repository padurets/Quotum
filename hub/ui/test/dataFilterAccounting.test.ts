import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodCurves,sourceWorkTape,sourceWorkCurves,mergeSourceWorkTape} from '../../server/domain/periodCurves';
import {PeriodAccounting} from '../../server/domain/periodAccounting';
import {packSamples} from '../../server/domain/periodTape';
import {drain} from '../lib/prepare';
import type {WorkTrace} from '../../server/domain/periodWork';
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
