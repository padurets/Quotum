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

import {calendarCells,calendarPartition,type CalendarCell,type CalendarSection} from '../domain/workCalendar.js';
import {drain} from '../domain/prepare.js';
import type {Stretch} from '../domain/work.js';

test('calendar wire preserves fine bounds, unknowns, parallel work and expiry without repeated edges',()=>{
  const start=Date.UTC(2026,9,1),step=900_000,count=3072;
  const basis={run:'r',revision:'2',evaluatedAt:start+count*step,evidenceCut:start+count*step,range:{from:start+17,to:start+count*step-23}};
  const extended={...basis,calendarKey:'partition',workAuthority:'authority',filterKey:'filter'};
  const cells:CalendarCell[]=Array.from({length:count},(_,i)=>({agentMs:0,from:start+i*step,to:start+(i+1)*step,validUntil:null}));
  cells[0]={agentMs:1,from:start+17,to:start+step,validUntil:start+86_400_018};
  cells[1]={agentMs:null,from:start+2*step,to:start+2*step,validUntil:null};
  cells[2]={agentMs:4*step,from:start+2*step,to:start+3*step,validUntil:start+2*step+86_400_001};
  cells[count-1]={agentMs:0,from:start+(count-1)*step,to:basis.range.to,validUntil:null};
  const reply:PeriodReply={basis,calendar:{state:'complete',basis:extended,value:{zone:'Europe/Berlin',availableFrom:start,retainedFrom:start,cursor:'signed',edges:Array.from({length:count+1},(_,i)=>start+i*step),cells}}};
  const dictionary=periodDictionary(reply,()=>{}),text=compactJSON(reply,dictionary.replacer),wire=JSON.parse(text);
  assert.deepEqual(wire.calendar.value.grid,[start,step,count]);assert.equal(wire.calendar.value.edges,undefined);
  assert.deepEqual(wire.calendar.basis,['partition','authority','filter']);
  assert.ok(text.length<JSON.stringify(reply).length/20);
  let reserved=0;assert.deepEqual(expandPeriod(wire,bytes=>reserved+=bytes),reply);assert.ok(reserved>count*100);
  const foreign={...extended,revision:'1'},other={...reply,calendar:{...reply.calendar!,basis:foreign}} as PeriodReply;
  const otherDictionary=periodDictionary(other,()=>{});assert.deepEqual(expandPeriod(JSON.parse(compactJSON(other,otherDictionary.replacer))),other);
});

test('calendar sparse wire roundtrips exact replacements and rejects malformed grids and tuples',()=>{
  const basis={run:'r',revision:'2',evaluatedAt:180_000,evidenceCut:180_000,range:{from:0,to:180_000}};
  const calendar:CalendarSection={state:'delta',basis:{...basis,calendarKey:'c',workAuthority:'w',filterKey:'f'},value:{availableFrom:17,retainedFrom:0,cursor:'signed',updates:[[0,{agentMs:1,from:17,to:60_000,validUntil:200_001}],[2,{agentMs:null,from:180_000,to:180_000,validUntil:null}]]}};
  const reply:PeriodReply={basis,calendar},dictionary=periodDictionary(reply,()=>{}),text=compactJSON(reply,dictionary.replacer),wire=JSON.parse(text);
  assert.equal(wire.calendar.value.updates,undefined);assert.equal(wire.calendar.value.relative,undefined);assert.ok(text.length<JSON.stringify(reply).length-200);
  assert.deepEqual(expandPeriod(structuredClone(wire)),reply);
  const invalid=structuredClone(wire);invalid.calendar.value.patch[1][0]=0;assert.throws(()=>expandPeriod(invalid),/invalid_calendar_patch/);
  const invalidCell=structuredClone(wire);invalidCell.calendar.value.patch[0][1]=.5;assert.throws(()=>expandPeriod(invalidCell),/invalid_calendar_cell/);
  for(const grid of [[0,60_000,3073],[0,1,3],[0,60_000,2]])assert.throws(()=>expandPeriod({basis,calendar:{state:'complete',basis:['c','w','f'],value:{grid,cells:[0,0,0]}}}),/invalid_calendar_grid/);
  const denied=structuredClone(wire);assert.throws(()=>expandPeriod(denied,()=>{throw new Error('history_limit');}),/history_limit/);
});

