import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluatedRange, intersectPeriod, parsePeriod, periodKey} from '../domain/period.js';

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
  const {packSamples,sampleAt,sampleCount,mergeTape}=await import('../domain/periodTape.js');
  const rows=[{at:0,used:0.125,resetAt:0,staleAfterMs:30000,validUntil:0},{at:20000,used:1.25,resetAt:null,staleAfterMs:60000},{at:40000,used:2.5,resetAt:50000,staleAfterMs:10000,validUntil:49000}];
  const samples=JSON.parse(JSON.stringify(packSamples(rows)));
  assert.equal(sampleCount(samples),3);assert.deepEqual(rows.map((_,i)=>sampleAt(samples,i)),rows);
  const base={from:0,cut:60000,replaceFrom:0,cursor:'a',money:[],quota:[{source:'s',window:'w',samples}]};
  const changed={...base,cursor:'b',replaceFrom:10000,replaceTo:40000,quota:[{source:'s',window:'w',samples:packSamples([{...rows[1],used:9.75}])}]};
  const merged=mergeTape(base,changed).quota[0].samples;
  assert.deepEqual(Array.from({length:sampleCount(merged)},(_,i)=>sampleAt(merged,i)),[rows[0],{...rows[1],used:9.75},rows[2]]);
  assert.deepEqual(rows.map((_,i)=>sampleAt(samples,i)),rows,'published old evidence remains immutable');
});
