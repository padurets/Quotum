import {test} from 'node:test';
import assert from 'node:assert/strict';
import {follow,followPan, HistoryStore} from '../lib/history';
import {HistoryPool} from '../lib/historyPool';
import {Pan} from '../lib/pan';
import {covered} from '../lib/historyPlot';
import {HistoryTile} from '../lib/historyTiles';
import {Preparations} from '../lib/prepare';
import {ApiError} from '../lib/http';
import {composeMeters,type MeterSelection} from '../../server/domain/meterHistory';
import {CLOCK_TOLERANCE_MS, READ_CELLS, cellOf, cellStart, compose, targetOf, tileEnd, tileOf, tileStart, type Chunk, type HistoryAnswer, type HistoryBasis} from '../../server/domain/history';
import {createStore} from '../lib/store';
import {INITIAL,reduce,type Snapshot} from '../lib/board';
import {prefs,setPrefs} from '../lib/prefs';
import {DEFAULT_MONEY} from '../lib/moneySelection';
import {EMPTY_VIEW} from '../../server/domain/view';
import {QUOTA_IDS} from '../../server/domain/meters';

const M = 60_000;
const H = 60 * M;
const NOW = Date.parse('2026-09-26T12:23:00Z');
const flush = async () => {for (let i = 0; i < 5; i++) await Promise.resolve();};
const empty = (from: number, to: number): Chunk => ({from, to, series: [], activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []});
const pending = (h: ReturnType<typeof harness>) => h.reads.filter(r => !r.settled && !r.signal?.aborted);
function harness(budget?: number, preparations?: Preparations, scope?: 'quota'|'budget', pool?: HistoryPool) {
  let now = NOW;
  let elapsed = 0;
  let dropped = 0;
  const timers = new Map<unknown, {at: number; run: () => void}>();
  const reads: {board: string; cell: number; from: number; to: number; signal?: AbortSignal; meters?:MeterSelection; metadata?: HistoryBasis; settled: boolean; answer(patch?: Partial<HistoryAnswer>): Promise<void>; fail(error: unknown): Promise<void>}[] = [];
  const store = new HistoryStore({
    now: () => now,
    preparations,
    elapsedNow: () => elapsed,
    read: (board, cell, from, to, signal, meters, metadata) => new Promise((resolve, reject) => reads.push({board, cell, from, to, signal, meters, metadata, settled: false,
      async answer(patch = {}) {
        this.settled = true;
        const end = Math.min(to, cellStart((patch.now ?? now) + CLOCK_TOLERANCE_MS, cell) + cell);
        const chunks: Chunk[] = [];
        for (let a = from; a < end;) {const b = Math.min(end, tileEnd(tileOf(a, cell), cell)); chunks.push(empty(a, b)); a = b;}
        resolve({run: 'run', now, historyStart: 0, known: {work: 0, sources: {s: 0}}, chunks, ...patch});
        await flush();
      },
      async fail(error) {this.settled = true; reject(error); await flush();},
    })),
    setTimeout: (run, ms) => {const id = {}; timers.set(id, {at: now + ms, run}); return id;},
    clearTimeout: id => {timers.delete(id);},
    dropTimeRange: () => {dropped++;},
  }, budget, scope, pool);
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      elapsed += next[1].at - now; now = next[1].at; timers.delete(next[0]); next[1].run(); await flush();
    }
    elapsed += end - now; now = end;
  };
  const start = async () => {store.open('b'); store.hello('run'); store.snapshot(['s'], ['s w']); await flush();};
  return {store, reads, advance, start, now: () => now, dropped: () => dropped, timers, correctClock: (ms: number) => {now += ms;}};
}

test('settings retain live invalidations without reading history until the dashboard returns', async () => {
  const h = harness();
  h.store.setActive(false);
  await h.start();
  h.store.news(NOW - H);
  h.store.choose('7d', null);
  await flush();
  assert.equal(h.reads.length, 0);

  h.store.setActive(true);
  await flush();
  assert.equal(h.reads.length, 1);
  await h.reads[0].answer();
  assert.equal(h.store.get().history?.range, '7d');

  h.store.setActive(false);
  h.store.news(NOW - H);
  await flush();
  assert.equal(h.reads.length, 1, 'live news does not load unmounted charts');
  h.store.setActive(true);
  await flush();
  assert.equal(h.reads.length, 2, 'returning catches up with the retained invalidation');
  h.store.close();
});

test('leaving the dashboard aborts its history read and a later board cannot receive that answer', async () => {
  const h = harness();
  await h.start();
  const old = h.reads[0];
  h.store.setActive(false);
  assert.equal(old.signal?.aborted, true);
  h.store.open('other');
  h.store.hello('run');
  h.store.snapshot(['s'], ['s w']);
  await old.answer();
  assert.equal(h.store.get().history, null);
  assert.equal(h.reads.length, 1);

  h.store.setActive(true);
  await flush();
  assert.equal(h.reads.length, 2);
  assert.equal(h.reads[1].board, 'other');
  await h.reads[1].answer();
  assert.equal(h.store.get().history?.board, 'other');
  h.store.close();
});

test('the ordinary history follower loads subscription caps once with native windows and keeps period switches cached',async()=>{
  const before=prefs(),h=harness(),page=createStore(reduce,INITIAL),stop=follow(h.store,page);
  setPrefs({money:DEFAULT_MONEY,kind:'weekly'});
  const base={plan:'',resets:null,owners:[],error:null,successAt:NOW,stale:false,staleAfterMs:10*M,measureIntervalMs:null};
  const snapshot:Snapshot={board:{id:'b',name:'',personal:true},view:EMPTY_VIEW,historyStart:0,
    sources:[{...base,id:'s',provider:'codex',windows:[{id:'w',kind:'weekly',label:null,used:20,remaining:80,resetAt:null,minutes:10080}]},{...base,id:'zai:fixture',provider:'zai',windows:[]}],sessions:{},cadence:{},refresh:{},forecast:{},mine:[],boards:[],resets:{resets:{},trackers:[],past:{}}};
  try {
    page.dispatch({type:'board-open',id:'b'});
    page.dispatch({type:'hub',event:{type:'hello',data:{epoch:'run'}}});
    page.dispatch({type:'hub',event:{type:'snapshot',data:snapshot}});await flush();
    assert.equal(h.reads.length,1);
    assert.deepEqual(h.reads[0].meters,{unit:'credits:zai',ids:QUOTA_IDS.map(id=>['zai:fixture',id])});
    const read=h.reads[0],chunks:Chunk[]=[];
    for(let from=read.from;from<read.to;){const to=Math.min(read.to,tileEnd(tileOf(from,read.cell),read.cell));
      chunks.push({...empty(from,to),series:[{source:'s',window:'w',hold:10*M,open:80,cells:[[0,80,0,0]]}],meterSeries:QUOTA_IDS.map(meter=>({source:'zai:fixture',meter,kind:'cap',unit:'credits:zai',semantics:{limit:'2000000000',resetAt:null,scope:'five_hour',minutes:300,label:null},cells:[[0,'1200000000','0','0',0,{knownFrom:from,knownUntil:from+read.cell}]]}))});from=to;
    }
    await read.answer({chunks,known:{work:0,sources:{s:0,'zai:fixture':0}}});
    assert.equal(h.store.get().history?.series.length,1);assert.equal(h.store.get().history?.meterSeries?.length,2);
    const count=h.reads.length,answer=h.store.get().history;
    setPrefs({kind:'session'});page.dispatch({type:'hub',event:{type:'card',data:{...snapshot.sources[1],successAt:NOW+100}}});await flush();
    assert.equal(h.reads.length,count);assert.equal(h.store.get().history,answer,'a card heartbeat and period switch retain the complete answer');
    page.dispatch({type:'hub',event:{type:'history',data:{sources:['zai:fixture'],since:NOW}}});await flush();
    assert.equal(h.reads.length,count+1);assert.ok(h.reads.at(-1)!.to-h.reads.at(-1)!.from<=2*read.cell,'an accepted quota event reads only the tail');
    assert.deepEqual(h.reads.at(-1)!.meters,read.meters);
    await h.reads.at(-1)!.answer();
    page.dispatch({type:'hub',event:{type:'view',data:{view:{...EMPTY_VIEW,windows:[`zai:fixture/${QUOTA_IDS[0]}`]}}}});await flush();
    assert.deepEqual(h.reads.at(-1)!.meters?.ids,[['zai:fixture',QUOTA_IDS[1]]]);
  }finally{stop();h.store.close();setPrefs(before);}
});

test('each history flight captures metadata without crossing boards or hub restarts', async () => {
  const h = harness(); await h.start();
  assert.equal(h.reads[0].metadata, undefined);
  await h.reads[0].answer({meta: 'first'});
  h.store.news(NOW); await flush();
  const prior = h.reads.at(-1)!;
  assert.equal(prior.metadata?.meta, 'first'); assert.equal(prior.metadata?.run, 'run');
  h.store.hello('restarted'); h.store.snapshot(['s'], ['s w']); await flush();
  const restarted = h.reads.at(-1)!;
  assert.equal(restarted.metadata, undefined, 'the old receipt cannot be relabelled with a new run');
  await restarted.answer({run: 'restarted', meta: 'second'});
  h.store.news(NOW); await flush();
  assert.equal(h.reads.at(-1)!.metadata?.meta, 'second');
  h.store.open('other'); h.store.hello('other-run'); h.store.snapshot(['s'], ['s w']); await flush();
  assert.equal(h.reads.at(-1)!.board, 'other'); assert.equal(h.reads.at(-1)!.metadata, undefined);
  await prior.answer({meta: 'late'});
  assert.equal(prior.metadata?.meta, 'first', 'the old flight keeps its captured basis');
  assert.equal(h.store.get().history, null, 'a late reply cannot restore the previous board');
  h.store.close();
});

