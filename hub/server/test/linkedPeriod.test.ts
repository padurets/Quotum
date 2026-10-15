import {test} from 'node:test';
import assert from 'node:assert/strict';
import {drain} from '../domain/prepare.js';
import {MoneyWorkIndex,type WorkCounter} from '../domain/periodMoneyWork.js';
import {PeriodCurves} from '../domain/periodCurves.js';
import {PeriodAccounting} from '../domain/periodAccounting.js';
import {PeriodActivity} from '../domain/periodActivity.js';
import {PeriodIndex} from '../domain/periodIndex.js';
import type {PeriodTape} from '../domain/periodTape.js';
import type {WorkTrace} from '../domain/periodWork.js';
import {moneyWorkRate} from '../domain/moneyWork.js';
import {sourceWorkEligible} from '../domain/moneyWork.js';
import {fixedTape,fixedWork} from '../periodFixed.js';
import {shifted} from '../domain/periodShift.js';

const M=60_000,H=60*M;
const trace=(end=H):WorkTrace=>({anchor:0,cut:2*H,knownFrom:0,refs:[{ref:'fragment',identityRef:'original',source:'wallet',device:{id:'device',name:'Laptop'},origin:'terminal',project:'Project',folder:null,startedAt:0}],spans:[[0,0,end]]});
const counter=():WorkCounter=>({source:'wallet',unit:'USD',knownFrom:0,workFrom:0,readings:[0,20,40,60,80,100].map((at,i)=>({id:'usage',at:at*M,previousAt:i?([0,20,40,60,80,100][i-1]*M):null,kind:'counter',unit:'USD',amount:i<2?'0':'1000000',limit:null,resetAt:null,minutes:null,scope:null,label:null,staleAfterMs:H})),spans:[{from:0,to:100*M,observedFrom:0,staleAfterMs:H}]});
const index=(value=counter(),work=trace())=>drain(MoneyWorkIndex.prepare(value,new PeriodCurves(work).groups.source.get('wallet')));

test('native and converted key selections cannot acquire source-wide work authority',()=>{
  for(const meter of ['key:k:cap','key:k:usage','fx:EUR:key:k:cap','fx:EUR:key:k:usage'])assert.equal(sourceWorkEligible('openrouter',meter),false,meter);
  for(const meter of ['balance','fx:EUR:balance'])assert.equal(sourceWorkEligible('openrouter',meter),true,meter);
  assert.equal(sourceWorkEligible('deepseek','balance:USD'),false);
});

test('whole unchanged native pairs establish the active-hour rate without inventing spending',()=>{
  const value=index().at({from:0,to:H+1});
  assert.equal(value.spent,'1000000');assert.equal(value.eligibleActiveMs,H);
  assert.deepEqual(moneyWorkRate(value,'14000000'),{rate:'1000000',remainingMs:String(14*H),status:'estimate'});
  const zero=counter();for(const reading of zero.readings)reading.amount='0';
  const observed=index(zero).at({from:0,to:H+1});
  assert.equal(moneyWorkRate(observed,'14000000').remainingMs,null);
  assert.equal(moneyWorkRate(observed,'0').remainingMs,'0');
});

test('moving the left edge excludes its crossing native pair and keeps exact active time',()=>{
  const view=index().at({from:20*M+1,to:H+1});
  assert.equal(view.activeMs,40*M-1);assert.equal(view.eligibleActiveMs,20*M);
  assert.equal(view.spent,'0');assert.equal(moneyWorkRate(view,'14000000').status,'insufficient');
  const exclusive=index().at({from:0,to:40*M});
  assert.equal(exclusive.spent,'0');assert.equal(exclusive.eligibleActiveMs,20*M);
});