test('opted-in calendar deltas shorten twenty exact replacements without changing the legacy wire',()=>{
  const start=1_800_000_000_123,day=86_400_000,range={from:start,to:start+day},edges=calendarPartition(range),first=Math.floor((start-edges[0])/60_000);
  const indices=Array.from({length:20},(_,i)=>first+i),rows=[{from:start+17,to:start+19*60_000+4321},{from:start+61_001,to:start+10*60_000+3001}] as Stretch[];
  const updates=drain(calendarCells(rows,edges,indices,range.to,start-123,0,90*day,range,day));
  const basis={run:'r',revision:'2',evaluatedAt:range.to,evidenceCut:range.to,range};
  const calendar:CalendarSection={state:'delta',basis:{...basis,calendarKey:'c',workAuthority:'w',filterKey:'f'},value:{availableFrom:start-123,retainedFrom:0,cursor:'signed',updates}};
  const reply:PeriodReply={basis,calendar},before=JSON.stringify(reply);
  const encode=(relative=false)=>{const dictionary=periodDictionary(reply,()=>{},false,relative);return compactJSON(reply,dictionary.replacer);};
  const legacyText=encode(),relativeText=encode(true),legacy=JSON.parse(legacyText),wire=JSON.parse(relativeText);
  assert.equal(updates.length,20);assert.equal(legacy.calendar.value.relative,undefined);assert.equal(wire.calendar.value.relative,true);
  assert.deepEqual(legacy.calendar.value.patch,updates.map(([i,c])=>[i,c.agentMs,c.from,c.to,c.validUntil]));
  assert.equal(wire.calendar.value.patch.length,20);assert.ok(Buffer.byteLength(relativeText)<Buffer.byteLength(legacyText),'the same twenty replacements must use fewer decoded wire bytes');
  assert.deepEqual(expandPeriod(legacy),reply);assert.deepEqual(expandPeriod(structuredClone(wire)),reply);assert.equal(JSON.stringify(reply),before);
  const foreign={...reply,basis:{...basis,revision:'foreign',range:{from:start-1,to:range.to-1}}},dictionary=periodDictionary(foreign,()=>{},false,true);
  assert.deepEqual(expandPeriod(JSON.parse(compactJSON(foreign,dictionary.replacer))),foreign,'offsets use the calendar basis even when it differs from the common basis');
  assert.throws(()=>expandPeriod(structuredClone(wire),()=>{throw new Error('history_limit');}),/history_limit/);
});

test('relative calendar bounds preserve negative offsets, null expiry and safe integer limits',()=>{
  const start=1_800_000_000_123,basis={run:'r',revision:'1',evaluatedAt:start+60_000,evidenceCut:start+60_000,range:{from:start,to:start+60_000}};
  const calendar:CalendarSection={state:'delta',basis:{...basis,calendarKey:'c',workAuthority:'w',filterKey:'f'},value:{availableFrom:0,retainedFrom:0,cursor:'c',updates:[[0,{agentMs:0,from:0,to:17,validUntil:null}],[1,{agentMs:null,from:start+17,to:start+17,validUntil:Number.MAX_SAFE_INTEGER}]]}};
  const reply:PeriodReply={basis,calendar},dictionary=periodDictionary(reply,()=>{},false,true),wire=JSON.parse(compactJSON(reply,dictionary.replacer));
  assert.equal(wire.calendar.value.relative,true);assert.equal(wire.calendar.value.patch[0][2],-start);assert.equal(wire.calendar.value.patch[0][4],null);assert.deepEqual(expandPeriod(structuredClone(wire)),reply);
  for(const relative of [false,0,1,'true',null]){const invalid=structuredClone(wire);invalid.calendar.value.relative=relative;assert.throws(()=>expandPeriod(invalid),/invalid_calendar_patch/);}
  for(const offset of [.5,-start-1,Number.MAX_SAFE_INTEGER]){const invalid=structuredClone(wire);invalid.calendar.value.patch[0][2]=offset;assert.throws(()=>expandPeriod(invalid),/invalid_calendar_cell/);}
  const duplicate=structuredClone(wire);duplicate.calendar.value.patch[1][0]=0;assert.throws(()=>expandPeriod(duplicate),/invalid_calendar_patch/);
  const oldBasis={...basis,range:{from:-1,to:60_000}},oldCalendar:CalendarSection={...calendar,basis:{...calendar.basis,...oldBasis},value:{...calendar.value,updates:[[0,{agentMs:0,from:0,to:60_000,validUntil:Number.MAX_SAFE_INTEGER}]]}};
  const old:PeriodReply={basis:oldBasis,calendar:oldCalendar},fallback=periodDictionary(old,()=>{},false,true),absolute=JSON.parse(compactJSON(old,fallback.replacer));
  assert.equal(absolute.calendar.value.relative,undefined,'unsafe offsets keep the legacy absolute representation');assert.deepEqual(expandPeriod(absolute),old);
});

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