test('a monetary pan exposes newly read points while keeping the complete table answer',async()=>{
  const h=harness();h.store.setMeters({unit:'USD',ids:[['s','balance']]});await h.start();
  const answer=async(read:typeof h.reads[number])=>{
    const chunks:Chunk[]=[];
    for(let from=read.from;from<read.to;){const to=Math.min(read.to,tileEnd(tileOf(from,read.cell),read.cell));
      chunks.push({...empty(from,to),meterSeries:[{source:'s',meter:'balance',kind:'balance',unit:'USD',semantics:null,cells:Array.from({length:(to-from)/read.cell},(_,i)=>[i,'9007199254740993','0','0',read.cell])}]});from=to;}
    await read.answer({chunks});
  };
  await answer(h.reads[0]);const complete=h.store.get().history;
  const range={from:NOW-48*H,to:NOW-24*H};h.store.pan({token:1,length:24*H,...range,direction:-1});await flush();
  for(let i=0;i<20&&pending(h).length;i++)for(const read of [...pending(h)])await answer(read);
  const plot=h.store.getPlot()!;
  const series=composeMeters(plot.meterChunks!,plot.cell,plot.from,plot.to,plot.meterFrame);
  assert.ok(series[0].points.some(point=>point.at>=range.from&&point.at<range.to));
  assert.equal(series[0].end,'9007199254740993');
  assert.equal(h.store.get().history,complete);
  const chunks=plot.meterChunks,reads=h.reads.length;
  h.store.pan({token:1,length:24*H,from:range.from+plot.cell,to:range.to+plot.cell,direction:0});await flush();
  assert.equal(h.store.getPlot()!.meterChunks,chunks,'cached movement does not rebuild the drawing strip');
  assert.equal(h.store.getPlot()!.meterFrame!.from,Math.floor((range.from+plot.cell)/plot.cell)*plot.cell);
  assert.equal(h.reads.length,reads);
  h.store.choose('24h',range);h.store.endPan(true);await flush();
  assert.notEqual(h.store.get().history,complete);h.store.close();
});

test('separately bounded monetary responses cannot publish an over-budget assembled frame',async()=>{
  const budget=50000,h=harness(budget);h.store.setMeters({unit:'USD',ids:[['s','balance']]});h.store.choose('30d',null);await h.start();
  const sizes:number[]=[];
  for(let i=0;i<30&&!h.store.get().error;i++) {
    const read=pending(h)[0];assert.ok(read);
    const to=Math.min(read.to,tileEnd(tileOf(read.from,read.cell),read.cell));
    const chunk:Chunk={...empty(read.from,to),meterSeries:[{source:'s',meter:'balance',kind:'balance',unit:'USD',semantics:null,cells:Array.from({length:(to-read.from)/read.cell},(_,i)=>[i,'1','0','0',read.cell])}]};
    sizes.push(JSON.stringify(chunk).length);await read.answer({chunks:[chunk]});
  }
  assert.ok(sizes.length>1&&Math.max(...sizes)<budget);
  assert.equal(h.store.get().error,'history_limit');assert.equal(h.store.get().history,null);
  assert.equal(h.store.getPlot(),null);assert.equal(h.store.estimatedBytes,0);
  assert.equal(pending(h).length,0);h.store.close();
});

test('entering pan normalizes pending navigation to two roles and serialized tile writes', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  for (const hours of [12, 13, 14]) {
    h.store.choose('24h', {from: h.now() - (24 + hours) * H, to: h.now() - hours * H});
    await flush(); await h.advance(400);
  }
  const inherited = pending(h);
  assert.equal(inherited.length, 3, 'ordinary navigation has three delayed targets');
  const range = {from: h.now() - 38 * H, to: h.now() - 14 * H};
  h.store.pan({token: 1, length: 24 * H, ...range, direction: -1}); await flush();
  const flights = pending(h);
  assert.ok(flights.length <= 2);
  assert.ok(inherited.some(r => r.signal?.aborted));
  const [a, b] = flights;
  if (b) assert.ok(tileOf(a.to - 1, a.cell) < tileOf(b.from, b.cell) || tileOf(b.to - 1, b.cell) < tileOf(a.from, a.cell));
  for (const r of inherited) if (r.signal?.aborted) await r.answer();
  h.store.choose('24h', range); h.store.endPan(true); await flush();
  for (let i = 0; i < 20 && pending(h).length; i++) for (const r of [...pending(h)]) await r.answer();
  assert.equal(h.store.get().history?.range, `${range.from}-${range.to}`);
  h.store.close();
});

test('a failed foreground batch keeps its retry until the required cells succeed', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  h.store.pan({token: 1, length: 24 * H, from: NOW - 36 * H, to: NOW - 12 * H, direction: -1}); await flush();
  const [visible] = pending(h);
  await visible.fail(new Error('offline'));
  assert.equal(h.timers.size, 1);
  await flush();
  assert.equal(h.timers.size, 1, 'a pump cannot clear this retry while cells remain missing');
  assert.ok(pending(h).every(r => r.from !== visible.from));
  await h.advance(14_999);
  assert.ok(pending(h).every(r => r.from !== visible.from));
  await h.advance(1);
  assert.ok(pending(h).some(r => r.from === visible.from), 'the foreground resumes at its timeout');
  h.store.close();
});

test('an expired committed pan range drops after a required batch returns 400', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const range = {from: NOW - 90 * 24 * H + H, to: NOW - 89 * 24 * H + H};
  h.store.pan({token: 1, length: 24 * H, ...range, direction: 0}); await flush();
  h.store.choose('24h', range); h.store.endPan(true); await flush();
  await h.advance(6 * H);
  const inherited = pending(h)[0];
  await inherited.fail(new ApiError(400, 'invalid_request'));
  const current = pending(h)[0];
  assert.ok(tileOf(current.to - 1, current.cell) - tileOf(current.from, current.cell) < 8);
  await current.fail(new ApiError(400, 'invalid_request'));
  assert.equal(h.dropped(), 1);
  assert.equal(h.timers.size, 0);
  h.store.close();
});

test('memory pressure stops speculative reads without new input and retains visible coverage', async () => {
  for (const budget of [90_000, 100_000, 120_000]) {
    const h = harness(budget); await h.start();
    const answer = async (r: typeof h.reads[number]) => {
      const chunks: Chunk[] = [];
      const end = Math.min(r.to, cellStart(h.now() + CLOCK_TOLERANCE_MS, r.cell) + r.cell);
      for (let from = r.from; from < end;) {
        const to = Math.min(end, tileEnd(tileOf(from, r.cell), r.cell));
        const chunk = empty(from, to);
        const count = (to - from) / r.cell;
        chunk.series = [{source: 's', window: 'w', hold: 2 * r.cell, open: 80, cells: Array.from({length: count}, (_, i) => [i, 80 - i % 20, .25, r.cell, {o: 80, h: r.cell, w: [.25, .4 * r.cell, .125]}])}];
        chunk.activity = {sessions: [['r1', 's', 'P', 'd'], ['r2', 's', 'P', 'd']], devices: {d: 'Device'}, cells: Array.from({length: count}, (_, i) => [i, .4 * r.cell, [[0, .3 * r.cell], [1, .3 * r.cell]], [['s', 's', .4 * r.cell], ['p', JSON.stringify('P'), .4 * r.cell], ['d', 'd', .4 * r.cell]]])};
        chunks.push(chunk); from = to;
      }
      await r.answer({chunks});
    };
    await answer(h.reads[0]);
    const range = {from: NOW - 36 * H, to: NOW - 12 * H};
    h.store.pan({token: 1, length: 24 * H, ...range, direction: -1}); await flush();
    for (let i = 0; i < 30 && pending(h).length; i++) for (const r of [...pending(h)]) await answer(r);
    assert.equal(pending(h).length, 0, `speculation settles at budget ${budget}`);
    assert.ok(h.store.estimatedBytes <= budget);
    const plot = h.store.getPlot()!;
    assert.ok(covered(plot.coverage, cellStart(range.from, plot.cell), Math.ceil(range.to / plot.cell) * plot.cell));
    const count = h.reads.length;
    await h.advance(60_000);
    assert.equal(h.reads.length, count, 'holding the frame makes no further reads');
    h.store.news(range.from); await flush();
    assert.ok(h.reads.length > count, 'new relevant data can resume the foreground');
    h.store.close();
  }
});

