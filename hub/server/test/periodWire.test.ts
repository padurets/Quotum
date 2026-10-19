import {test} from 'node:test';
import assert from 'node:assert/strict';
import {periodDictionary,expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import type {PeriodReply} from '../domain/periodRead.js';
import type {MeterSemantics} from '../domain/meters.js';
import {compactJSON} from '../history.js';
import {withShiftWindow,shifted} from '../domain/periodShift.js';
import {withValueStates,periodValueAt,type PeriodValues} from '../domain/periodValues.js';
import {brotliCompressSync,constants} from 'node:zlib';

test('filter-aware section bases share the top-level commit without changing legacy replies',()=>{
  const basis={run:'shared',revision:'17',evaluatedAt:1_800_000_000_123,evidenceCut:1_800_000_000_123,range:{from:1_799_996_400_123,to:1_800_000_000_123}};
  const reply:PeriodReply={basis,values:{state:'complete',basis,value:[]},sourceWork:{state:'complete',basis,value:{version:1,from:basis.range.from,cut:basis.range.to,patterns:[],sources:[],cursor:'cursor'}},quota:{state:'error',error:'unavailable'}};
  const encode=(compact:boolean)=>{const dictionary=periodDictionary(reply,()=>{},compact);return compactJSON(reply,dictionary.replacer);};
  const legacy=JSON.parse(encode(false)),packed=encode(true),wire=JSON.parse(packed);
  assert.deepEqual(legacy.values.basis,basis);assert.deepEqual(wire.basis,basis);
  assert.equal(wire.values.basis,0);assert.equal(wire.sourceWork.basis,0);assert.deepEqual(wire.quota,reply.quota);
  assert.ok(packed.length<encode(false).length-250);
  const decoded=expandPeriod(wire);assert.deepEqual(decoded,reply);
  if(decoded.values?.state==='complete')assert.equal(decoded.values.basis,decoded.basis);
  assert.deepEqual(reply.values?.state==='complete'&&reply.values.basis,basis,'packing leaves the domain reply unchanged');
  wire.values.basis=1;assert.throws(()=>expandPeriod(wire),/invalid_period_basis/);
});

test('period dictionaries preserve exact observations, null inheritance and recorded rate paths',()=>{
  const rate={id:'recorded',source:'manual',base:'credits:codex',from:'1000000',to:'40000',date:3,fetchedAt:4};
  const semantics:MeterSemantics={limit:null,resetAt:null,minutes:null,scope:null,label:null,scale:6,
    conversion:{original:{meterId:'balance:credits',amount:'9007199254740993001',unit:'credits:codex',at:1001,scale:12},rate,steps:[rate]}};
  const later={...semantics,conversion:{...semantics.conversion!,original:{...semantics.conversion!.original,at:2001}}};
  const basis={run:'r',revision:'1',evaluatedAt:3000,evidenceCut:3000,range:{from:0,to:3000}};
  const reply:PeriodReply={basis,funds:{state:'complete',basis,value:{now:3000,run:'r',historyStart:0,known:{work:0,sources:{}},chunks:[{
    from:0,to:3000,series:[],resets:[],grants:[],activity:{sessions:[],devices:{},cells:[]},
    meterSeries:[{source:'s',meter:'balance:credits',kind:'balance',unit:'USD',semantics:null,cells:[[0,'360287970189639720',null,null,2000,
      {semantics:later,openSemantics:semantics,observations:[{at:1001,value:'360287970189639720',validUntil:2001,semantics:structuredClone(semantics)},{at:2001,value:'360287970189639720',validUntil:3000},{at:3000,value:'360287970189639720',validUntil:3001,semantics:null}]}]]}],
  }]}}};
  const original=structuredClone(reply);let reserved=0;
  const dictionary=periodDictionary(reply,bytes=>{reserved+=bytes;});
  const json=compactJSON({...reply,moneySemantics:dictionary.moneySemantics,rateLegs:dictionary.rateLegs},dictionary.replacer);
  const wire=JSON.parse(json) as PeriodWireReply;
  assert.ok(reserved>0);assert.equal(wire.moneySemantics!.length,1);assert.equal(wire.rateLegs!.length,1);
  assert.ok(json.length<compactJSON(reply).length);
  assert.deepEqual(expandPeriod(wire),reply);
  assert.deepEqual(reply,original,'packing cannot mutate shared cells or their provenance');
  assert.equal(expandPeriod(wire),wire,'an expanded reply can be consumed again');
  const broken=JSON.parse(json);broken.rateLegs=[];
  assert.throws(()=>expandPeriod(broken),/invalid_period_rate/);
  const missing=JSON.parse(json);missing.moneySemantics=[];
  assert.throws(()=>expandPeriod(missing),/invalid_period_semantics/);
});

test('field-grouped replay programs preserve exact fixed summaries and card states in both directions',()=>{
  const read=(offset:number)=>({range:{from:1000+offset,to:2000+offset},cell:50,money:[],quota:Array.from({length:24},(_,i)=>({
    sourceId:`s${i}`,windowId:'weekly',consumed:offset<10?i+.100000000000003:i+.200000000000007,coveredMs:1000-offset,
    remainingAtStart:offset<30?null:0,remainingAtEnd:offset<10?1:2,
    points:[...(offset<20?[[1000+offset,37.125,1,1020]]:[]),[1100,i+.25,2,1200],...(offset>=20?[[1900,42.125,3,2000+offset]]:[])],
    ...(offset<10?{work:{from:1000+offset,ms:10}}:offset<30?{}:{work:{from:1030,ms:0}}),
  }))});
  const fixed=withShiftWindow(read(0),read,[-20,0,10,20,30,50],()=>{});
  const value=(i:number):PeriodValues=>({id:'s',provider:'codex',windows:[],keys:[],validFor:{from:i*10,to:(i+1)*10},
    meters:[{id:'balance:credits',kind:'balance',amount:`90071992547409931234${i}`,unit:'credits:codex',at:i*10,staleAfterMs:100,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null}]});
  const states=withValueStates(value(2),Array.from({length:8},(_,i)=>value(i)),()=>{});
  const basis={run:'r',revision:'1',evaluatedAt:3000,evidenceCut:3000,range:fixed.range};
  const reply={basis,quota:{state:'complete',basis,value:{chunks:[],tape:{fixed}}},values:{state:'complete',basis,value:[states]}} as unknown as PeriodReply;
  const before=JSON.stringify(reply);let serverBytes=0,clientBytes=0;
  const dictionary=periodDictionary(reply,n=>{serverBytes+=n;});
  const json=compactJSON(reply,dictionary.replacer);assert.ok(json.includes('"pathEncoding":"prefix"'));
  const compressed=(s:string)=>brotliCompressSync(s,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}).length;
  assert.ok(compressed(json)<compressed(compactJSON(reply)),'the exact repeated programs must compress better');
  const restored=expandPeriod(JSON.parse(json),n=>{clientBytes+=n;});assert.ok(clientBytes>0&&serverBytes>0);
  if(restored.quota?.state!=='complete'||restored.values?.state!=='complete')throw new Error('missing sections');
  let moved=restored.quota.value.tape!.fixed!;
  for(const offset of [49,-20,20,0,9,10,29,30,19,1]){
    moved=shifted(moved,{from:1000+offset,to:2000+offset})!;
    const {shift:_,...actual}=moved;assert.deepEqual(actual,read(offset));
  }
  let card=restored.values.value[0];
  for(const i of [7,0,2,5,1,6,3,4]){card=periodValueAt(card,i*10)!;const {states:_,...actual}=card;assert.deepEqual(actual,value(i));}
  assert.equal(JSON.stringify(reply),before,'packing cannot mutate retained evidence');
  assert.equal(expandPeriod(restored,()=>{throw new Error('already expanded');}),restored);
  const denied=JSON.parse(json),unchanged=JSON.stringify(denied);
  assert.throws(()=>expandPeriod(denied,()=>{throw new Error('denied');}),/denied/);
  assert.equal(JSON.stringify(denied),unchanged,'allocation denial precedes the first expansion');
  const malformed=JSON.parse(json);malformed.quota.value.tape.fixed.shift.window.paths[0][0]=100;
  assert.throws(()=>expandPeriod(malformed),/invalid_period_sequence/);
});

