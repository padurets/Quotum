import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryStore} from '../lib/history';
import {ApiError} from '../lib/http';
import {CLOCK_TOLERANCE_MS, cellStart, tileEnd, tileOf, tileStart, type Chunk, type HistoryAnswer} from '../../server/domain/history';

const M = 60_000;
const H = 60 * M;
const NOW = Date.parse('2026-09-26T12:23:00Z');
const flush = async () => {for (let i = 0; i < 5; i++) await Promise.resolve();};
const empty = (from: number, to: number): Chunk => ({from, to, series: [], activity: {sessions: [], devices: {}, cells: []}, resets: [], grants: []});
function harness(budget?: number) {
  let now = NOW;
  let dropped = 0;
  const timers = new Map<unknown, {at: number; run: () => void}>();
  const reads: {board: string; cell: number; from: number; to: number; answer(patch?: Partial<HistoryAnswer>): Promise<void>; fail(error: unknown): Promise<void>}[] = [];
  const store = new HistoryStore({
    now: () => now,
    read: (board, cell, from, to) => new Promise((resolve, reject) => reads.push({board, cell, from, to,
      async answer(patch = {}) {
        const end = Math.min(to, cellStart((patch.now ?? now) + CLOCK_TOLERANCE_MS, cell) + cell);
        const chunks: Chunk[] = [];
        for (let a = from; a < end;) {const b = Math.min(end, tileEnd(tileOf(a, cell), cell)); chunks.push(empty(a, b)); a = b;}
        resolve({run: 'run', now, historyStart: 0, known: {work: 0, sources: {s: 0}}, chunks, ...patch});
        await flush();
      },
      async fail(error) {reject(error); await flush();},
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
      now = next[1].at; timers.delete(next[0]); next[1].run(); await flush();
    }
    now = end;
  };
  const start = async () => {store.open('b'); store.hello('run'); store.snapshot(['s'], ['s w']); await flush();};
  return {store, reads, advance, start, now: () => now, dropped: () => dropped, timers};
}

test('the first snapshot reads once from a tile edge; news reads only the tail, without dimming', async () => {
  const h = harness();
  h.store.open('b'); h.store.hello('run'); await flush();
  assert.equal(h.reads.length, 0);
  h.store.snapshot(['s'], ['s w']); await flush();
  assert.equal(h.reads.length, 1);
  const first = h.reads[0];
  assert.equal(first.from, tileStart(tileOf(NOW - 24 * H, first.cell), first.cell));
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
