import {test} from 'node:test';
import assert from 'node:assert/strict';
import {followPan, HistoryStore} from '../lib/history';
import {Pan} from '../lib/pan';
import {covered} from '../lib/historyPlot';
import {HistoryTile} from '../lib/historyTiles';
import {Preparations} from '../lib/prepare';
import {ApiError} from '../lib/http';
import {CLOCK_TOLERANCE_MS, cellStart, targetOf, tileEnd, tileOf, tileStart, type Chunk, type HistoryAnswer} from '../../server/domain/history';

const M = 60_000;
const H = 60 * M;
const NOW = Date.parse('2026-09-26T12:23:00Z');
const flush = async () => {for (let i = 0; i < 5; i++) await Promise.resolve();};
const empty = (from: number, to: number): Chunk => ({from, to, series: [], activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []});
const pending = (h: ReturnType<typeof harness>) => h.reads.filter(r => !r.settled && !r.signal?.aborted);
function harness(budget?: number, preparations?: Preparations) {
  let now = NOW;
  let elapsed = 0;
  let dropped = 0;
  const timers = new Map<unknown, {at: number; run: () => void}>();
  const reads: {board: string; cell: number; from: number; to: number; signal?: AbortSignal; settled: boolean; answer(patch?: Partial<HistoryAnswer>): Promise<void>; fail(error: unknown): Promise<void>}[] = [];
  const store = new HistoryStore({
    now: () => now,
    preparations,
    elapsedNow: () => elapsed,
    read: (board, cell, from, to, signal) => new Promise((resolve, reject) => reads.push({board, cell, from, to, signal, settled: false,
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
  }, budget);
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

test('a successful speculative response preserves the failed visible target retry', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  h.store.pan({token: 1, length: 24 * H, from: NOW - 36 * H, to: NOW - 12 * H, direction: -1}); await flush();
  const [visible, ahead] = pending(h);
  await visible.fail(new Error('offline'));
  assert.equal(h.timers.size, 1);
  await ahead.answer();
  assert.equal(h.timers.size, 1, 'an unrelated cached committed answer cannot clear this retry');
  assert.ok(pending(h).every(r => r.from !== visible.from));
  await h.advance(14_999);
  assert.ok(pending(h).every(r => r.from !== visible.from));
  await h.advance(1);
  assert.ok(pending(h).some(r => r.from === visible.from), 'the foreground resumes at its timeout');
  h.store.close();
});

test('an expired committed pan range drops after a required partial read returns 400', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  const range = {from: NOW - 90 * 24 * H + H, to: NOW - 89 * 24 * H + H};
  h.store.pan({token: 1, length: 24 * H, ...range, direction: 0}); await flush();
  h.store.choose('24h', range); h.store.endPan(true); await flush();
  await h.advance(6 * H);
  const inherited = pending(h)[0];
  await inherited.fail(new ApiError(400, 'invalid_request'));
  const current = pending(h)[0];
  assert.ok(current.to < range.to, 'the final batch contains only one tile');
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

test('ahead failure sets no retry and cannot drop a range or block visible work', async () => {
  const h = harness(); await h.start(); await h.reads[0].answer();
  h.store.pan({token: 1, length: 24 * H, from: NOW - 24 * H, to: NOW, direction: -1}); await flush();
  const ahead = pending(h)[0];
  assert.ok(ahead);
  await ahead.fail(new ApiError(400, 'invalid_request'));
  assert.equal(h.dropped(), 0);
  assert.equal(h.timers.size, 0);
  const count = h.reads.length;
  await h.advance(60_000);
  assert.equal(h.reads.length, count);
  h.store.pan({token: 1, length: 24 * H, from: NOW - 48 * H, to: NOW - 24 * H, direction: -1}); await flush();
  assert.ok(pending(h).some(r => r.from <= NOW - 48 * H));
  h.store.endPan(false);
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