test('the production gesture subscription reads the forward edge of a selected past range', async () => {
  const h = harness();
  let selected = {from: NOW - 72 * H, to: NOW - 48 * H};
  h.store.choose('24h', selected); await h.start(); await h.reads[0].answer();
  const frames: (() => void)[] = [];
  const gesture = new Pan({now: h.now, commit: range => {selected = range!; h.store.choose('24h', range);}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const source = Symbol('chart');
  gesture.register(source, () => ({end: selected.to, future: 0}));
  const unsubscribe = followPan(h.store, gesture, () => selected);
  const token = gesture.begin({source, input: 'pointer', selected, length: 24 * H, now: NOW, historyStart: 0, span: 24 * H, width: 1000})!;
  gesture.move(token, 1500); frames.shift()!(); await flush();
  for (let i = 0; i < 20 && pending(h).length; i++) for (const r of [...pending(h)]) await r.answer();
  const draft = gesture.get()!, plot = h.store.getPlot()!;
  assert.equal(draft.to, NOW - 12 * H);
  assert.ok(plot.to >= draft.to);
  assert.ok(covered(plot.coverage, cellStart(draft.from, plot.cell), Math.ceil(draft.to / plot.cell) * plot.cell));
  gesture.finish(token); await flush();
  assert.equal(h.store.get().history?.range, `${draft.from}-${draft.to}`);
  unsubscribe(); h.store.close();
});

test('pan publishes partial coverage without changing totals, with at most two disjoint tile flights', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const answered = h.store.get().history;
  h.store.pan({token: 1, length: 24 * H, from: NOW - 36 * H, to: NOW - 12 * H, direction: -1});
  await flush();
  assert.equal(h.store.get().history, answered);
  assert.equal(h.store.get().loading, false);
  assert.ok(h.store.getPlot()!.coverage.length);
  assert.ok(pending(h).length <= 2);
  const [a, b] = pending(h);
  assert.ok(a, 'visible head is requested');
  if (b) assert.ok(tileOf(a.to - 1, a.cell) < tileOf(b.from, b.cell) || tileOf(b.to - 1, b.cell) < tileOf(a.from, a.cell));
  for (const r of pending(h)) assert.ok(tileOf(r.to - 1, r.cell) - tileOf(r.from, r.cell) + 1 <= 8);
  for (let i = 0; i < 100; i++) h.store.pan({token: 1, length: 24 * H, from: NOW - 36 * H - i, to: NOW - 12 * H - i, direction: -1});
  await flush();
  assert.ok(pending(h).length <= 2);
  assert.equal(h.store.get().history, answered);
  h.store.endPan(false);
  await flush();
  assert.equal(h.store.getPlot(), null);
});

test('pan prioritizes the latest visible cells, aborts abandoned interests and ignores their errors', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  h.store.pan({token: 1, length: 24 * H, from: NOW - 48 * H, to: NOW - 24 * H, direction: -1}); await flush();
  const old = pending(h);
  h.store.pan({token: 1, length: 24 * H, from: NOW - 10 * H, to: NOW, direction: 1}); await flush();
  assert.ok(old.some(r => r.signal?.aborted));
  for (const r of old) if (r.signal?.aborted) await r.fail(new ApiError(400, 'invalid_request'));
  assert.equal(h.dropped(), 0);
  assert.equal(h.timers.size, 0);
  assert.ok(pending(h).length <= 2);
  h.store.endPan(false);
});

test('a fully cached gesture starts no speculative read, including after a quiet pause', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const count = h.reads.length;
  h.store.pan({token: 1, length: 24 * H, from: NOW - 24 * H, to: NOW, direction: -1}); await flush();
  await h.advance(60_000);
  assert.equal(h.reads.length, count);
  h.store.endPan(false); await flush();
  assert.equal(h.reads.length, count);
  h.store.close();
});

test('stopping a cold pan keeps its old exact answer until all final cells arrive', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const old = h.store.get().history;
  const range = {from: NOW - 36 * H, to: NOW - 12 * H};
  h.store.pan({token: 1, length: 24 * H, ...range, direction: -1}); await flush();
  h.store.choose('24h', range);
  h.store.endPan(true); await flush();
  assert.equal(h.store.get().history, old);
  assert.equal(h.store.get().loading, false);
  for (let i = 0; i < 8 && pending(h).length; i++) for (const read of [...pending(h)]) await read.answer();
  assert.equal(h.store.get().history!.range, `${range.from}-${range.to}`);
  assert.equal(h.store.getPlot(), null);
  const count = h.reads.length;
  await h.advance(60_000);
  assert.equal(h.reads.length, count);
});

test('visible plus ahead exceeding eight tiles is batched without concurrent same-tile writes', async () => {
  const h = harness(); h.store.choose('30d', null); await h.start(); await h.reads[0].answer();
  h.store.pan({token: 1, length: 30 * 24 * H, from: NOW - 60 * 24 * H, to: NOW - 30 * 24 * H, direction: -1}); await flush();
  for (let i = 0; i < 12 && pending(h).length; i++) {
    const flights = [...pending(h)];
    assert.ok(flights.length <= 2);
    for (const r of flights) assert.ok(tileOf(r.to - 1, r.cell) - tileOf(r.from, r.cell) + 1 <= 8);
    if (flights.length === 2) {
      const [a, b] = flights;
      assert.ok(tileOf(a.to - 1, a.cell) < tileOf(b.from, b.cell) || tileOf(b.to - 1, b.cell) < tileOf(a.from, a.cell));
    }
    for (const r of flights.reverse()) await r.answer();
  }
  assert.equal(pending(h).length, 0);
  h.store.endPan(false);
});

test('the first snapshot reads once from the frame cell; news reads only the tail, without dimming', async () => {
  const h = harness();
  h.store.open('b'); h.store.hello('run'); await flush();
  assert.equal(h.reads.length, 0);
  h.store.snapshot(['s'], ['s w']); await flush();
  assert.equal(h.reads.length, 1);
  const first = h.reads[0];
  assert.equal(first.from, cellStart(NOW - 24 * H, first.cell));
  await first.answer();
  assert.equal(h.store.get().history?.range, '24h');
  h.store.news(NOW); await flush();
  assert.equal(h.reads.length, 2);
  assert.equal(h.reads[1].from, cellStart(NOW, first.cell));
  assert.equal(h.store.get().loading, false);
  await h.reads[1].answer();
  await h.advance(3000);
  h.store.news(h.now()); await flush();
  assert.equal(h.reads.length, 3, 'no ten-second limit');
  await h.reads[2].answer();
  await h.advance(H);
  assert.equal(h.reads.length, 3, 'time alone reads nothing');
});

test('news during a flight gives exactly one next read; continuous news never delays showing the answers', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  for (let n = 1; n < 5; n++) {
    h.store.news(h.now()); await flush();
    const previous = h.store.get().history;
    h.store.news(h.now()); h.store.news(h.now()); await flush();
    assert.equal(h.reads.length, n + 1);
    await h.reads[n].answer();
    assert.notEqual(h.store.get().history, previous);
    assert.equal(h.store.get().loading, false);
    assert.equal(h.reads.length, n + 2);
  }
  await h.reads.at(-1)!.answer();
  const count = h.reads.length;
  await flush(); assert.equal(h.reads.length, count);
});

test('lineup and since zero in one network chunk read once; reconnect keeps the shown frame undimmed', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const shown = h.store.get().history;
  h.store.lineup(['s', 'other']); h.store.news(0); await flush();
  assert.equal(h.reads.length, 2);
  assert.equal(h.store.get().history, shown);
  assert.equal(h.store.get().loading, false);
  await h.reads[1].answer();
  h.store.snapshot(['s', 'other']); await flush();
  assert.equal(h.reads.length, 3);
});

test('news after a past frame asks nothing; late news inside it reads from its old valid boundary', async () => {
  const h = harness();
  const range = {from: NOW - 4 * H, to: NOW - 3 * H};
  h.store.choose('24h', range); await h.start(); await h.reads[0].answer();
  h.store.news(NOW); await flush(); assert.equal(h.reads.length, 1);
  h.store.news(range.from + 10 * M); await flush(); assert.equal(h.reads.length, 2);
  assert.equal(h.reads[1].from, cellStart(range.from + 10 * M, M));
});

test('12h and 24h and seen steps share cells, even after a new cell begins without news', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  h.store.choose('12h', null); await flush(); assert.equal(h.reads.length, 1);
  assert.equal(h.store.get().history?.range, '12h');
  await h.advance(5 * M);
  h.store.choose('24h', null); await flush();
  assert.equal(h.reads.length, 1);
  const range = {from: h.now() - 36 * H, to: h.now() - 12 * H};
  await h.advance(1000); h.store.choose('24h', range); await flush();
  assert.equal(h.reads.length, 2);
  assert.equal(h.store.get().loading, true);
  await h.reads[1].answer();
  await h.advance(1000); h.store.choose('24h', null); await flush();
  assert.equal(h.reads.length, 2);
  await h.advance(1000); h.store.choose('24h', range); await flush();
  assert.equal(h.reads.length, 2);
});

test('a cached grid touched while another is shown displays immediately and refreshes once', async () => {
  const h = harness(); h.store.choose('7d', null); await h.start(); await h.reads[0].answer();
  await h.advance(1000); h.store.choose('24h', null); await flush(); await h.reads[1].answer();
  h.store.news(NOW); await flush(); await h.reads[2].answer();
  await h.advance(1000); h.store.choose('7d', null); await flush();
  assert.equal(h.store.get().history?.range, '7d');
  assert.equal(h.store.get().loading, false);
  assert.equal(h.reads.length, 4);
  assert.equal(h.reads[3].from, cellStart(NOW, h.reads[3].cell));
});

test('a series of quick changes reads the first and the last, while earlier answers help the new frame', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  h.store.choose('24h', {from: NOW - 36 * H, to: NOW - 12 * H}); await flush();
  h.store.choose('24h', {from: NOW - 40 * H, to: NOW - 16 * H}); await flush();
  h.store.choose('24h', {from: NOW - 48 * H, to: NOW - 24 * H}); await flush();
  assert.equal(h.reads.length, 2);
  await h.reads[1].answer();
  await h.advance(300); assert.equal(h.reads.length, 3);
  await h.reads[2].answer();
  assert.equal(h.store.get().history?.range, `${NOW - 48 * H}-${NOW - 24 * H}`);
});

test('answers of an old epoch or run are discarded, including their errors and before a new hello', async () => {
  const h = harness(); await h.start();
  h.store.snapshot(['s']); await flush();
  await h.reads[0].answer(); assert.equal(h.store.get().history, null);
  await h.reads[1].answer({run: 'next'}); assert.equal(h.store.get().history, null);
  assert.equal(h.reads.length, 2, 'a foreign run cannot start a request loop');
  h.store.hello('next'); h.store.snapshot(['s']); await flush();
  assert.equal(h.reads.length, 3);
  await h.reads[2].answer({run: 'next'}); assert.ok(h.store.get().history);
  h.store.news(0); await flush();
  h.store.hello('third'); await h.reads[3].fail(new ApiError(400, 'invalid_request'));
  assert.equal(h.dropped(), 0); assert.equal(h.timers.size, 0);
});

