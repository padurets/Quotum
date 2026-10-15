import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodAccounting} from '../lib/periodAccounting';
import {HistoryPool} from '../lib/historyPool';
import {drain,Preparations,prepareAsync} from '../lib/prepare';
import {AMOUNT_MAX} from '../../server/domain/amount';
import type {Reading} from '../../server/domain/meters';
import type {MoneyTape,PeriodTape} from '../../server/domain/periodTape';

const reading=(at:number,amount:string,kind:Reading['kind']='counter'):Reading=>({id:'m',kind,unit:'USD',amount,at,previousAt:at?at-10:null,staleAfterMs:1000,limit:null,resetAt:null,minutes:null,scope:null,label:null});
const group=(count=9):MoneyTape=>({source:'s',meter:'m',accounting:{spending:'counter',topups:'counter'},readings:Array.from({length:count},(_,i)=>reading(i*10,(i%2?AMOUNT_MAX:0n).toString())),spans:[{from:0,to:count*10,staleAfterMs:1000}]});
const tape=(money:MoneyTape):PeriodTape=>({from:0,cut:money.readings.at(-1)!.at+10,replaceFrom:0,cursor:'cursor',quota:[],money:[money]});
const summary=(value:PeriodAccounting,from:number,to:number,unit='USD')=>value.moneySummary('s','m',unit,{from,to})!;

test('both money prefixes exceed 64 bits while preserving every exclusive and partial interval edge',()=>{
  const evidence=group(),index=new PeriodAccounting(tape(evidence),null);
  for(let from=0;from<=90;from+=5)for(let to=from+1;to<=100;to+=3){
    const steps=[10,30,50,70],located=steps.filter(end=>end<to&&end-10>=from),partial=steps.filter(end=>end>=from&&end<to&&end-10<from);
    const actual=summary(index,from,to),covered=Math.max(0,Math.min(to,90)-from),total=covered?(BigInt(located.length)*AMOUNT_MAX).toString():null;
    assert.equal(actual.spent,total);assert.equal(actual.topup,total);
    const unlocated=partial.map(end=>({from:end-10,to:end,amount:AMOUNT_MAX.toString(),evidence:'continuous'}));
    assert.deepEqual(actual.unlocated,unlocated);assert.deepEqual(actual.topupUnlocated,unlocated);
  }
  assert.equal(summary(index,0,100).spent,(4n*AMOUNT_MAX).toString());
  assert.ok(BigInt(summary(index,0,100).spent!)>1n<<64n);
});

test('gaps and estimates keep their own exact amounts instead of borrowing continuous prefixes',()=>{
  const gaps=group(4);gaps.spans=[{from:0,to:5,staleAfterMs:1000},{from:15,to:25,staleAfterMs:1000}];
  const gap=summary(new PeriodAccounting(tape(gaps),null),5,31);
  assert.equal(gap.spent,'0');assert.equal(gap.topup,'0');
  assert.deepEqual(gap.unlocated,[{from:0,to:10,amount:AMOUNT_MAX.toString(),evidence:'gap'},{from:20,to:30,amount:AMOUNT_MAX.toString(),evidence:'gap'}]);
  const balance=group(3);balance.readings=[reading(0,AMOUNT_MAX.toString(),'balance'),reading(10,(-AMOUNT_MAX).toString(),'balance'),reading(20,AMOUNT_MAX.toString(),'balance')];
  const estimated=summary(new PeriodAccounting(tape(balance),null),0,21);
  assert.equal(estimated.spent,'0');assert.equal(estimated.topup,(2n*AMOUNT_MAX).toString());
  assert.deepEqual(estimated.unlocated,[{from:0,to:10,amount:(2n*AMOUNT_MAX).toString(),evidence:'estimate'}]);
});

test('missing conversion preserves null accounting and a zero unlocated boundary amount',()=>{
  const money=group(3);money.displayUnit='EUR';money.rates={'USD\n0':null,'USD\n10':null,'USD\n20':null};
  const actual=summary(new PeriodAccounting(tape(money),null),5,11,'EUR');
  assert.equal(actual.spent,null);assert.equal(actual.topup,null);assert.equal(actual.end,null);
  assert.deepEqual(actual.unlocated,[{from:0,to:10,amount:'0',evidence:'continuous'}]);
  assert.deepEqual(actual.topupUnlocated,actual.unlocated);
});

test('paired funding and unsupported accounting build only their authoritative indexes',()=>{
  const money=group(3);money.readings=[reading(0,'0'),reading(10,'2'),reading(20,'5')];
  money.paired={readings:[reading(0,'100'),reading(10,'120'),reading(20,'150')],spans:money.spans};
  const actual=summary(new PeriodAccounting(tape(money),null),0,21);
  assert.equal(actual.spent,'5');assert.equal(actual.topup,'50');assert.equal(actual.end,'145');
  const unsupported={...money,accounting:{spending:'unavailable',topups:'unavailable'} as const};
  const absent=summary(new PeriodAccounting(tape(unsupported),null),0,21);
  assert.equal(absent.spent,null);assert.equal(absent.topup,null);assert.deepEqual(absent.unlocated,[]);assert.deepEqual(absent.topupUnlocated,[]);assert.equal(absent.end,'145');
});

test('money preparation keeps the construction reservation through yields and releases it on cancellation',async()=>{
  const evidence=tape(group(5000)),pool=new HistoryPool(),owner={},flight={role:'visible' as const},pin={role:'visible' as const};
  assert.ok(pool.reserve(pin,pool.budget-1));let progress=0;
  assert.throws(()=>drain(PeriodAccounting.prepare(evidence,null,undefined,undefined,new Set(),bytes=>{progress++;if(!pool.reserve(flight,bytes))throw Error('history_limit');})),/history_limit/);
  assert.equal(progress,1,'admission fails before allocating or yielding an index');pool.release(pin);pool.release(flight);
  const jobs:(()=>void)[]=[],scheduler=new Preparations({now:()=>0,post:job=>jobs.push(job)},-1),charges:number[]=[];
  const pending=prepareAsync(owner,PeriodAccounting.prepare(evidence,null,undefined,undefined,new Set(),bytes=>{charges.push(bytes);assert.ok(pool.reserve(flight,bytes));}),()=>true,scheduler).finally(()=>pool.release(flight));
  jobs.shift()!();assert.ok(pool.estimatedBytes>0);const peak=pool.estimatedBytes;
  for(let i=0;i<8;i++)jobs.shift()!();assert.equal(pool.estimatedBytes,peak,'incomplete builders never receive the retained-only charge');
  scheduler.cancel(owner);assert.equal(await pending,null);assert.equal(pool.estimatedBytes,0);scheduler.dispose();
  const completedCharges:number[]=[];const completed=drain(PeriodAccounting.prepare(evidence,null,undefined,undefined,new Set(),bytes=>completedCharges.push(bytes)));
  assert.equal(completedCharges.at(-1),completed.bytes);assert.ok(completedCharges[0]>completed.bytes);
  const reusedCharges:number[]=[];const reused=drain(PeriodAccounting.prepare(evidence,null,undefined,completed,new Set(),bytes=>reusedCharges.push(bytes)));
  assert.deepEqual(reusedCharges,[]);assert.equal(reused.bytes,completed.bytes);assert.deepEqual(summary(reused,5,49999),summary(completed,5,49999));
});
