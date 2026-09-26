import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryLoader, LIVE_MIN_MS} from '../lib/history';
import type {History} from '../lib/types';
import {ApiError} from '../lib/http';

const S = 1000;
const MIN = 60_000;
const NOW = Date.parse('2026-09-26T12:00:00Z');

/** A loader whose reads the test answers, on a clock the test moves. */
function harness() {
  let t = NOW;
  const timers: {at: number; run: () => void; id: number}[] = [];
  let next = 1;
  const reads: {query: string; answer(history?: Partial<History>): Promise<void>; fail(error: unknown): Promise<void>}[] = [];
  let dropped = 0;
  const loader = new HistoryLoader({
    read: (_board, query) =>
      new Promise<History>((resolve, reject) => {
        reads.push({
          query,
          answer: async (history = {}) => {
            const range = query.startsWith('range=') ? query.slice(6) : query.replace(/from=(\d+)&to=(\d+)/, '$1-$2');
            resolve({range, now: t, since: t - 86_400_000, to: t, cellMs: 5 * MIN, historyStart: 0, series: [], events: [], refreshInMs: null, ...history});
            await flush();
          },
          fail: async error => {
            reject(error);
            await flush();
          },
        });
      }),
    now: () => t,
    setTimeout: (run, ms) => {
      timers.push({at: t + ms, run, id: next});
      return next++;
    },
    clearTimeout: id => {
      const i = timers.findIndex(timer => timer.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    dropTimeRange: () => void dropped++,
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers[0] || timers[0].at > end) break;
      const timer = timers.shift()!;
      t = timer.at;
      timer.run();
      await flush();
    }
    t = end;
  };
  return {loader, reads, advance, dropped: () => dropped};
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
};

test("the period ending now is read on the board's first snapshot, not before; news reads it again at most every 10 s", async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  assert.equal(h.reads.length, 0, 'nothing before the snapshot');
  h.loader.snapshot(['s1', 's2']);
  assert.deepEqual(h.reads.map(r => r.query), ['range=24h']);
  await h.reads[0].answer();
  assert.equal(h.loader.get().history?.range, '24h');

  // Two measurements three seconds apart, ten seconds after the snapshot's read: one read at once, one ten seconds after it.
  await h.advance(LIVE_MIN_MS);
  h.loader.news(NOW);
  assert.equal(h.reads.length, 2, 'ten seconds after the last: at once');
  await h.advance(3 * S);
  h.loader.news(NOW);
  assert.equal(h.reads.length, 2, 'in flight: it is read once more after it');
  await h.reads[1].answer();
  assert.equal(h.reads.length, 2, 'not before ten seconds after the last read');
  await h.advance(7 * S);
  assert.equal(h.reads.length, 3);
  h.loader.news(NOW);
  h.loader.news(NOW);
  await h.reads[2].answer();
  await h.advance(LIVE_MIN_MS);
  assert.equal(h.reads.length, 4, 'news during a read: exactly one more');
  await h.reads[3].answer();
  await h.advance(MIN);
  assert.equal(h.reads.length, 4);
});

test('every snapshot (a connection again) reads the period again, within the same limit, and drops the ranges kept', async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.reads[0].answer();
  const range = {from: NOW - 3 * 3_600_000, to: NOW - 2 * 3_600_000};
  h.loader.choose('24h', range);
  await h.advance(S);
  await h.reads[1].answer({range: `${range.from}-${range.to}`, to: range.to});
  h.loader.choose('24h', null);
  await h.advance(S);
  await h.reads[2].answer();
  h.loader.choose('24h', range);
  await h.advance(S);
  assert.equal(h.reads.length, 3, 'back to the range: kept, not read');
  assert.equal(h.loader.get().history?.range, `${range.from}-${range.to}`);
  h.loader.choose('24h', null);
  await h.advance(S);
  await h.reads[3].answer();
  await h.advance(LIVE_MIN_MS);
  const before = h.reads.length;
  h.loader.snapshot(['s1']);
  assert.equal(h.reads.length, before + 1);
  h.loader.choose('24h', range);
  await h.advance(S);
  assert.equal(h.reads.length, before + 2, 'the range is read again: late measurements may have come meanwhile');
});

test('news of measurements taken at some time drops a range kept that holds that time, not one before it; the one on screen is read again', async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.reads[0].answer();
  const early = {from: NOW - 10 * 3_600_000, to: NOW - 9 * 3_600_000};
  const late = {from: NOW - 3 * 3_600_000, to: NOW - 2 * 3_600_000};
  for (const range of [early, late]) {
    h.loader.choose('24h', range);
    await h.advance(S);
    await h.reads.at(-1)!.answer({range: `${range.from}-${range.to}`, to: range.to});
  }
  const reads = h.reads.length;
  // Two pieces of news in one go: the earlier one decides.
  h.loader.news(NOW - 150 * MIN);
  h.loader.news(NOW - 30 * MIN);
  await h.advance(LIVE_MIN_MS);
  assert.equal(h.reads.length, reads + 1, 'the late range, on screen, is read again');
  await h.reads.at(-1)!.answer({range: `${late.from}-${late.to}`, to: late.to});
  h.loader.choose('24h', early);
  await h.advance(S);
  assert.equal(h.reads.length, reads + 1, 'the early one is still kept');
});

test('a new source on the board reads the range on screen again; a quick run of steps reads only where it stops', async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.reads[0].answer();
  h.loader.lineup(['s1', 's2']);
  assert.equal(h.reads.length, 2);
  h.loader.lineup(['s2', 's1']);
  assert.equal(h.reads.length, 2, 'the same sources in another order');
  await h.reads[1].answer();
  await h.advance(S);
  for (let i = 1; i <= 5; i++) {
    h.loader.choose('24h', {from: NOW - (i + 1) * 3_600_000, to: NOW - i * 3_600_000});
    await h.advance(100);
  }
  await h.advance(S);
  assert.equal(h.reads.length, 4, 'the first step, then the last');
  assert.match(h.reads.at(-1)!.query, new RegExp(`from=${NOW - 6 * 3_600_000}`));
  assert.equal(h.loader.get().loading, true, 'the history on screen stays while another loads');
});

test('a range the hub refuses brings the chosen period back; another failure is tried again later', async () => {
  const h = harness();
  h.loader.open('b1');
  h.loader.choose('24h', {from: NOW - 100 * 86_400_000, to: NOW - 99 * 86_400_000});
  h.loader.snapshot(['s1']);
  await h.reads[0].fail(new ApiError(400, 'invalid_request'));
  assert.equal(h.dropped(), 1);
  h.loader.choose('24h', null);
  await h.advance(S);
  await h.reads.at(-1)!.fail(new Error('offline'));
  const reads = h.reads.length;
  await h.advance(15 * S);
  assert.equal(h.reads.length, reads + 1);
});