test('younger overlapping flights retain their data and boundaries when an older one ends', async () => {
  const h = harness(); await h.start();
  await h.advance(1000); h.store.news(h.reads[0].from); h.store.choose('24h', {from: NOW - 36 * H, to: NOW - 12 * H}); await flush();
  assert.equal(h.reads.length, 2);
  await h.reads[1].answer();
  const shown = h.store.get().history;
  await h.reads[0].answer();
  assert.equal(h.store.get().history?.range, shown?.range);
  assert.equal(h.reads.length, 2);
});

test('failed flights become unread again and retry once; a current invalid range drops its selection', async () => {
  const h = harness(); await h.start(); await h.reads[0].fail(new Error('offline'));
  await h.advance(14_999); assert.equal(h.reads.length, 1);
  await h.advance(1); assert.equal(h.reads.length, 2); await h.reads[1].answer();
  h.store.choose('24h', {from: NOW - 70 * H, to: NOW - 46 * H}); await flush();
  await h.reads[2].fail(new ApiError(400, 'invalid_request')); assert.equal(h.dropped(), 1);
});

test('future ranges and fast page clocks stop at the hub cut; a wholly future range is dropped', async () => {
  const h = harness(); h.store.choose('24h', {from: NOW - H, to: NOW + H}); await h.start();
  await h.reads[0].answer({now: NOW - 5 * M});
  assert.ok(h.store.get().history); assert.equal(h.reads.length, 1);
  await h.advance(1000); h.store.choose('1h', null); await flush(); assert.equal(h.reads.length, 1);
  await h.advance(1000); h.store.choose('1h', {from: NOW + 2 * H, to: NOW + 3 * H}); await flush();
  assert.equal(h.dropped(), 1); assert.equal(h.reads.length, 1);
});

test('a cut is recorded even when the requested end exactly equals the hub cut', async () => {
  const h = harness(); await h.advance(40_000); await h.start();
  await h.reads[0].answer();
  await h.advance(2 * M); h.store.choose('12h', null); await flush();
  assert.equal(h.reads.length, 1);
  h.store.news(h.now()); await flush(); assert.equal(h.reads.length, 2);
});

test('a selection beyond the advancing hub clock drops even below an older coarse-grid cut', async () => {
  for (const offset of [-4 * M, -2 * M]) {
    const h = harness(); await h.start();
    await h.reads[0].answer({now: NOW - 5 * M});
    const shown = h.store.get().history;
    h.store.choose('24h', {from: NOW + offset, to: NOW + offset + 15 * M}); await flush();
    assert.equal(h.dropped(), 1);
    assert.equal(h.reads.length, 1);
    assert.equal(h.store.get().history, shown, 'an invalid selection cannot publish a ready empty frame');
  }
});

test('quiet time admits a selection after an old data cut without another history read', async () => {
  const h = harness(); await h.start();
  await h.reads[0].answer({now: NOW - 5 * M});
  await h.advance(25 * M);
  const selected = {from: NOW + 3 * M, to: NOW + 18 * M};
  h.store.choose('24h', selected); await flush();
  assert.equal(h.dropped(), 0);
  assert.equal(h.reads.length, 1);
  assert.equal(h.store.get().history?.range, `${selected.from}-${selected.to}`);
  assert.equal(h.store.get().loading, false);
});

test('a corrected hub-clock estimate cannot shorten elapsed time and drop a valid selection', async () => {
  const h = harness(); await h.start();
  await h.reads[0].answer({now: NOW - 5 * M});
  h.correctClock(-5 * M);
  await h.advance(25 * M);
  const selected = {from: NOW + 17 * M, to: NOW + 32 * M};
  h.store.choose('24h', selected); await flush();
  assert.equal(h.dropped(), 0);
  assert.equal(h.reads.length, 1);
  assert.equal(h.store.get().history?.range, `${selected.from}-${selected.to}`);
  assert.equal(h.store.get().loading, false);
});

test('the age of a delayed answer counts when admitting a selection across a grid cut', async () => {
  const h = harness(); await h.advance(24_000); await h.start();
  const sent = h.now(); await h.advance(11_000);
  await h.reads[0].answer({now: sent});
  const from = cellStart(sent, M) + M;
  h.store.choose('24h', {from, to: from + 15 * M}); await flush();
  assert.equal(h.dropped(), 0);
  assert.equal(h.reads.length, 2, 'the valid finer-grid selection reads its missing cells');
});

test('window metadata changes recompose without reading, and only after a fresh epoch is full', async () => {
  const h = harness(); await h.start();
  const r = h.reads[0];
  const chunk = empty(r.from, Math.min(r.to, cellStart(NOW + CLOCK_TOLERANCE_MS, r.cell) + r.cell));
  chunk.series = [{source: 's', window: 'w', hold: 300_000, open: null, cells: [[0, 80, 0, 0]]}, {source: 's', window: 'other', hold: 300_000, open: null, cells: [[0, 60, 0, 0]]}];
  // The first point may precede the frame, so use a frame cell inside this chunk.
  const i = Math.ceil((NOW - 24 * H - r.from) / r.cell);
  chunk.series.forEach(s => s.cells[0][0] = i);
  const chunks: Chunk[] = [];
  for (let at = r.from; at < chunk.to;) {const end = Math.min(chunk.to, tileEnd(tileOf(at, r.cell), r.cell)); chunks.push(empty(at, end)); at = end;}
  chunks[0].series = chunk.series;
  await r.answer({chunks});
  assert.equal(h.store.get().history?.series.length, 1);
  const before = h.store.get().history;
  h.store.setWindows(['s other']); await flush();
  assert.equal(h.reads.length, 1); assert.notEqual(h.store.get().history, before);
  assert.equal(h.store.get().history?.series[0].windowId, 'other');
  const shown = h.store.get().history;
  h.store.snapshot(['s']); h.store.setWindows(['s w']); await flush();
  assert.equal(h.store.get().history, shown);
  await h.reads[1].answer(); assert.equal(h.store.get().history?.series.length, 0);
});

test('eviction is bounded and never drops the frame on screen; getting state does not rebuild it', async () => {
  const h = harness(12_000); await h.start(); await h.reads[0].answer();
  assert.equal(h.store.get().history, h.store.get().history);
  await h.advance(1000); h.store.choose('7d', null); await flush(); await h.reads[1].answer();
  assert.ok(h.store.estimatedBytes <= 12_000);
  h.store.setWindows(['s other']); await flush(); assert.equal(h.reads.length, 2);
  h.store.close(); assert.equal(h.store.estimatedBytes, 0); assert.equal(h.store.get().history, null);
});

test('window sets cannot alias a window whose id contains the set separator', async () => {
  const h = harness();
  const from = tileStart(tileOf(NOW - 2 * H, M), M);
  h.store.choose('1h', {from, to: from + H});
  await h.start();
  h.store.setWindows(['s other\ns w']);
  const chunk = empty(from, from + H);
  chunk.series = ['other\ns w', 'other', 'w'].map(window => ({source: 's', window, hold: 300_000, open: null, cells: [[0, 80, 0, 0]]}));
  await h.reads[0].answer({chunks: [chunk]});
  assert.equal(h.store.get().history?.series.length, 1);
  h.store.setWindows(['s other', 's w']);
  await flush();
  assert.equal(h.store.get().history?.series.length, 2);
  assert.equal(h.reads.length, 1);
});

test('a coarser grid cannot forget the empty suffix of a previously seen finer grid', async () => {
  const h = harness();
  await h.start();
  await h.reads[0].answer();
  h.store.choose('7d', null);
  await flush();
  await h.reads[1].answer();
  await h.advance(5 * M);
  h.store.choose('24h', null);
  await flush();
  assert.equal(h.store.get().history?.range, '24h');
  assert.equal(h.reads.length, 2, 'no data arrived beyond the finer grid cut');
  h.store.news(h.now());
  await flush();
  assert.equal(h.reads.length, 3, 'news alone revokes the empty suffix');
});

test('news beyond an old cut is read after the flight, including an accepted fast-clock sample', async () => {
  const h = harness();
  await h.advance(89_000); await h.start();
  const served = h.now(), old = h.reads[0];
  await h.advance(3000);
  const sampleAt = h.now() + 29_000;
  assert.ok(sampleAt <= h.now() + CLOCK_TOLERANCE_MS);
  h.store.news(sampleAt); h.store.news(sampleAt); await flush();
  assert.equal(h.reads.length, 1, 'news coalesces behind the pending flight');
  await old.answer({now: served});
  assert.equal(h.reads.length, 2, 'the stale response cannot prove the sample cell empty');
  const fresh = h.reads[1], at = cellStart(sampleAt, fresh.cell);
  const chunks: Chunk[] = [];
  const end = cellStart(h.now() + CLOCK_TOLERANCE_MS, fresh.cell) + fresh.cell;
  for (let from = fresh.from; from < end;) {
    const to = Math.min(end, tileEnd(tileOf(from, fresh.cell), fresh.cell));
    const chunk = empty(from, to);
    if (from <= at && to > at) chunk.series = [{source: 's', window: 'w', hold: 300_000, open: null, cells: [[(at - from) / fresh.cell, 73, 0, 0]]}];
    chunks.push(chunk); from = to;
  }
  await fresh.answer({chunks});
  assert.ok(h.store.get().history?.series[0].points.some(([t, low]) => t === at && low === 73));
  assert.equal(h.timers.size, 0);
  assert.equal(h.reads.length, 2);
});

