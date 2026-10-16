import {test} from 'node:test';
import assert from 'node:assert/strict';
import {periodDictionary,expandPeriod,type PeriodWireReply} from '../domain/periodWire.js';
import type {PeriodReply} from '../domain/periodRead.js';
import type {MeterSemantics} from '../domain/meters.js';
import {compactJSON} from '../history.js';
import {withShiftWindow,shifted} from '../domain/periodShift.js';
import {withValueStates,periodValueAt,type PeriodValues} from '../domain/periodValues.js';
import {brotliCompressSync,constants} from 'node:zlib';
import {ValueChanges,applyValueChanges} from '../domain/valueChanges.js';
import type {Chunk,HistoryBasis} from '../domain/history.js';
import {PERIOD_SCOPES} from '../domain/periodRead.js';
import type {HistoryBases,SourceBases} from '../domain/periodSourceWire.js';

test('source ordinals preserve each captured order and every non-source field after JSON parsing',()=>{
  const a='a-source',b='b-source',basis={run:'r',revision:'1',evaluatedAt:3000,evidenceCut:3000,range:{from:0,to:3000}};
  const chunk:Chunk={from:0,to:3000,series:[{source:a,window:a,hold:2000,open:0,cells:[[0,0,0,0]]}],
    meterSeries:[{source:b,meter:a,kind:'balance',unit:'USD',semantics:{limit:null,resetAt:null,minutes:null,scope:null,label:a},cells:[[0,'900719925474099312345',null,null,2000]]}],
    activity:{sessions:[['ref',a,a,a],['unknown',null,null,a],['unheld','unprovided',a,a,'notProvided']],sourceWork:[[b,0,0,0]],devices:{[a]:a},cells:[[0,0,[0],[['s',a,0],['p',a,0],['d',a,0]]]]},
    resets:[[a,a,1000]],grants:[[b,2000,0]],plans:[[a,1000,a,{at:0,plan:b},3000]]};
  const reply:PeriodReply={basis},bases:HistoryBases={},sourceBases:SourceBases={};
  for(const [index,scope] of PERIOD_SCOPES.entries()){
    const sourceIds=index%2?[b,a]:[a,b],meta='meta-'+scope;
    const prior:HistoryBasis={run:'r',now:3000,meta,historyStart:0,known:{work:0,sources:Object.fromEntries(sourceIds.map(id=>[id,0]))}};
    bases[scope]=prior;sourceBases[scope]={run:'r',meta,sourceIds};
    reply[scope]={state:'complete',basis,value:{run:'r',now:3000,meta,chunks:[structuredClone(chunk)]}};
  }
  const original=structuredClone(reply),savedBases=JSON.stringify(bases);let producerBytes=0,readerBytes=0;
  const dictionary=periodDictionary(reply,n=>{producerBytes+=n;},sourceBases),json=compactJSON({...reply,...(dictionary.moneySemantics.length?{moneySemantics:dictionary.moneySemantics}:{})},dictionary.replacer),wire=JSON.parse(json);
  for(const scope of PERIOD_SCOPES){
    const value=wire[scope].value,ids=sourceBases[scope]!.sourceIds;
    assert.equal(value.sourceEncoding,'basis');assert.equal(value.chunks[0].series[0].source,ids.indexOf(a));
    assert.equal(value.chunks[0].meterSeries[0].source,ids.indexOf(b));
    assert.deepEqual(value.chunks[0].activity.cells[0][3], [['s',ids.indexOf(a),0],['p',a,0],['d',a,0]]);
    assert.equal(value.chunks[0].activity.sessions[1][1],null);assert.equal(value.chunks[0].activity.sessions[2][1],'unprovided');
  }
  const restored=expandPeriod(wire,n=>{readerBytes+=n;},bases);
  assert.deepEqual(restored,original);assert.ok(producerBytes>0&&readerBytes>0);
  assert.deepEqual(reply,original,'serialization cannot change shared native cells');assert.equal(JSON.stringify(bases),savedBases);
  assert.equal(expandPeriod(restored,()=>{throw new Error('already decoded');}),restored);
  const denied=JSON.parse(json),unchanged=JSON.stringify(denied);
  assert.throws(()=>expandPeriod(denied,()=>{throw new Error('denied');},bases),/denied/);
  assert.equal(JSON.stringify(denied),unchanged,'allocation denial precedes replacement of the first source');
  for(const mutate of [
    (value:any)=>{value.sourceEncoding='other';},(value:any)=>{value.known=bases.quota!.known;},
    (value:any)=>{value.run='other';},(value:any)=>{value.meta='other';},
    ...[-1,.5,2,NaN,Infinity].map(index=>(value:any)=>{value.chunks[0].series[0].source=index;}),
  ]){const invalid=JSON.parse(json);mutate(invalid.quota.value);assert.throws(()=>expandPeriod(invalid,()=>{},bases),/invalid_period_sources/);}
  assert.throws(()=>expandPeriod(JSON.parse(json)),/invalid_period_sources/);
});

