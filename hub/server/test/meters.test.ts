import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addAmounts, amount, AMOUNT_MAX, decimal} from '../domain/amount.js';
import {calendarSpending, plottedAmount, spending, type Reading} from '../domain/meters.js';
import {Store} from '../store/store.js';
import type {Meter, MeterMeasurement} from '../domain/meters.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('decimal money is quantized once, including ties, exponent tokens and integers beyond Number precision', () => {
  for (const [token, expected] of [['37.104969129', 37104969n], ['0.1000005', 100001n], ['-0.1000005', -100001n], ['1.000005e-1', 100001n], ['9007199254.740993', 9007199254740993n], ['0e100', 0n], ['1e-100', 0n]] as const) assert.equal(decimal(token), expected, token);
  assert.equal(amount(AMOUNT_MAX.toString()), AMOUNT_MAX);
  for (const token of ['NaN', 'Infinity', '01', '+1', '1e101', '9223372036854.775808']) assert.throws(() => decimal(token), /amount/, token);
  for (const token of ['01', '-0', '1e3', (AMOUNT_MAX + 1n).toString()]) assert.throws(() => amount(token));
  assert.throws(() => addAmounts([{unit: 'USD', amount: '1'}, {unit: 'requests', amount: '1'}]), /mixed_units/);
  assert.deepEqual(addAmounts([{unit: 'USD', amount: AMOUNT_MAX.toString()}, {unit: 'USD', amount: '1'}]), {unit: 'USD', amount: (AMOUNT_MAX + 1n).toString()});
});

const reading = (at: number, value: string, previousAt: number | null = null): Reading => ({id: 'usage', kind: 'counter', unit: 'USD', amount: value, at, previousAt, staleAfterMs: 300_000, limit: null, resetAt: null, minutes: null, scope: null, label: null});

test('the same continuous midnight step is unlocated for the day and known for its week', () => {
  const from = Date.parse('2026-09-30T23:59:00Z'), to = from + 120_000;
  const summary = calendarSpending([reading(from, '1000000'), reading(to, '4000000', from)], [{from, to, staleAfterMs: 300_000}], to);
  assert.equal(summary.day.amount, '0');
  assert.deepEqual(summary.day.unlocated, [{from, to, amount: '3000000', evidence: 'continuous'}]);
  assert.equal(summary.week.amount, '3000000');
  assert.equal(summary.week.uncertain, false);
  assert.equal(summary.month.amount, '0');
});

test('baseline is not spending; counter corrections and cap remaining are separate rules', () => {
  assert.equal(spending([reading(1, '38000000')], [], 0, 2).amount, null);
  const rows = [reading(1, '7000000'), reading(2, '3000000', 1), reading(3, '5000000', 2)];
  assert.equal(spending(rows, [{from: 1, to: 3, staleAfterMs: 300_000}], 1, 3).amount, '2000000');
  assert.equal(plottedAmount({kind: 'cap', amount: '0', limit: '0'}), '0');
  assert.equal(plottedAmount({kind: 'cap', amount: '12000000', limit: '10000000'}), '-2000000');
});

test('a retained baseline after a long gap keeps the first increase once with its original interval', () => {
  const from = 1, after = 100 * 86_400_000;
  const rows = [reading(from, '7000000'), reading(after, '10000000', from), reading(after + 60_000, '11000000', after)];
  const spans = [{from: after, to: after + 60_000, staleAfterMs: 300_000}];
  const result = spending(rows, spans, after - 1, after + 60_000);
  assert.equal(result.amount, '1000000');
  assert.deepEqual(result.unlocated, [{from, to: after, amount: '3000000', evidence: 'gap'}]);
});

const measure = (at: number, meters: Meter[], keys: MeterMeasurement['keys'] = [], complete = true): MeterMeasurement => ({type: 'meters', observedAt: at, staleAfterMs: 300_000, meters, keys, inventoryComplete: complete, inventoryError: complete ? null : 'connector_failed'});
const meter = (id: string, at: number, value: string): Meter => ({...reading(at, value), id, stale: false});

test('exact SQLite readings are sparse on heartbeat and retain the real preceding observation', () => {
  const store = new Store(':memory:', 1);
  const source = store.source('openrouter', '111111111111111111111111', 1);
  const record = (at: number, usage: string, credits = '50000000') => store.record(source, measure(at, [meter('usage', at, usage), meter('credits', at, credits)]));
  record(1, '30000000'); record(60_001, '30000000'); record(120_001, '33000000', '70000000');
  assert.deepEqual(store.meters.readings(source, 'usage', 0, 200_000).map(r => [r.at,r.amount,r.previousAt]), [[1,'30000000',null],[120_001,'33000000',60_001]]);
  assert.deepEqual(store.meters.spans(source, 'usage', 0, 200_000), [{from: 1,to: 120_001,staleAfterMs: 300_000}]);
  assert.equal(store.state(source).successAt, 120_001);
  assert.equal(store.meters.calendar(source, 120_001).day.amount, '3000000', 'credits increased by twenty, while usage increased by three');
  const huge = '9007199254740993';
  record(180_001, huge);
  assert.equal(store.meters.readings(source, 'usage', 0, 200_000).at(-1)?.amount, huge);
  store.close();
});