test('owned JSON restores every replay change without allocating replacement tuples',()=>{
  const window={pathEncoding:'prefix',paths:[[0,'removed'],[0,'amount'],[0,'count'],[0,'items']],
    pieces:[[1000,2000,0],[2000,3000,1]],changes:[[[0]],[[0,'900719925474099312345']],[[1,-3,0]],[[1,0,1,[{amount:'900719925474099399999'}]]]]};
  const wire=JSON.parse(JSON.stringify({quota:{state:'complete',value:{tape:{fixed:{shift:{window}}}}}}));
  const sequence=wire.quota.value.tape.fixed.shift.window,tuples:unknown[][]=sequence.changes.flat();
  let reserved=0;expandPeriod(wire,bytes=>{reserved+=bytes;});assert.ok(reserved>0);
  assert.deepEqual(sequence.paths,[['removed'],['amount'],['count'],['items']]);
  assert.deepEqual(sequence.pieces,[[1000,2000,0,[[0],[1,'900719925474099312345']]],
    [2000,3000,1,[[2,-3,0],[3,0,1,[{amount:'900719925474099399999'}]]]]]);
  const restored:unknown[][]=sequence.pieces.flatMap((piece:unknown[])=>piece.at(-1));
  for(const tuple of tuples)assert.ok(restored.includes(tuple),'the output retains the already decoded tuple');
  assert.equal(sequence.changes,undefined);assert.equal(sequence.pathEncoding,undefined);
});