test('continuous news with the page clock ahead coalesces and eventually records a fresh hub cut', async () => {
  const h = harness(); await h.start();
  const served = NOW - 5 * M;
  for (let n = 0; n < 4; n++) {
    h.store.news(served); h.store.news(served); await flush();
    assert.equal(h.reads.length, n + 1, 'one pending read per target');
    await h.reads[n].answer({now: served});
    assert.equal(h.reads.length, n + 2, 'one follow-up for accumulated news');
  }
  await h.reads.at(-1)!.answer({now: served});
  assert.equal(h.reads.length, 5);
  assert.equal(h.timers.size, 0);
  assert.equal(h.store.get().history?.range, '24h');
});

test('a 400 from a wider old range cannot drop a nested valid selection', async () => {
  const h = harness(), day = 24 * H;
  h.store.choose('24h', {from: NOW - 90 * day - 6 * H, to: NOW - 89 * day - 6 * H});
  await h.start();
  await h.advance(1000);
  const selected = {from: NOW - 90 * day + H, to: NOW - 90 * day + 13 * H};
  h.store.choose('12h', selected); await flush();
  assert.equal(h.reads.length, 1, 'the old read temporarily covers the new range');
  await h.reads[0].fail(new ApiError(400, 'invalid_request'));
  assert.equal(h.dropped(), 0);
  assert.equal(h.reads.length, 2, 'failed coverage is read for the new selection');
  await h.reads[1].answer();
  assert.equal(h.store.get().history?.range, `${selected.from}-${selected.to}`);
  assert.equal(h.timers.size, 0);
});

test('an abandoned flight failure cannot delay current history news after the new period succeeds', async () => {
  const h = harness(); await h.start();
  await h.advance(1000); h.store.choose('7d', null); await flush();
  assert.equal(h.reads.length, 2, 'another target does not wait for the pending flight');
  await h.reads[0].fail(new Error('old read failed'));
  await h.reads[1].answer();
  assert.equal(h.store.get().history?.range, '7d');
  assert.equal(h.timers.size, 0);
  await h.advance(1000); h.store.news(h.now()); await flush();
  assert.equal(h.reads.length, 3);
});

test('choosing another target clears a retry belonging to the previous target', async () => {
  const h = harness(); await h.start(); await h.reads[0].fail(new Error('offline'));
  assert.equal(h.timers.size, 1);
  h.store.choose('7d', null); await flush();
  assert.equal(h.timers.size, 0);
  assert.equal(h.reads.length, 2);
});

test('an unseen head is filled once on navigation and later frames reuse the whole tile', async () => {
  const h = harness(); h.store.choose('1h', null); await h.start();
  assert.equal(h.reads[0].from, NOW - H);
  await h.reads[0].answer();
  const selected = {from: NOW - H - 18 * M, to: NOW - 18 * M};
  await h.advance(1000); h.store.choose('1h', selected); await flush();
  assert.equal(h.reads.length, 2, 'the omitted head was not marked read');
  assert.equal(h.reads[1].from, tileStart(tileOf(selected.from, M), M));
  assert.equal(h.reads[1].to, tileEnd(tileOf(selected.from, M), M));
  await h.reads[1].answer();
  await h.advance(1000); h.store.choose('1h', null); await flush();
  await h.advance(1000); h.store.choose('1h', selected); await flush();
  assert.equal(h.reads.length, 2);
  assert.equal(h.store.get().loading, false);
});

test('news before the read interval refreshes its suffix without filling an unseen head', async () => {
  const h = harness(); h.store.choose('1h', null); await h.start(); await h.reads[0].answer();
  h.store.news(NOW - H - 10 * M); await flush();
  assert.equal(h.reads[1].from, NOW - H);
  await h.reads[1].answer();
  await h.advance(1000);
  h.store.choose('1h', {from: NOW - H - 18 * M, to: NOW - 18 * M}); await flush();
  assert.equal(h.reads.length, 3, 'refresh did not prove the omitted head known');
});

test('head expansion keeps the stale bridge unread until a follow-up covers it', async () => {
  const h = harness(); h.store.choose('1h', null); await h.start(); await h.reads[0].answer();
  await h.advance(1000);
  h.store.choose('1h', {from: NOW - H - 18 * M, to: NOW - 18 * M}); await flush();
  const since = NOW - H - 11 * M;
  h.store.news(since); h.store.news(since); await flush();
  assert.equal(h.reads.length, 2, 'head news coalesces behind the pending read');
  await h.reads[1].answer();
  assert.equal(h.reads.length, 3);
  assert.equal(h.reads[2].from, since, 'the stale bridge before the old suffix cannot be skipped');
  await h.reads[2].answer();
  assert.equal(h.reads.length, 3);
});

test('a new epoch discards knowledge of a prefetched head and cold-reads only the current frame', async () => {
  const h = harness(); h.store.choose('1h', null); await h.start(); await h.reads[0].answer();
  await h.advance(1000); h.store.choose('1h', {from: NOW - H - 18 * M, to: NOW - 18 * M}); await flush(); await h.reads[1].answer();
  await h.advance(1000); h.store.choose('1h', null); await flush();
  h.store.snapshot(['s'], ['s w']); await flush();
  assert.equal(h.reads[2].from, cellStart(h.now() - H, M));
  await h.reads[2].answer();
  await h.advance(1000); h.store.choose('1h', {from: NOW - H - 18 * M, to: NOW - 18 * M}); await flush();
  assert.equal(h.reads.length, 4, 'old epoch buffers outside the new interval remain unknown');
});

function cooperativeHarness() {
  const tasks: (() => void)[] = []; let clock = 0;
  const preparations = new Preparations({now: () => clock++, post: run => tasks.push(run)});
  const h = harness(undefined, preparations);
  const tick = () => tasks.shift()?.();
  const finish = async () => {for (let i = 0; i < 10_000; i++) {while (tasks.length) tick(); await flush(); if (!tasks.length) return;} throw new Error('preparation did not quiesce');};
  const internals = h.store as unknown as {responses: Map<object, {started: boolean}>; reservations: Map<string, object>; flights: Set<object>; grids: Map<number, Map<number, {readFrom: number; readTo: number; writeSeq: number}>>};
  return {...h, tasks, tick, finish, internals, preparations};
}

test('a sliced whole response publishes no live tile, boundaries or history before its atomic commit', async () => {
  const h = cooperativeHarness(); await h.start();
  await h.reads[0].answer();
  assert.equal(h.internals.responses.size, 1);
  h.tick();
  assert.equal(h.store.get().history, null);
  for (const grid of h.internals.grids.values()) for (const tile of grid.values()) {assert.equal(tile.writeSeq, 0); assert.equal(tile.readFrom, tile.readTo);}
  assert.ok(h.internals.flights.size && h.internals.reservations.size, 'the answer retains its HTTP slot and tile reservations through staging');
  await h.finish();
  assert.equal(h.store.get().history?.range, '24h');
  assert.equal(h.internals.responses.size, 0); assert.equal(h.internals.reservations.size, 0);
  h.store.close();
});

test('nine ordinary HTTP flights admit at most two active or waiting answers and eventually complete the newest target', async () => {
  const h = cooperativeHarness(); await h.start(); await h.reads[0].answer(); await h.finish();
  for (const hours of [48, 72, 96, 120, 144, 168, 192, 216, 240]) {
    h.store.choose('24h', {from: h.now() - (24 + hours) * H, to: h.now() - hours * H});
    await flush(); await h.advance(400);
  }
  const reads = pending(h);
  assert.equal(reads.length, 9, 'ordinary HTTP scheduling retains its previous concurrency');
  const wanted = {from: h.now() - 264 * H - 400, to: h.now() - 240 * H - 400};
  for (const read of reads) {
    await read.answer();
    assert.ok(h.internals.responses.size <= 2, 'raw waiting answers count in the same admission bound');
    assert.ok([...h.internals.responses.values()].filter(response => response.started).length <= 2);
  }
  const chosen = h.store as unknown as {selected: {from: number; to: number}};
  assert.deepEqual(chosen.selected, wanted);
  await h.finish();
  for (let i = 0; i < 10 && pending(h).length; i++) {for (const read of pending(h)) await read.answer(); await h.finish();}
  assert.equal(h.store.get().history?.range, `${wanted.from}-${wanted.to}`);
  assert.equal(h.internals.responses.size, 0); assert.equal(h.internals.reservations.size, 0);
  const count = h.reads.length; await flush(); await h.finish(); assert.equal(h.reads.length, count, 'discard cannot manufacture a speculative fetch loop');
  h.store.close();
});

test('epoch cancellation during staging releases the raw answer and reservations without publishing its tile', async () => {
  const h = cooperativeHarness(); await h.start(); await h.reads[0].answer(); h.tick();
  h.store.hello('new-run');
  assert.equal(h.internals.responses.size, 0); assert.equal(h.internals.reservations.size, 0);
  await h.finish(); assert.equal(h.store.get().history, null);
  for (const grid of h.internals.grids.values()) for (const tile of grid.values()) assert.equal(tile.writeSeq, 0);
  h.store.close();
});

