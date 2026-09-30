import {test} from 'node:test';
import assert from 'node:assert/strict';
import {INITIAL, reduce, type Snapshot} from '../lib/board';
import {follow, HistoryLoader, LIVE_MIN_MS} from '../lib/history';
import {createStore} from '../lib/store';
import type {History} from '../lib/types';
import {ApiError} from '../lib/http';

const S = 1000;
const MIN = 60_000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const NO_WORK: History['activity'] = {since: 0, known: null, barMs: 60_000, activeMs: 0, agentMs: 0, agents: 0, cells: [], by: {source: [], project: [], device: []}};

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
            resolve({range, now: t, since: t - 86_400_000, to: t, cellMs: 5 * MIN, historyStart: 0, series: [], events: [], activity: NO_WORK, refreshInMs: null, ...history});
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

test('all of the history as news (whose work the board shows changed) is read at once, as a new lineup is, and no range of it is kept', async () => {
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
  await h.advance(2 * S);
  h.loader.news(0);
  assert.equal(h.reads.length, 4, 'two seconds after the last read: at once');
  await h.advance(50);
  h.loader.news(0);
  await h.advance(S);
  assert.equal(h.reads.length, 5, 'and again, told while it is read, once a run of them stops, its answer no longer the one shown');
  await h.reads[3].answer({cellMs: MIN});
  assert.notEqual(h.loader.get().history?.cellMs, MIN, 'the answer read before the second is not shown');
  await h.reads[4].answer();
  h.loader.choose('24h', range);
  await h.advance(S);
  assert.equal(h.reads.length, 6, 'the range kept is read again');
});

test('a new lineup and all of the history as news, told in one message, are read once, and a range read so is kept', async () => {
  const h = harness();
  const range = {from: NOW - 3 * 3_600_000, to: NOW - 2 * 3_600_000};
  h.loader.choose('24h', range);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.reads[0].answer({range: `${range.from}-${range.to}`, to: range.to});
  await h.advance(S);
  h.loader.lineup(['s1', 's2']);
  h.loader.news(0);
  assert.equal(h.reads.length, 2, 'the news reached the hub before the read the lineup began: it holds it');
  await h.reads[1].answer({range: `${range.from}-${range.to}`, to: range.to});
  await h.advance(LIVE_MIN_MS);
  assert.equal(h.reads.length, 2, 'nor is it read again after');
  h.loader.choose('24h', null);
  await h.advance(S);
  await h.reads[2].answer();
  h.loader.choose('24h', range);
  await h.advance(S);
  assert.equal(h.reads.length, 3, 'kept: back to it asks nothing');
  // Told in a message of its own, after the read began, it may have come after the hub answered.
  h.loader.lineup(['s1']);
  await h.advance(50);
  h.loader.news(0);
  await h.advance(S);
  assert.equal(h.reads.length, 5);
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

const HOUR = 3_600_000;

test('news or a snapshot while a range is read: its answer may miss what came, so it is shown, not kept, and read again', async () => {
  const range = {from: NOW - 3 * HOUR, to: NOW - 2 * HOUR};
  const answer = {range: `${range.from}-${range.to}`, to: range.to};
  for (const told of ['news', 'news, then of a later time', 'news of a later time, then this', 'snapshot'] as const) {
    const h = harness();
    h.loader.choose('24h', null);
    h.loader.open('b1');
    h.loader.snapshot(['s1']);
    await h.reads[0].answer();
    await h.advance(LIVE_MIN_MS);
    h.loader.choose('24h', range);
    await h.advance(S);
    assert.equal(h.reads.length, 2, 'the range is being read');
    // The event comes before the (large) answer, which the hub put together before the measurement.
    // A measurement taken now, told before or after: the earliest news decides.
    if (told === 'news of a later time, then this') h.loader.news(NOW);
    if (told === 'snapshot') h.loader.snapshot(['s1']);
    else h.loader.news(range.from + 10 * MIN);
    if (told === 'news, then of a later time') h.loader.news(NOW);
    await h.reads[1].answer(answer);
    await h.advance(LIVE_MIN_MS + S);
    assert.equal(h.reads.length, 3, `${told}: the range on screen is read again`);
    await h.reads[2].answer(answer);

    // Stepped away and back: the answer read again was kept, the old one never was.
    h.loader.choose('24h', null);
    await h.advance(S);
    await h.reads.at(-1)!.answer();
    const reads = h.reads.length;
    h.loader.choose('24h', range);
    await h.advance(S);
    assert.equal(h.reads.length, reads, `${told}: kept as read again`);
  }
});

test('a range stepped past while it is read, and touched by news meanwhile, is read again when stepped back to', async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.reads[0].answer();
  const a = {from: NOW - 3 * HOUR, to: NOW - 2 * HOUR};
  const b = {from: NOW - 5 * HOUR, to: NOW - 4 * HOUR};
  h.loader.choose('24h', a);
  await h.advance(S);
  h.loader.choose('24h', b);
  await h.advance(S);
  h.loader.news(a.from + MIN);
  await h.reads.find(r => r.query.includes(`from=${a.from}`))!.answer({range: `${a.from}-${a.to}`, to: a.to});
  for (const r of h.reads.filter(r => r.query.includes(`from=${b.from}`))) await r.answer({range: `${b.from}-${b.to}`, to: b.to});
  const reads = h.reads.length;
  h.loader.choose('24h', a);
  await h.advance(S);
  assert.equal(h.reads.length, reads + 1);
});

test('a refusal of a range the page has stepped away from does not drop the one selected now', async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.reads[0].answer();
  await h.advance(10 * S);
  h.loader.choose('24h', {from: NOW - 3 * HOUR, to: NOW - 2 * HOUR});
  await h.advance(100);
  h.loader.choose('24h', {from: NOW - 4 * HOUR, to: NOW - 3 * HOUR});
  await h.reads[1].fail(new ApiError(400, 'invalid_request'));
  assert.equal(h.dropped(), 0);
  await h.advance(S);
  assert.match(h.reads.at(-1)!.query, new RegExp(`from=${NOW - 4 * HOUR}`), 'the one selected is read');
});

