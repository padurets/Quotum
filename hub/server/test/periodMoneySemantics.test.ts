import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PeriodAccounting} from '../domain/periodAccounting.js';
import type {MoneyTape,PeriodTape} from '../domain/periodTape.js';
import type {Reading,MeterSemantics} from '../domain/meters.js';
import type {RateLeg,Conversion} from '../domain/currency.js';

const native='9007199254740993',limit='18014398509481986';
const legs:RateLeg[]=[
  {id:'default-credit',source:'codex-default',base:'credits:codex',date:0,fetchedAt:1000,from:'1000000',to:'40000'},
  {id:'personal-rate',source:'manual',base:'USD',date:800,fetchedAt:900,from:'1000000',to:'2000000'},
  {id:'reference-rate',source:'ecb',base:'EUR',date:500,fetchedAt:700,from:'3000000',to:'7000000'},
];
const reading=(extra:Partial<Reading>={}):Reading=>({id:'balance:credits',kind:'balance',unit:'credits:codex',amount:native,scale:12,at:1000,previousAt:null,staleAfterMs:10000,limit:null,resetAt:null,minutes:300,scope:'provider',label:'Native',...extra});
const group=(path:RateLeg[]|null,row=reading()):MoneyTape=>({source:'s',meter:row.id,displayUnit:'USD',accounting:{spending:'unavailable',topups:'unavailable'},readings:[row],spans:[{from:1000,to:5000,observedFrom:1000,staleAfterMs:10000}],rates:{[row.unit+'\n1000']:path,[row.unit+'\n5000']:path}});
const tape=(money:MoneyTape):PeriodTape=>({from:1000,cut:5000,replaceFrom:1000,cursor:'cursor',quota:[],money:[money]});
const fixed=(index:PeriodAccounting,to:number)=>index.fixed({from:1000,to},250).money[0];
function proof(semantics:MeterSemantics|null|undefined):Conversion {assert.ok(semantics?.conversion);return semantics.conversion;}

test('one-leg money summaries and boundary points keep one exact rate without a duplicate path',()=>{
  const path=[legs[0]],evidence=tape(group(path)),before=JSON.stringify(evidence),index=new PeriodAccounting(evidence,null);
  for(const to of [1001,2000,5000,5001]){
    const summary=fixed(index,to),conversion=proof(summary.semantics),at=to>5000?5000:1000;
    assert.equal(summary.end,'360287970');assert.equal(summary.endScale,6);assert.equal(summary.spent,null);assert.equal(summary.topup,null);
    assert.deepEqual(conversion.original,{meterId:'balance:credits',amount:native,unit:'credits:codex',at,scale:12,limit:null});
    assert.deepEqual(conversion.rate,legs[0]);assert.strictEqual(conversion.rate,path[0]);
    assert.equal(Object.hasOwn(conversion,'steps'),false);assert.deepEqual(conversion.steps??[conversion.rate],path);
    assert.ok(summary.points.length);
    for(const point of summary.points){
      const pointProof=proof(point.semantics);
      assert.equal(point.value,'360287970');assert.equal(pointProof.original.amount,native);assert.equal(pointProof.original.scale,12);
      assert.equal(pointProof.original.at,point.at>=5000?5000:1000);assert.deepEqual(pointProof.rate,legs[0]);
      assert.equal(Object.hasOwn(pointProof,'steps'),false);assert.deepEqual(pointProof.steps??[pointProof.rate],path);
      assert.ok(point.validUntil!<=15001);
    }
  }
  assert.equal(fixed(index,15001).end,null,'the exclusive native deadline still expires the converted value');
  assert.equal(JSON.stringify(evidence),before,'projection must leave retained native evidence and rate bindings intact');
});

for(const [count,end,convertedLimit] of [[2,'720575940','1441151881'],[3,'1681343861','3362687722']] as const)test(`${count}-leg money paths keep every quote, provenance and order through one exact conversion`,()=>{
  const path=legs.slice(0,count),row=reading({kind:'cap',limit}),evidence=tape(group(path,row)),before=JSON.stringify(evidence),index=new PeriodAccounting(evidence,null);
  for(const to of [2000,5001]){
    const summary=fixed(index,to),conversion=proof(summary.semantics);
    assert.equal(summary.end,end);assert.equal(summary.semantics!.limit,convertedLimit);assert.equal(summary.endScale,6);
    assert.deepEqual(conversion.steps,path);assert.strictEqual(conversion.steps,path);assert.strictEqual(conversion.rate,path.at(-1));
    assert.deepEqual(conversion.original,{meterId:row.id,amount:native,unit:row.unit,at:to>5000?5000:1000,scale:12,limit});
    for(const point of summary.points){assert.equal(point.value,end);assert.deepEqual(proof(point.semantics).steps,path);}
  }
  assert.equal(JSON.stringify(evidence),before);
});

test('a missing rate keeps native metadata and unavailable converted amounts',()=>{
  const evidence=tape(group(null)),before=JSON.stringify(evidence),summary=fixed(new PeriodAccounting(evidence,null),2000);
  assert.equal(summary.start,null);assert.equal(summary.end,null);assert.equal(summary.spent,null);assert.equal(summary.topup,null);assert.deepEqual(summary.points,[]);
  assert.deepEqual(summary.semantics,{limit:null,resetAt:null,minutes:300,scope:'provider',label:'Native',scale:6});
  assert.equal(JSON.stringify(evidence),before);
});

test('native money without display conversion keeps its exact scale, allowance and metadata',()=>{
  for(const displayUnit of [undefined,'credits:codex']){
    const row=reading({kind:'cap',limit}),money={...group(null,row),displayUnit},evidence=tape(money),before=JSON.stringify(evidence),summary=fixed(new PeriodAccounting(evidence,null),2000);
    assert.equal(summary.end,native);assert.equal(summary.endScale,12);
    assert.deepEqual(summary.semantics,{limit,resetAt:null,minutes:300,scope:'provider',label:'Native',scale:12});
    assert.ok(summary.points.length);for(const point of summary.points){assert.equal(point.value,native);assert.deepEqual(point.semantics,summary.semantics);}
    assert.equal(JSON.stringify(evidence),before);
  }
});

test('an original conversion keeps its recorded optional path when no display conversion is applied',()=>{
  const path=[legs[0]],conversion:Conversion={original:{meterId:'balance:credits',amount:'2500000000001',unit:'credits:codex',at:1000,scale:12},rate:legs[0],steps:path};
  const row=reading({unit:'USD',amount:'100000',scale:6,conversion}),money=group(null,row),evidence=tape(money),before=JSON.stringify(evidence),index=new PeriodAccounting(evidence,null);
  for(const to of [2000,5001]){
    const summary=fixed(index,to),actual=proof(summary.semantics);
    assert.equal(summary.end,'100000');assert.equal(summary.endScale,6);assert.deepEqual(actual,{...conversion,original:{...conversion.original,at:to>5000?5000:1000}});
    assert.strictEqual(actual.steps,path);assert.strictEqual(actual.rate,legs[0]);
    for(const point of summary.points)assert.deepEqual(proof(point.semantics).steps,path);
  }
  assert.equal(JSON.stringify(evidence),before,'original provenance is not normalized or mutated');
});