test('a waiting raw answer owns a processing slot and takes the newly committed base of its reserved tile', async () => {
  const h = cooperativeHarness(); await h.start(); await h.reads[0].answer(); await h.finish();
  const wanted = targetOf(24 * H, h.now(), 'test', {from: h.now() - 48 * H, to: h.now() - 24 * H});
  const from = tileStart(tileOf(wanted.k0 * wanted.cell, wanted.cell), wanted.cell), to = from + 60 * wanted.cell;
  const reader = h.store as unknown as {read(target: typeof wanted, from: number, to: number, role: 'visible'): void};
  reader.read(wanted, from, to, 'visible'); reader.read({...wanted, key: 'test-newer'}, from, to, 'visible');
  const [old, next] = pending(h);
  const rich = empty(from, to);
  rich.activity.sessions = Array.from({length: 200}, (_, i) => [`ref${i}`, 's', 'project', 'd']);
  rich.activity.cells = [[0, wanted.cell, Array.from({length: 200}, (_, i) => i), []]];
  await old.answer({chunks: [rich]}); h.tick(); await next.answer({chunks: [rich]});
  assert.equal(h.internals.responses.size, 2);
  assert.equal([...h.internals.responses.values()].filter(response => !response.started).length, 1, 'same-tile staging waits without leaving the two-answer admission bound');
  assert.equal(h.internals.reservations.size, 1);
  await h.finish();
  const tile = h.internals.grids.get(wanted.cell)!.get(tileOf(from, wanted.cell))!;
  assert.equal(tile.writeSeq, 3, 'the younger writer stages from the atomically committed ready entry');
  assert.equal(h.internals.responses.size, 0); assert.equal(h.internals.reservations.size, 0);
  h.store.close();
});

test('replacing a pinned ready entry cancels stale staging even when its sequence and boundaries look unchanged', async () => {
  const h = cooperativeHarness(); await h.start(); await h.reads[0].answer(); h.tick();
  for (const [cell, grid] of h.internals.grids) for (const [key, old] of grid) {
    const next = new HistoryTile(tileStart(key, cell), cell); next.readFrom = old.readFrom; next.readTo = old.readTo; next.writeSeq = old.writeSeq; grid.set(key, next);
  }
  await h.finish();
  assert.equal(h.store.get().history, null);
  assert.equal(h.internals.responses.size, 0); assert.equal(h.internals.reservations.size, 0, 'invalidated ownership must release the waiting answer and reservations');
  assert.ok(pending(h).length, 'required cells become readable again after discard');
  await pending(h)[0].answer(); await h.finish();
  assert.equal(h.store.get().history?.range, '24h');
  h.store.close();
});

test('history news during staging uses the last touched prefix while metadata keeps the original flight clock', async () => {
  const h = cooperativeHarness(); await h.start();
  const initial = h.reads[0]; await initial.answer(); h.tick();
  const touched = cellStart(h.now() - 10 * H, initial.cell);
  h.store.news(touched); await flush(); await h.finish();
  for (const grid of h.internals.grids.values()) for (const tile of grid.values()) if (tile.readTo > touched) assert.ok((tile as unknown as {validTo: number}).validTo <= Math.max(tile.readFrom, touched));
  assert.equal((h.store as unknown as {metaAt: number}).metaAt, 0, 'merging time cannot replace the flight’s original clock anchor');
  assert.ok(pending(h).some(read => read.from <= touched && read.to > touched), 'the touched suffix remains required after publication');
  h.store.close();
});

const cacheOf = (store: HistoryStore) => (store as unknown as {grids: Map<number, Map<number, HistoryTile>>}).grids;
const freshCells = (store: HistoryStore, cell: number) => {
  const cells = new Set<number>();
  for (const tile of cacheOf(store).get(cell)?.values() ?? []) for (let at = tile.readFrom; at < tile.validTo; at += cell) cells.add(at);
  return cells;
};

for (const length of [24 * H, 30 * 24 * H]) for (const sourceFuture of [0, 24 * H]) for (const latency of [0, 100, 400]) {
  test(`half-width pan batches cold ${length / H}h, source future ${sourceFuture / H}h, latency ${latency}ms; cached return and repeat read nothing`, async () => {
    const h = harness(); h.store.choose(length === 24 * H ? '24h' : '30d', null); await h.start(); await h.reads[0].answer();
    const cell = h.reads[0].cell, seed = freshCells(h.store, cell), offset = h.reads.length;
    let selected: {from: number; to: number} | null = null, clock = 0;
    const frames: (() => void)[] = [], due = new Map<object, number>(), visited = new Set<number>();
    const gesture = new Pan({now: h.now, commit: range => {selected = range; h.store.choose('24h', range);}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
    const history = Symbol('history'), activity = Symbol('activity');
    gesture.register(history, () => ({end: selected?.to ?? NOW, future: selected ? 0 : 24 * H}));
    gesture.register(activity, () => ({end: selected?.to ?? NOW, future: 0}));
    const unsubscribe = followPan(h.store, gesture, () => selected);
    const source = sourceFuture ? history : activity;
    const token = gesture.begin({source, input: 'pointer', selected, length, now: NOW, historyStart: 0, span: length + sourceFuture, width: 1000})!;
    const collect = () => {
      const frame = gesture.get(); if (!frame) return;
      const target = targetOf(length, NOW, 'plot', {...frame, to: Math.min(NOW, frame.to + frame.lookAhead)});
      for (let k = target.k0; k <= target.k1; k++) visited.add(k * cell);
    };
    const answerDue = async (finish = false) => {
      for (const r of pending(h)) if (!due.has(r)) due.set(r, clock + latency);
      for (const r of [...pending(h)]) if (finish || due.get(r)! <= clock) await r.answer();
    };
    collect();
    for (let n = 0; n < 30; n++) {
      gesture.move(token, -1000 * .5 / 30); frames.shift()!(); collect(); await flush();
      await answerDue(); clock += 25;
      assert.ok(pending(h).length <= 2);
    }
    gesture.finish(token); await flush();
    for (let n = 0; n < 20 && pending(h).length; n++) await answerDue(true);
    assert.equal(pending(h).length, 0);
    assert.equal(h.store.get().history?.range, `${selected!.from}-${selected!.to}`);
    const attempts = h.reads.slice(offset);
    assert.ok(attempts.length <= (sourceFuture ? 7 : 5), `${attempts.length} attempts`);
    const requested = new Set<number>();
    for (const r of attempts) {
      assert.ok(tileOf(r.to - 1, cell) - tileOf(r.from, cell) < 8);
      for (let at = r.from; at < r.to; at += cell) {
        assert.ok(!seed.has(at), `fresh seed cell ${at} was reread`);
        assert.ok(!requested.has(at), `fresh sequential cell ${at} was reread`);
        requested.add(at);
      }
    }
    assert.ok([...requested].filter(at => !visited.has(at)).length <= Math.min(60, Math.ceil(length / cell / 4)));
    const count = h.reads.length;
    for (const direction of [1, -1, 1, -1] as const) for (let n = 0; n <= 30; n++) {
      const delta = (length + sourceFuture) * .5 * (direction === -1 ? n : 30 - n) / 30;
      h.store.pan({token: 10, length, from: NOW - length - delta, to: Math.min(NOW, NOW - delta + 24 * H), direction}); await flush();
    }
    assert.equal(h.reads.length, count, 'warm return/repeat cannot sweep a cold adjacent period');
    unsubscribe(); h.store.close();
  });
}

test('one available contiguous prefix is read immediately without rereading its fresh suffix', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const seed = freshCells(h.store, h.reads[0].cell), offset = h.reads.length;
  const range = {from: NOW - 40 * H, to: NOW - 16 * H};
  h.store.pan({token: 1, length: 24 * H, ...range, direction: 0}); await flush();
  assert.equal(h.reads.length, offset + 1, 'a whole missing run starts before release');
  const r = pending(h)[0];
  assert.equal(r.to, Math.min(...seed));
  assert.equal(r.from, cellStart(range.from, r.cell));
  await r.answer();
  assert.equal(h.reads.length, offset + 1);
  h.store.choose('24h', range); h.store.endPan(true); await flush();
  assert.equal(h.store.get().history?.range, `${range.from}-${range.to}`);
  h.store.close();
});

for (const sourceFuture of [0, 24 * H]) test(`small 4% pan with source future ${sourceFuture / H}h uses at most two attempts`, async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const offset = h.reads.length;
  for (let n = 1; n <= 30; n++) {
    const delta = (24 * H + sourceFuture) * .04 * n / 30;
    h.store.pan({token: 1, length: 24 * H, from: NOW - 24 * H - delta, to: NOW, direction: -1}); await flush();
    for (const r of pending(h)) await r.answer();
  }
  const delta = (24 * H + sourceFuture) * .04;
  h.store.choose('24h', {from: NOW - 24 * H - delta, to: NOW - delta}); h.store.endPan(true); await flush();
  for (const r of pending(h)) await r.answer();
  assert.ok(h.reads.length - offset <= 2);
  h.store.close();
});