test('news after a range ends, while it is read, leaves it as read: shown, kept, and not read again', async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.reads[0].answer();
  await h.advance(LIVE_MIN_MS);
  const range = {from: NOW - 3 * HOUR, to: NOW - 2 * HOUR};
  const answer = {range: `${range.from}-${range.to}`, to: range.to};
  h.loader.choose('24h', range);
  await h.advance(100);
  // A steady trickle of measurements taken now, each coming while the range is read.
  for (let i = 0; i < 5; i++) {
    h.loader.news(NOW + i * S);
    await h.advance(S);
  }
  await h.reads[1].answer(answer);
  await h.advance(LIVE_MIN_MS + S);
  assert.equal(h.reads.length, 2, 'read once');
  h.loader.choose('24h', null);
  await h.advance(S);
  await h.reads.at(-1)!.answer();
  const reads = h.reads.length;
  h.loader.choose('24h', range);
  await h.advance(S);
  assert.equal(h.reads.length, reads, 'kept');
});

test('the period ending now: news while it is read, and more of it, give one read more, ten seconds after the last began', async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.advance(S);
  h.loader.news(NOW);
  h.loader.news(NOW + S);
  h.loader.snapshot(['s1']);
  await h.reads[0].answer();
  await h.advance(LIVE_MIN_MS - S - 1);
  assert.equal(h.reads.length, 1, 'not before ten seconds');
  await h.advance(2);
  assert.equal(h.reads.length, 2);
  await h.reads[1].answer();
  await h.advance(MIN);
  assert.equal(h.reads.length, 2, 'and no more');
});

test('the period ending now: a measurement taken just after the hub put its answer together, told before the answer came, reads it again', async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.advance(S);
  h.loader.news(NOW + S + 20);
  await h.reads[0].answer({to: NOW + S});
  await h.advance(LIVE_MIN_MS);
  assert.equal(h.reads.length, 2);
});

