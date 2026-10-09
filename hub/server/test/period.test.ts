import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluatedRange, intersectPeriod, parsePeriod, periodKey} from '../domain/period.js';
import {packWork,mergeWork,workedSessions,type WorkTrace} from '../domain/periodWork.js';
import {bindRate,rateAt,mergeTape,type MoneyTape,type PeriodTape} from '../domain/periodTape.js';

test('rate dictionaries preserve every observation anchor and revision without repeating paths',()=>{
  const group:MoneyTape={source:'s',meter:'balance:credits',readings:[],spans:[]};
  const path=[{id:'one',base:'credits:codex',from:'1000000',to:'40000',source:'manual',date:0,fetchedAt:123}];
  for(let at=0;at<100;at++)bindRate(group,'credits:codex\n'+at,path);
  bindRate(group,'credits:codex\n100',null);
  bindRate(group,'credits:codex\n99',[{...path[0],id:'two',to:'30000',fetchedAt:456}]);
  assert.equal(group.rateBindings!.paths.length,3);
  for(let at=0;at<99;at++)assert.deepEqual(rateAt(group,'credits:codex\n'+at),path);
  assert.equal(rateAt(group,'credits:codex\n99')![0].fetchedAt,456);
  assert.equal(rateAt(group,'credits:codex\n100'),null);assert.equal(rateAt(group,'credits:codex\n101'),undefined);
  assert.ok(JSON.stringify(group.rateBindings).length<JSON.stringify(Object.fromEntries(Array.from({length:100},(_,at)=>['credits:codex\n'+at,path]))).length/3);
  const before:PeriodTape={from:0,cut:100,replaceFrom:0,cursor:'a',quota:[],money:[group]},updated:MoneyTape={source:'s',meter:group.meter,readings:[],spans:[]};
  bindRate(updated,'credits:codex\n100',path);
  const next={...before,cut:101,replaceFrom:99,money:[updated]},merged=mergeTape(before,next);
  assert.deepEqual(rateAt(merged.money[0],'credits:codex\n100'),path);assert.equal(rateAt(group,'credits:codex\n100'),null);
  assert.deepEqual(mergeTape(merged,next),merged,'retry keeps the same compact dictionary and anchors');
});

test('work patterns preserve clipped hours, gaps, replacement and retry without expanding the ledger',()=>{
  const refs=['a','b'].map(ref=>({ref,source:'s',device:{id:'d',name:'Laptop'},origin:'terminal' as const,project:ref,folder:null,startedAt:0}));
  const trace:WorkTrace={anchor:17,cut:10_800_037,knownFrom:17,refs,spans:[[0,0,61],[0,3_599_900,3_600_017],[0,7_200_010,7_200_043],[1,31,73],[1,3_600_011,3_600_077]]};
  const packed=packWork(trace);
  const delta={anchor:3_599_950,cut:trace.cut,knownFrom:29,refs:[refs[1],refs[0]],spans:[[0,0,171],[1,21,111]] as [number,number,number][],replaceFrom:3_599_950,replaceTo:3_600_200};
  const changed=mergeWork(packed,{...packWork(delta),replaceFrom:delta.replaceFrom,replaceTo:delta.replaceTo});
  const expected=mergeWork(trace,delta);
  for(let from=17;from<8_000_000;from+=137_111){const range={from,to:from+3_600_017},rows=(value:WorkTrace)=>workedSessions(value,range,range.to).sort((a,b)=>a.ref.localeCompare(b.ref));assert.deepEqual(rows(packed),rows(trace));assert.deepEqual(rows(changed),rows(expected));}
  assert.deepEqual(mergeWork(changed,delta),changed);
});

test('a viewing range keeps its exclusive end while live accounting advances without new evidence', () => {
  const hour = 3_600_000, now = 10 * hour;
  const live = parsePeriod({mode: 'live', periodMs: hour})!;
  const fixed = parsePeriod({mode: 'range', from: now - hour, to: now})!;
  assert.deepEqual(evaluatedRange(live, now), evaluatedRange(fixed, now));
  assert.deepEqual(evaluatedRange(live, now + hour / 2), {from: now - hour / 2, to: now + hour / 2});
  assert.deepEqual(evaluatedRange(fixed, now + hour / 2), {from: now - hour, to: now});
  assert.equal(intersectPeriod(evaluatedRange(fixed, now), {from: now, to: now + hour}), null);
  assert.equal(periodKey(live), periodKey({...live}));
  for (const invalid of [{mode: 'live', periodMs: 1}, {mode: 'live', periodMs: 32 * 24 * hour}, {mode: 'range', from: -1, to: hour}, {mode: 'range', from: 1.5, to: hour}, {mode: 'range', from: Infinity, to: Infinity}]) assert.equal(parsePeriod(invalid), null);
});