test('a coalesced custom 15min jump reads only its minimal within-tile bridge and retains the fresh suffix', async () => {
  const h = harness(), base = tileStart(tileOf(NOW - 10 * H, M), M);
  let selected = {from: base + 40 * M, to: base + 55 * M};
  h.store.choose('24h', selected); await h.start(); await h.reads[0].answer();
  const old = cacheOf(h.store).get(M)!.get(tileOf(base, M))!;
  assert.equal(old.readFrom, base + 40 * M); assert.equal(old.validTo, base + 60 * M);
  const offset = h.reads.length, frames: (() => void)[] = [];
  const gesture = new Pan({now: h.now, commit: range => {selected = range!; h.store.choose('24h', range);}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const source = Symbol('chart'); gesture.register(source, () => ({end: selected.to, future: 0}));
  const unsubscribe = followPan(h.store, gesture, () => selected);
  const token = gesture.begin({source, input: 'pointer', selected, length: 15 * M, now: NOW, historyStart: 0, span: 15 * M, width: 1000})!;
  gesture.move(token, -40 / 15 * 1000); frames.shift()!(); await flush();
  assert.equal(h.reads.length, offset + 1);
  const r = pending(h)[0];
  assert.equal(r.to, base + 40 * M, '25 bridge cells connect to the held suffix');
  assert.ok(r.from >= base - 4 * M && r.from <= base, 'only the four-cell optional allowance can precede the viewport');
  await r.answer(); gesture.finish(token); await flush();
  const tile = cacheOf(h.store).get(M)!.get(tileOf(base, M))!;
  assert.equal(tile.readFrom, base); assert.equal(tile.readTo, base + 60 * M); assert.equal(tile.validTo, tile.readTo);
  const count = h.reads.length;
  for (const range of [{from: base + 40 * M, to: base + 55 * M}, {from: base, to: base + 15 * M}]) {
    h.store.pan({token: 2, length: 15 * M, ...range, direction: 0}); await flush();
    h.store.choose('24h', range); h.store.endPan(true); await flush();
    assert.equal(h.store.get().history?.range, `${range.from}-${range.to}`);
  }
  assert.equal(h.reads.length, count, 'the retained suffix and connected prefix remain cached');
  unsubscribe(); h.store.close();
});

test('a forward disjoint jump starts at the stale frontier without crossing the fresh prefix', async () => {
  const h = harness(), base = tileStart(tileOf(NOW - 10 * H, M), M);
  h.store.choose('24h', {from: base, to: base + 15 * M}); await h.start(); await h.reads[0].answer();
  const tile = cacheOf(h.store).get(M)!.get(tileOf(base, M))!;
  tile.readTo = base + 15 * M; tile.validTo = base + 10 * M;
  const offset = h.reads.length;
  h.store.pan({token: 1, length: 15 * M, from: base + 40 * M, to: base + 55 * M, direction: 1}); await flush();
  assert.equal(h.reads.length, offset + 1);
  const r = pending(h)[0]; assert.equal(r.from, base + 10 * M); assert.ok(r.to <= base + 59 * M);
  await r.answer();
  const next = cacheOf(h.store).get(M)!.get(tileOf(base, M))!;
  assert.equal(next.readFrom, base); assert.equal(next.validTo, r.to);
  h.store.close();
});

test('prefetch keeps broad batches across every initial tile alignment in either direction', async () => {
  const length = 24 * H, cell = cellOf(length);
  for (let offset = 0; offset < 60; offset++) for (const direction of [-1, 1] as const) {
    const h = harness(); h.correctClock(offset * cell);
    const origin = {from: h.now() - 72 * H, to: h.now() - 48 * H};
    h.store.choose('24h', origin); await h.start(); await h.reads[0].answer();
    const seed = freshCells(h.store, cell), requested = new Set<number>();
    for (let n = 1; n <= 30; n++) {
      const delta = direction * length * n / 30;
      const from = origin.from + delta, to = origin.to + delta;
      h.store.pan({token: 1, length, from, to, direction}); await flush();
      for (const read of [...pending(h)]) {
        assert.ok(read.to - read.from >= 60 * cell, 'rounding must not turn the next miss into another small request');
        if (offset === 0 && direction === 1 && n === 4) {
          assert.equal(tileOf(read.to - 1, cell), tileOf(read.from, cell),
            'the optional tail fits in one tile without repeating its metadata');
        }
        for (let at = read.from; at < read.to; at += cell) {
          assert.ok(!seed.has(at) && !requested.has(at), 'a tile edge never rereads a fresh cell');
          requested.add(at);
        }
        await read.answer();
      }
      assert.ok(covered(h.store.getPlot()!.coverage, cellStart(from, cell), Math.ceil(to / cell) * cell));
      const optional = (h.store as unknown as {optional: Set<number>}).optional;
      assert.ok(optional.size <= 60);
      assert.ok([...optional].every(at => requested.has(at)), 'trimmed cells consume no allowance');
    }
    assert.ok(h.reads.length - 1 <= 5);
    h.store.close();
  }
});

test('reversal and abort before delivery never refund unvisited optional cells', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const cell = cellOf(24 * H), from = tileStart(tileOf(NOW - 25 * H, cell), cell);
  h.store.pan({token: 1, length: 24 * H, from, to: from + 24 * H, direction: -1}); await flush();
  const old = pending(h)[0], internals = h.store as unknown as {optional: Set<number>};
  const charged = new Set(internals.optional); assert.equal(charged.size, 60);
  h.store.pan({token: 1, length: 24 * H, from: NOW - 24 * H, to: NOW, direction: 1}); await flush();
  assert.ok(old.signal!.aborted); assert.deepEqual(internals.optional, charged);
  await old.answer(); assert.deepEqual(internals.optional, charged, 'a discarded body cannot refund the buffer');
  h.store.pan({token: 1, length: 24 * H, from: NOW - 72 * H, to: NOW - 48 * H, direction: -1}); await flush();
  assert.deepEqual(internals.optional, charged, 'another miss cannot buy a new buffer after reversal');
  assert.ok(pending(h)[0].from >= cellStart(NOW - 72 * H, old.cell));
  h.store.close();
});

test('abandoning a multi-tile answer during staging releases every reservation without changing the retained frame', async () => {
  const h = cooperativeHarness(); await h.start(); await h.reads[0].answer(); await h.finish();
  const retained = h.store.get().history;
  h.store.pan({token: 1, length: 24 * H, from: NOW - 48 * H, to: NOW - 24 * H, direction: -1}); await flush();
  const read = pending(h)[0]; await read.answer(); h.tick();
  assert.ok(h.internals.reservations.size > 1); assert.equal(h.internals.responses.size, 1);
  assert.equal(h.store.get().history, retained);
  h.store.pan({token: 1, length: 24 * H, from: NOW - 10 * H, to: NOW, direction: 1}); await flush();
  assert.equal(h.internals.responses.size, 0); assert.equal(h.internals.reservations.size, 0);
  await h.finish(); assert.equal(h.store.get().history, retained); h.store.close();
});

test('a late disjoint inherited slice is discarded whole and cannot manufacture known gap coverage', async () => {
  const h = harness(), base = tileStart(tileOf(NOW - 10 * H, M), M);
  const range = {from: base + 40 * M, to: base + 55 * M};
  h.store.choose('24h', range); await h.start(); await h.reads[0].answer();
  const target = targetOf(15 * M, NOW, 'old', {from: base, to: base + 15 * M});
  (h.store as unknown as {read(wanted: typeof target, from: number, to: number, role: 'visible'): void}).read(target, base, base + 15 * M, 'visible');
  const read = pending(h)[0]; await read.answer();
  const tile = cacheOf(h.store).get(M)!.get(tileOf(base, M))!;
  assert.equal(tile.readFrom, base + 40 * M); assert.equal(tile.validTo, base + 60 * M);
  assert.ok(read.signal?.aborted); assert.equal(pending(h).length, 0);
  h.store.close();
});

const richChunks = (from: number, to: number, cell: number): Chunk[] => {
  const chunks: Chunk[] = [];
  for (let a = from; a < to;) {
    const b = Math.min(to, tileEnd(tileOf(a, cell), cell)), chunk = empty(a, b), count = (b - a) / cell;
    chunk.series = Array.from({length: 12}, (_, source) => ({source: `s${source}`, window: 'w', hold: 3 * cell, open: 80,
      cells: Array.from({length: count}, (_, i) => [i, 60 + ((a / cell + i) % 20), .125, cell, {o: 80, h: cell, w: [.062, .4 * cell, .031]}])}));
    chunk.activity = {sessions: [['r0', 's0', 'P', 'd'], ['r1', 's1', 'P', 'd']], devices: {d: 'Device'}, cells: Array.from({length: count}, (_, i) => [i, .4 * cell, [[0, .3 * cell], [1, .3 * cell]], [['s', 's0', .3 * cell], ['s', 's1', .3 * cell], ['p', JSON.stringify('P'), .4 * cell], ['d', 'd', .4 * cell]]])};
    for (let i = 0; i < count; i++) if ((a / cell + i) % 19 === 0) {chunk.resets.push(['s0', 'w', a + i * cell]); chunk.grants.push(['s1', a + i * cell, 2]);}
    chunks.push(chunk); a = b;
  }
  return chunks;
};

for (const cell of READ_CELLS) test(`narrow pan cells preserve exact rich series, work, refs and events on grid ${cell / M}min`, async () => {
  const length = cell * (cell === M ? 15 : 300);
  assert.equal(cellOf(length), cell);
  const h = harness(), base = tileStart(tileOf(NOW - 2 * length, cell), cell), origin = {from: base + 40 * cell, to: base + 40 * cell + length};
  const windows = Array.from({length: 12}, (_, i) => `s${i} w`), known = {work: 0, sources: Object.fromEntries(windows.map(key => [key.split(' ')[0], 0]))};
  const answer = async (r: typeof h.reads[number]) => r.answer({known, chunks: richChunks(r.from, r.to, cell)});
  h.store.choose('24h', origin); await h.start(); h.store.setWindows(windows); await answer(h.reads[0]);
  const range = {from: origin.from - 30 * cell, to: origin.to - 30 * cell}, seed = freshCells(h.store, cell), offset = h.reads.length;
  h.store.pan({token: 1, length, ...range, direction: -1}); await flush();
  for (let n = 0; n < 10 && pending(h).length; n++) for (const r of pending(h)) {
    for (const at of Array.from({length: (r.to - r.from) / cell}, (_, i) => r.from + i * cell)) assert.ok(!seed.has(at));
    await answer(r);
  }
  h.store.choose('24h', range); h.store.endPan(true); await flush();
  for (const r of pending(h)) await answer(r);
  assert.equal(h.reads.length, offset + 1, 'a connected prefix remains one batch');
  const from = cellStart(range.from, cell), to = Math.ceil(range.to / cell) * cell, key = `${range.from}-${range.to}`;
  const expected = compose(richChunks(from, to, cell), {now: NOW, historyStart: 0, known}, targetOf(length, NOW, key, range), new Set(windows));
  assert.deepEqual(h.store.get().history, {...expected, board: 'b'});
  h.store.close();
});

test('news in a connecting prefix never proves a stale bridge fresh, and a later suffix refresh starts at that frontier', async () => {
  const h = harness(), base = tileStart(tileOf(NOW - 10 * H, M), M);
  h.store.choose('24h', {from: base + 40 * M, to: base + 55 * M}); await h.start(); await h.reads[0].answer();
  h.store.pan({token: 1, length: 15 * M, from: base, to: base + 15 * M, direction: -1}); await flush();
  const prefix = pending(h)[0]; assert.equal(prefix.to, base + 40 * M);
  h.store.news(base + 20 * M); await prefix.answer();
  const tile = cacheOf(h.store).get(M)!.get(tileOf(base, M))!;
  assert.equal(tile.readFrom, base); assert.equal(tile.readTo, base + 60 * M); assert.equal(tile.validTo, base + 20 * M);
  h.store.pan({token: 1, length: 15 * M, from: base + 40 * M, to: base + 55 * M, direction: 0}); await flush();
  const suffix = pending(h)[0]; assert.equal(suffix.from, base + 20 * M); assert.equal(suffix.to, base + 55 * M);
  await suffix.answer();
  assert.equal(cacheOf(h.store).get(M)!.get(tileOf(base, M))!.validTo, base + 55 * M);
  h.store.close();
});

test('final completion retains a useful owner whose old role was speculative', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const range = {from: NOW - 25 * H, to: NOW - H};
  h.store.pan({token: 1, length: 24 * H, ...range, direction: -1}); await flush();
  const read = pending(h)[0], flights = (h.store as unknown as {flights: Set<{role: 'visible' | 'ahead'}>}).flights;
  for (const flight of flights) flight.role = 'ahead';
  h.store.choose('24h', range); h.store.endPan(true); await flush();
  assert.equal(read.signal?.aborted, false, 'current usefulness wins over the earlier role');
  await read.answer(); assert.equal(h.store.get().history?.range, `${range.from}-${range.to}`);
  h.store.close();
});