test('a range reaching past now, its end cut to now: news of a time after that, while it is read, reads it again, then no more', async () => {
  const h = harness();
  h.loader.choose('24h', null);
  h.loader.open('b1');
  h.loader.snapshot(['s1']);
  await h.reads[0].answer();
  await h.advance(LIVE_MIN_MS);
  const range = {from: NOW - 2 * HOUR, to: NOW + HOUR};
  const answer = (to: number) => ({range: `${range.from}-${range.to}`, to});
  h.loader.choose('24h', range);
  await h.advance(100);
  h.loader.news(NOW + LIVE_MIN_MS + S);
  await h.reads[1].answer(answer(NOW + LIVE_MIN_MS + 100));
  await h.advance(LIVE_MIN_MS + S);
  assert.equal(h.reads.length, 3);
  await h.reads[2].answer(answer(NOW + 2 * LIVE_MIN_MS + S));
  await h.advance(10 * MIN);
  assert.equal(h.reads.length, 3);
});

/** A board as its snapshot tells it, for the page's events that drive the loader (`follow`). */
const SNAPSHOT: Snapshot = {
  board: {id: 'b1', name: 'Home', personal: true},
  view: {layout: {columns: 6, places: {}}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}},
  historyStart: 0,
  sources: [],
  sessions: {},
  cadence: {},
  refresh: {},
  forecast: {},
  mine: [],
  boards: [],
  resets: {resets: {}, trackers: [], past: {}},
};

test('a board left (signed out, gone), as the page tells it, is read no more, whatever comes due, is chosen or answers', async () => {
  const h = harness();
  const store = createStore(reduce, INITIAL);
  follow(h.loader, store);
  const opened = () => {
    store.dispatch({type: 'board-open', id: 'b1'});
    store.dispatch({type: 'hub', event: {type: 'snapshot', data: SNAPSHOT}});
  };
  const news = () => store.dispatch({type: 'hub', event: {type: 'history', data: {sources: ['s1'], since: NOW}}});
  h.loader.choose('24h', null);
  opened();
  await h.reads[0].answer();
  await h.advance(LIVE_MIN_MS);
  news();
  store.dispatch({type: 'hub', event: {type: 'lineup', data: {sources: ['s1']}}});
  assert.equal(h.reads.length, 3, 'news of measurements, then a source on the board: read again');
  await h.reads[2].answer();
  await h.advance(S);
  news();
  store.dispatch({type: 'board-close'});
  await h.advance(MIN);
  h.loader.choose('7d', null);
  h.loader.news(NOW);
  await h.advance(MIN);
  assert.equal(h.reads.length, 3);
  assert.equal(h.loader.get().history, null, 'nothing of it is shown');
  opened();
  assert.equal(h.reads.length, 4, 'opened again, read again');

  // A range the hub refuses after the page left: the time range stays, and nothing is tried again.
  h.loader.choose('7d', {from: NOW - 3 * HOUR, to: NOW - 2 * HOUR});
  await h.advance(S);
  store.dispatch({type: 'board-close'});
  await h.reads[4].fail(new ApiError(400, 'invalid_request'));
  await h.advance(MIN);
  assert.deepEqual([h.dropped(), h.reads.length], [0, 5]);
});

test('news the page hears tells the loader its time: a kept past range it falls in is read again when stepped back to', async () => {
  const h = harness();
  const store = createStore(reduce, INITIAL);
  follow(h.loader, store);
  h.loader.choose('24h', null);
  store.dispatch({type: 'board-open', id: 'b1'});
  store.dispatch({type: 'hub', event: {type: 'snapshot', data: SNAPSHOT}});
  await h.reads[0].answer();
  const range = {from: NOW - 3 * HOUR, to: NOW - 2 * HOUR};
  h.loader.choose('24h', range);
  await h.advance(S);
  await h.reads[1].answer({range: `${range.from}-${range.to}`, to: range.to});
  const back = async () => {
    const reads = h.reads.length;
    h.loader.choose('24h', range);
    await h.advance(S);
    return h.reads.length - reads;
  };
  h.loader.choose('24h', null);
  await h.advance(S);
  // Measurements of a later time than the range: it stays as read.
  store.dispatch({type: 'hub', event: {type: 'history', data: {sources: ['s1'], since: range.to + 30 * MIN}}});
  await h.advance(MIN);
  assert.equal(await back(), 0, 'taken from what was kept');
  h.loader.choose('24h', null);
  await h.advance(S);
  // A machine that was offline delivers measurements of a time inside the range.
  store.dispatch({type: 'hub', event: {type: 'history', data: {sources: ['s1'], since: range.from + 10 * MIN}}});
  await h.advance(MIN);
  assert.equal(await back(), 1, 'read again, not taken from what was kept');
});
