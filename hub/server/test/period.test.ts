import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluatedRange, intersectPeriod, parsePeriod, periodKey} from '../domain/period.js';
import {packWork,mergeWork,workedSessions,type WorkTrace} from '../domain/periodWork.js';

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