test('a failed owner that became visible keeps the foreground retry even before the role pump runs', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  h.store.pan({token: 1, length: 24 * H, from: NOW - 25 * H, to: NOW - H, direction: -1}); await flush();
  for (const flight of (h.store as unknown as {flights: Set<{role: 'visible' | 'ahead'}>}).flights) flight.role = 'ahead';
  await pending(h)[0].fail(new Error('offline'));
  assert.equal(h.timers.size, 1);
  h.store.close();
});

test('a seven-day look-ahead reads a long visible miss in capped batches and never sweeps beyond its fixed buffer', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const offset = h.reads.length, from = NOW - 5 * 24 * H;
  h.store.pan({token: 1, length: 24 * H, from, to: NOW, direction: -1}); await flush();
  assert.ok(pending(h).length, 'reading starts during movement');
  for (let n = 0; n < 20 && pending(h).length; n++) for (const r of pending(h)) {
    assert.ok(tileOf(r.to - 1, r.cell) - tileOf(r.from, r.cell) < 8);
    await r.answer();
  }
  assert.equal(pending(h).length, 0);
  const reads = h.reads.slice(offset), cell = reads[0].cell;
  assert.ok(reads.length > 1, 'the visible run itself exceeds eight tiles');
  assert.ok(Math.min(...reads.map(r => r.from)) >= cellStart(from, cell) - 60 * cell);
  assert.ok(covered(h.store.getPlot()!.coverage, cellStart(from, cell), cellStart(NOW, cell)));
  const count = h.reads.length;
  h.store.pan({token: 1, length: 24 * H, from, to: NOW, direction: -1}); await flush();
  assert.equal(h.reads.length, count, 'arrival cannot restart a distant sweep');
  const range = {from, to: from + 24 * H}; h.store.choose('24h', range); h.store.endPan(true); await flush();
  assert.equal(h.store.get().history?.range, `${range.from}-${range.to}`); assert.equal(h.reads.length, count);
  h.store.close();
});

test('a custom 31-day range keeps its grid and exact accounting through a pan and cached return', async () => {
  const length = 31 * 24 * H, h = harness(), origin = {from: NOW - length, to: NOW};
  h.store.choose('30d', origin); await h.start(); await h.reads[0].answer();
  assert.equal(h.store.get().history?.cellMs, cellOf(length));
  const offset = h.reads.length, range = {from: origin.from - length / 2, to: origin.to - length / 2};
  h.store.pan({token: 1, length, ...range, direction: -1}); await flush();
  for (let n = 0; n < 20 && pending(h).length; n++) for (const r of pending(h)) {
    assert.equal(r.cell, cellOf(length)); assert.ok(tileOf(r.to - 1, r.cell) - tileOf(r.from, r.cell) < 8); await r.answer();
  }
  h.store.choose('30d', range); h.store.endPan(true); await flush();
  const target = targetOf(length, NOW, `${range.from}-${range.to}`, range);
  assert.deepEqual(h.store.get().history, {...compose([empty(target.k0 * target.cell, (target.k1 + 1) * target.cell)], {now: NOW, historyStart: 0, known: {work: 0, sources: {s: 0}}}, target, new Set(['s w'])), board: 'b'});
  assert.ok(h.reads.length > offset); const count = h.reads.length;
  h.store.pan({token: 2, length, ...origin, direction: 1}); await flush();
  h.store.choose('30d', origin); h.store.endPan(true); await flush(); assert.equal(h.reads.length, count);
  h.store.close();
});

test('two scoped readers share transport slots, prioritize both visible ranges and release cancelled owners', async () => {
  const pool=new HistoryPool(),q=harness(undefined,undefined,'quota',pool),b=harness(undefined,undefined,'budget',pool);
  b.store.setMeters({unit:'USD',ids:[['s','balance']]});
  await Promise.all([q.start(),b.start()]);
  assert.equal(pool.activeFlights,2);assert.equal(q.reads.length,1);assert.equal(b.reads.length,1);
  q.store.choose('7d',null);q.store.choose('30d',null);await flush();
  assert.equal(pool.activeFlights,2);assert.equal(q.reads.length,1,'the same family cannot take another foreground slot');
  await q.reads[0].answer();await q.advance(300);
  assert.equal(q.reads.at(-1)!.to-q.reads.at(-1)!.from>24*H,true);
  b.store.close();assert.equal(b.reads[0].signal?.aborted,true);
  await b.reads[0].answer();assert.equal(b.store.get().history,null);
  q.store.close();assert.equal(pool.activeFlights,0);assert.equal(pool.estimatedBytes,0);
});

test('an incoming family cannot evict the other visible frame or publish an oversized response',async()=>{
  const pool=new HistoryPool(40_000),q=harness(undefined,undefined,'quota',pool),b=harness(undefined,undefined,'budget',pool);
  b.store.setMeters({unit:'USD',ids:[['s','balance']]});
  await q.start();await q.reads[0].answer();const retained=q.store.get().history;
  assert.ok(retained);await b.start();
  const read=b.reads[0],chunks:Chunk[]=[];
  for(let from=read.from;from<read.to;){const to=Math.min(read.to,tileEnd(tileOf(from,read.cell),read.cell));
    chunks.push({...empty(from,to),meterSeries:Array.from({length:24},(_,i)=>({source:'s',meter:'m'+i,kind:'balance' as const,unit:'USD',semantics:null,cells:[[0,'1000000000000000000000000000000000000','0','0',0]]}))});from=to;}
  await read.answer({chunks});
  assert.equal(b.store.get().error,'history_limit');assert.equal(b.store.get().history,null);
  assert.equal(q.store.get().history,retained);assert.ok(pool.estimatedBytes<=pool.budget);assert.equal(pool.activeFlights,0);
  b.store.setMeters({unit:'USD',ids:[]});await flush();
  assert.equal(b.store.get().error,undefined);assert.ok(b.store.get().history);assert.equal(b.reads.length,1,'empty selection completes locally');
  q.store.close();b.store.close();
});

test('scoped failures preserve the shared range except an explicit unreadable-range response',async()=>{
  const pool=new HistoryPool(),q=harness(undefined,undefined,'quota',pool),b=harness(undefined,undefined,'budget',pool);
  b.store.setMeters({unit:'USD',ids:[['s','balance']]});
  const range={from:NOW-4*H,to:NOW-3*H};q.store.choose('24h',range);b.store.choose('24h',range);
  await Promise.all([q.start(),b.start()]);await q.reads[0].answer();const retained=q.store.get().history;
  await b.reads[0].fail(new ApiError(400,'invalid_request'));
  assert.equal(b.dropped(),0);assert.equal(b.store.get().error,'history_failed');assert.equal(q.store.get().history,retained);
  b.store.retry();await flush();await b.reads[1].fail(new ApiError(400,'history_range_invalid'));assert.equal(b.dropped(),1);
  q.store.lineup([]);assert.equal(q.store.get().history,null,'removed sources disappear before their replacement answer');
  q.store.close();b.store.close();
});

test('empty budget selection is a complete frame without transport or retry loops',async()=>{
  const b=harness(undefined,undefined,'budget',new HistoryPool());
  b.store.setMeters({unit:'USD',ids:[]});await b.start();assert.ok(b.store.get().history);assert.equal(b.store.get().loading,false);
  b.store.news(NOW);b.store.choose('7d',null);await flush();assert.equal(b.reads.length,0);assert.equal(b.store.get().history?.range,'7d');b.store.close();
});