test('record array tails keep exact changed prefix fields without resending their monetary evidence',()=>{
  const semantics:MeterSemantics={limit:null,resetAt:null,minutes:null,scope:null,label:null,scale:6,
    conversion:{original:{meterId:'balance:credits',amount:'9007199254740993001',unit:'credits:codex',at:1001,scale:12},
      rate:{id:'recorded',source:'manual',base:'credits:codex',from:'1000000',to:'40000',date:3,fetchedAt:4},
      steps:Array.from({length:6},(_,i)=>({id:`recorded-${i}`,source:'manual',base:'credits:codex',from:'1000000',to:'40000',date:i,fetchedAt:i+1}))}};
  const point=(at:number)=>({at,value:'360287970189639720',knownFrom:at,knownUntil:at+100,validUntil:at+100,segment:at,semantics:structuredClone(semantics)});
  const before={points:[point(1000),point(1100)]};
  const after={points:[{...point(1010),value:'360287970189639721'},point(1100),point(1200)]};
  const original=JSON.stringify(before),registry=new ValueChanges(()=>{});
  const parent=registry.pathId(['points']);
  const at=registry.pathId(['points',0,'at']);
  const changes=registry.advanced(before,after,[[at,1]],10);
  assert.ok(JSON.stringify(changes).length<JSON.stringify(after).length/2,'unchanged provenance must not be sent again for prefix points');
  assert.ok(changes.some(change=>change.length===4&&change[0]===parent&&change[1]===2&&change[2]===0));
  const start=structuredClone(before);start.points[0].at+=10;
  const basis={run:'r',revision:'1',evaluatedAt:2010,evidenceCut:2010,range:{from:1010,to:2010}};
  const fixed={range:basis.range,cell:100,money:[],quota:[],shift:{until:2010,steps:[],window:{paths:registry.paths,slopes:[[]],pieces:[[2010,2110,0,changes]]}}};
  const reply={basis,budget:{state:'complete',basis,value:{chunks:[],tape:{fixed}}}} as unknown as PeriodReply;
  const dictionary=periodDictionary(reply,()=>{}),wire=compactJSON(reply,dictionary.replacer);
  const restored=expandPeriod(JSON.parse(wire));
  if(restored.budget?.state!=='complete')throw new Error('missing budget');
  const window=restored.budget.value.tape!.fixed!.shift!.window!;
  assert.equal(window.pieces[0][3][0][0],parent,'packing puts the parent tail splice before prefix edits');
  applyValueChanges(start,window.paths,window.pieces[0][3]);assert.deepEqual(start,after);
  const reversed=structuredClone(before);reversed.points[0].at+=10;
  applyValueChanges(reversed,registry.paths,changes);assert.deepEqual(reversed,after);
  const trim=new ValueChanges(()=>{}),trimmed={points:[{...point(1000),value:'360287970189639719'}]};
  const trimming=trim.between(after,trimmed),copy=structuredClone(after);
  applyValueChanges(copy,trim.paths,trimming);assert.deepEqual(copy,trimmed);
  assert.equal(JSON.stringify(before),original,'diffing cannot change retained input or its provenance');
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