test('packed quota samples preserve deadlines and replace only the delta interval',async()=>{
  const {packSamples,encodeSamples,decodeSamples,sampleAt,sampleCount,mergeTape}=await import('../domain/periodTape.js');
  const rows=[{at:0,used:0.125,resetAt:0,staleAfterMs:30000,validUntil:0},{at:20000,used:1.25,resetAt:null,staleAfterMs:60000},{at:40000,used:2.5,resetAt:50000,staleAfterMs:10000,validUntil:49000}];
  const samples=JSON.parse(JSON.stringify(packSamples(rows)));
  const decoded=decodeSamples(JSON.parse(JSON.stringify(encodeSamples(rows))));assert.deepEqual(rows.map((_,i)=>sampleAt(decoded,i)),rows);
  assert.equal(sampleCount(samples),3);assert.deepEqual(rows.map((_,i)=>sampleAt(samples,i)),rows);
  const base={from:0,cut:60000,replaceFrom:0,cursor:'a',money:[],quota:[{source:'s',window:'w',samples}]};
  const changed={...base,cursor:'b',replaceFrom:10000,replaceTo:40000,quota:[{source:'s',window:'w',samples:packSamples([{...rows[1],used:9.75}])}]};
  const merged=mergeTape(base,changed).quota[0].samples;
  assert.deepEqual(Array.from({length:sampleCount(merged)},(_,i)=>sampleAt(merged,i)),[rows[0],{...rows[1],used:9.75},rows[2]]);
  assert.deepEqual(rows.map((_,i)=>sampleAt(samples,i)),rows,'published old evidence remains immutable');
});

test('numeric columns preserve fractions, wide deadlines and exact integer offsets',async()=>{
  const {numberColumn,numberAt,numberBytes}=await import('../domain/periodTape.js');
  const {drain}=await import('../domain/prepare.js');
  for(const values of [[1_790_000_000_000,1_790_000_000_001,1_794_294_967_295],[0.125,0.25,0.375],[-1,1_790_000_000_000],[Infinity,Infinity],[0,0,0]]){
    const column=drain(numberColumn(values.length,i=>values[i]));assert.deepEqual(values.map((_,i)=>numberAt(column,i)),values);
    if(values[0]===1_790_000_000_000)assert.equal(numberBytes(column),32+values.length*4);
  }
});

test('piecewise integer columns retain every anchor across cadence changes and arbitrary suffixes',async()=>{
  const {numberColumn,numberAt,numberBytes,lowerNumber}=await import('../domain/periodTape.js');
  const {drain}=await import('../domain/prepare.js');
  const regular=Array.from({length:10000},(_,i)=>1_790_000_000_000+Math.min(i,4000)*60000+Math.max(0,i-4000)*300000);
  let seed=137;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const cases=[regular,[...regular,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER],regular.map(n=>n+.125),Array.from({length:10000},()=>random())];
  for(let take=0;take<20;take++)cases.push(Array.from({length:1000},(_,i)=>i<500?i*3:random()%300));
  for(const values of cases){
    const column=drain(numberColumn(values.length,i=>values[i]));
    assert.deepEqual(values.map((_,i)=>numberAt(column,i)),values);assert.equal(numberAt(column,-1),undefined);assert.equal(numberAt(column,values.length),undefined);
    if(values===regular){assert.ok(numberBytes(column)<256);for(const i of [0,3999,4000,4001,9999]){assert.equal(lowerNumber(column,values[i]),i);assert.equal(lowerNumber(column,values[i]+1),i+1);}}
  }
});

test('neighboring fixed summaries replay sparse boundary changes and exact slopes in both directions',async()=>{
  const {shiftBoundaries,withShiftWindow,shifted,canShift}=await import('../domain/periodShift.js');
  const range={from:100,to:200},read=(offset:number)=>({range:{from:100+offset,to:200+offset},bar:Math.floor((200+offset-1)/50),duration:Math.max(0,30-offset),amount:offset>=10?'9007199254740995':'9007199254740993',points:offset<20?[[100+offset,37.125]]:[],...(offset<30?{label:'Before'}:{other:'After'})});
  const boundaries=shiftBoundaries(range,-20,50,[50],[210,220,230]);let reserved=0;
  const fixed=withShiftWindow(read(0),read,boundaries,bytes=>{reserved+=bytes;});assert.ok(reserved>0);
  for(let offset=-20;offset<50;offset++){
    const target={from:100+offset,to:200+offset};assert.equal(canShift(fixed,target),true,String(offset));
    const {shift:_,...actual}=shifted<typeof fixed>(fixed,target)!;assert.deepEqual(actual,read(offset));
  }
  assert.equal(canShift(fixed,{from:79,to:179}),false);assert.equal(canShift(fixed,{from:150,to:250}),false);
  assert.equal(canShift(fixed,{from:100,to:201}),false);assert.deepEqual(fixed.amount,read(0).amount);
  const moved=shifted<typeof fixed>(fixed,{from:140,to:240})!;
  for(const offset of [-20,0,10,29,49]){const {shift:_,...actual}=shifted<typeof fixed>(moved,{from:100+offset,to:200+offset})!;assert.deepEqual(actual,read(offset),'repeated shifts start from the same immutable proof');}
});