test('observation loss and an uncertified span head cannot become complete rate intervals',()=>{
  for(const span of [{from:0,to:100*M,observedFrom:30*M,staleAfterMs:H},{from:0,to:100*M,observedFrom:0,holdUntil:20*M,staleAfterMs:H}]){
    const input=counter();input.spans=[span];const value=index(input).at({from:0,to:40*M+1});
    assert.equal(value.eligibleActiveMs,0);assert.equal(value.partial,true);
  }
});

test('native integer spending above Number precision remains exact',()=>{
  const input=counter(),base=9007199254740993n;
  for(const [i,reading] of input.readings.entries())reading.amount=(base+BigInt(i)*base).toString();
  const value=index(input).at({from:0,to:H+1});
  assert.equal(value.spent,(3n*base).toString());assert.equal(moneyWorkRate(value,null).rate,(3n*base).toString());
});

const tape=(input=counter()):PeriodTape=>({from:0,cut:2*H,replaceFrom:0,cursor:'cursor',quota:[],money:[{source:'wallet',meter:'balance',role:'total',readings:[{...input.readings[0],id:'balance',kind:'balance',amount:'14000000'}],spans:input.spans,workCounter:input}]});

test('work changes reuse the common financial index while changing the rate basis',()=>{
  const data=tape(),a=drain(PeriodAccounting.prepare(data,trace(20*M))),b=drain(PeriodAccounting.prepare(data,trace(40*M),undefined,a,new Set(['wallet'])));
  assert.equal(b.financialAuthority,a.financialAuthority);
  assert.equal(a.moneyWorkSummary('wallet',{from:0,to:H+1})!.eligibleActiveMs,20*M);
  assert.equal(b.moneyWorkSummary('wallet',{from:0,to:H+1})!.eligibleActiveMs,40*M);
  assert.deepEqual(a.moneySummary('wallet','balance','USD',{from:0,to:H+1}),b.moneySummary('wallet','balance','USD',{from:0,to:H+1}));
});

test('fixed work estimates move through the shared exact shift window',()=>{
  const work=trace(50*M),data=tape(),range={from:10*M,to:70*M},moved={from:range.from+30_000,to:range.to+30_000};
  const fixed=fixedTape(data,work,range,M,()=>{}),summary=shifted(fixed.fixed!,moved);
  assert.ok(summary);
  const expected=new PeriodAccounting(data,work).moneyWorkSummary('wallet',moved);
  assert.deepEqual(summary.moneyWork?.[0],expected);assert.equal(summary.moneyWork![0].activeMs,40*M-30_000);
});

test('temporal funding fragments keep one agent in period and activity counts',()=>{
  const work=trace();work.refs=[{...work.refs[0],ref:'before'},{...work.refs[0],ref:'after',source:'other'}];work.spans=[[0,0,30*M],[1,30*M,H]];
  const range={from:0,to:H},period=new PeriodIndex(work),activity=new PeriodActivity(work,period.curves);
  activity.update(period.advance(range,H).rows);
  for(const by of ['source','project','device'] as const){const summary=activity.summary(range,by);assert.equal(summary.agents,1);assert.equal(summary.agentMs,H);assert.equal(summary.activeMs,H);}
  assert.deepEqual(activity.summary(range,'source').by.source.map(group=>group.agents),[1,1]);
});

test('fixed boundary bins and their shifted tooltip keep one logical agent',()=>{
  const work=trace();work.refs=[{...work.refs[0],ref:'before'},{...work.refs[0],ref:'after',source:'other'}];work.spans=[[0,0,30_000],[1,30_000,H+M]];
  const range={from:0,to:H},fixed=fixedWork(work,range,M,H+M,()=>{});
  for(const at of [range,{from:1000,to:H+1000}]){
    const value=shifted(fixed.fixed!,at);assert.ok(value);assert.equal(value.activity.agents,1);
    assert.equal(value.activity.cells[0][3],1);assert.equal(value.activity.cells.at(-1)![3],1);
    assert.equal(value.activity.agentMs,H);assert.equal(value.activity.activeMs,H);
  }
});