test('only two successful missing traversals archive a key; partial and reappearance preserve identity and history', () => {
  const store = new Store(':memory:', 1);
  const source = store.source('openrouter', '111111111111111111111111', 1);
  const id = '012345abcdef';
  const key = (at: number) => ({id, name: 'laptop', disabled: false, expiresAt: null, includeByok: false, at, staleAfterMs: 300_000, presence: 'observed' as const, missCount: 0, periods: {day: '1',week: '1',month: '1'}});
  const seen = (at: number, complete = true) => store.record(source, measure(at, [meter('credits',at,'100'),meter('usage',at,'1'),meter(`key:${id}:usage`,at,'1')], [key(at)], complete));
  const miss = (at: number, complete = true) => store.record(source, measure(at, [meter('credits',at,'100'),meter('usage',at,'1')], [], complete));
  seen(1); miss(60_001);
  assert.equal(store.state(source).keys?.[0].missCount, 1);
  assert.equal(store.state(source).meters?.find(m => m.id.includes(id))?.stale, true);
  miss(120_001, false);
  assert.equal(store.state(source).keys?.[0].missCount, 1);
  seen(180_001, false);
  assert.equal(store.state(source).keys?.[0].missCount, 0);
  miss(240_001); miss(300_001);
  assert.equal(store.state(source).keys?.length, 0);
  assert.equal(store.state(source).meters?.some(m => m.id.includes(id)), false);
  assert.equal(store.meters.readings(source, `key:${id}:usage`, 0, 400_000).length, 1);
  seen(360_001);
  assert.equal(store.state(source).keys?.[0].id, id);
  store.close();
});

test('an archived key keeps its last actual heartbeat as spending evidence through retention',()=>{
  for(const retained of [false,true]) {
    const store=new Store(':memory:',1),source=store.source('openrouter','1'.repeat(24),1),id='012345abcdef',mid=`key:${id}:usage`;
    const heartbeat=30*86400000,back=retained?130*86400000:heartbeat+180000;
    const key=(at:number)=>({id,name:null,disabled:false,expiresAt:null,includeByok:false,at,staleAfterMs:300000,presence:'observed' as const,missCount:0,periods:{day:null,week:null,month:null}});
    const seen=(at:number,value:string)=>store.record(source,measure(at,[meter(mid,at,value)],[key(at)]));
    try {
      seen(1,'10000000');seen(heartbeat,'10000000');
      store.record(source,measure(heartbeat+60000,[]));store.record(source,measure(heartbeat+120000,[]));
      if(retained)store.prune(back);
      seen(back,'15000000');
      const rows=store.meters.readings(source,mid,0,back+1),spans=store.meters.spans(source,mid,0,back+1);
      assert.equal(rows.at(-1)?.previousAt,heartbeat);
      assert.equal(spending(rows,spans,heartbeat,back).unlocated[0].from,heartbeat);
      assert.equal(spending(rows,spans,heartbeat,back).unlocated[0].to,back);
    }finally{store.close();}
  }
});

test('pruning retains a predecessor beyond ninety days and rejects invalid neighbors atomically', () => {
  const store = new Store(':memory:', 1);
  const source = store.source('openrouter', '111111111111111111111111', 1);
  store.record(source, measure(1,[meter('credits',1,'100'),meter('usage',1,'7')]));
  store.prune(100 * 86_400_000);
  assert.equal(store.meters.readings(source,'usage',0,100 * 86_400_000).length,1);
  assert.throws(() => store.record(source,measure(2,[meter('credits',2,'200'),meter('usage',2,'-1')])));
  assert.equal(store.state(source).successAt,1);
  assert.equal(store.meters.readings(source,'credits',0,3).length,1);
  store.close();
});

test('a sparse heartbeat reserves the WAL writer before reading its span',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'quotum-meter-wal-')),file=path.join(dir,'db.sqlite');
  const store=new Store(file,1),peer=new Store(file,1);
  peer.db.exec('PRAGMA busy_timeout=0');
  const source=store.source('openrouter','1'.repeat(24),1);
  store.record(source,measure(1,[meter('credits',1,'100'),meter('usage',1,'1')]));
  const prepare=store.db.prepare.bind(store.db);let attempted=false,peerWrote=false;
  store.db.prepare=(sql:string)=>{
    const statement=prepare(sql);
    if(sql.startsWith('SELECT from_at,to_at,stale_after_ms,hold_until FROM meter_spans')) {
      const get=statement.get.bind(statement);
      statement.get=(...args)=>{
        const result=Reflect.apply(get,statement,args);
        if(!attempted){attempted=true;try{peer.db.prepare('INSERT INTO meta VALUES (?,?)').run('concurrent-write','peer');peerWrote=true;}catch{/* The first connection must already hold the writer. */}}
        return result;
      };
    }
    return statement;
  };
  try {
    store.record(source,measure(60_001,[meter('credits',60_001,'100'),meter('usage',60_001,'1')]));
    assert.equal(attempted,true);assert.equal(peerWrote,false);assert.equal(store.state(source).successAt,60_001);
    assert.equal(store.meters.readings(source,'usage',0,100_000).length,1);
  }finally{store.close();peer.close();rmSync(dir,{recursive:true});}
});
