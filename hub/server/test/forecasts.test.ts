import {test} from 'node:test';
import assert from 'node:assert/strict';
import {forecastOf, type Memory} from '../domain/forecast.js';
import type {Win} from '../domain/quota.js';
import {Forecasts, hourShift, told, type Why} from '../forecasts.js';
import {Store} from '../store/store.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 10_080;
/** Monday 2026-09-07 10:00 UTC. */
const T0 = Date.UTC(2026, 8, 7, 10);

type Worked = {source: string; window: string; asOf: number; why: Why};

/** A hub's store with one subscription, and its forecasts on the whole hours (no shift) unless told otherwise. */
function hub(shift: (source: string) => number = () => 0, store = new Store(':memory:', T0 - 60 * DAY)) {
  const worked: Worked[] = [];
  const forecasts = new Forecasts(store, {shift, observe: w => worked.push(w)});
  const source = store.source('claude', 'account-a', T0 - 60 * DAY);
  const measure = (at: number, windows: Win[], staleAfterMs = 3.4 * MIN, plan = 'pro') => store.record(source, {observedAt: at, plan, windows, staleAfterMs, resets: null});
  const read = (now: number) => forecasts.of(source, now);
  return {store, forecasts, worked, source, measure, read};
}
type Hub = ReturnType<typeof hub>;

const weekly = (used: number, resetAt: number | null, change: Partial<Win> = {}): Win => ({
  id: 'weekly',
  kind: 'weekly',
  label: null,
  used,
  remaining: 100 - used,
  resetAt,
  minutes: WEEK,
  ...change,
});
const fable = (used: number, resetAt: number | null) => weekly(used, resetAt, {id: 'weekly:fable', label: 'Fable'});
/** A rolling window not started yet: its reset a week from the moment. */
const idle = (at: number) => weekly(0, at + WEEK * MIN);
const every = (from: number, to: number, step: number) => Array.from({length: Math.floor((to - from) / step) + 1}, (_, i) => from + i * step);

/**
 * Measures at `times` as `windows` has it, reading as a board does: 3 s after each
 * sample, and on every whole hour between them (up to `until` after the last).
 */
function drive(h: Hub, times: number[], windows: (t: number) => Win[], options: {until?: number; stale?: number; look?: (now: number) => void} = {}) {
  const until = options.until ?? times.at(-1)!;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    h.measure(t, windows(t), options.stale);
    h.read(t + 3000);
    options.look?.(t + 3000);
    const next = i + 1 < times.length ? times[i + 1] : until + 1;
    for (let hour = Math.floor(t / HOUR) * HOUR + HOUR; hour < next; hour += HOUR) {
      h.read(hour);
      options.look?.(hour);
    }
  }
}

const count = (worked: Worked[], window = 'weekly', from = -Infinity, to = Infinity) => {
  const by: Partial<Record<Why, number>> = {};
  for (const w of worked) if (w.window === window && w.asOf >= from && w.asOf < to) by[w.why] = (by[w.why] ?? 0) + 1;
  return by;
};
const total = (by: Partial<Record<Why, number>>) => Object.values(by).reduce((sum, n) => sum + n, 0);

/** Steady spending of `rate` %/h in tenths, in weekly windows begun at `start`. */
const steady =
  (rate: number, start = T0) =>
  (t: number): Win[] => {
    const week = start + Math.floor((t - start) / (7 * DAY)) * 7 * DAY;
    return [weekly(Math.min(100, Math.round(((rate * (t - week)) / HOUR) * 10) / 10), week + 7 * DAY)];
  };

// ---------- when a series is worked out ----------

test('a series is worked out once an hour after a sample: reads and samples within the hour change nothing', () => {
  const h = hub();
  const end = T0 + 2 * DAY;
  drive(h, every(T0 + 30_000, end - MIN, 2 * MIN), steady(0.6));
  h.read(end + 10 * MIN);
  const n = h.worked.length;
  assert.equal(h.worked.at(-1)!.why, 'hour');
  const first = h.read(end + 20 * MIN);
  assert.equal(h.worked.length, n, 'a second read works out nothing');
  h.measure(end + 25 * MIN, steady(0.6)(end + 25 * MIN));
  const same = h.read(end + 25 * MIN + 3000);
  assert.equal(h.worked.length, n, 'nor a sample in the same hour');
  assert.deepEqual(same.value, first.value);
  assert.equal(same.value.weekly.asOf, end);
  assert.equal(same.changesAt, end + HOUR);
  const next = h.read(end + HOUR);
  assert.equal(h.worked.at(-1)!.why, 'hour');
  assert.equal(next.value.weekly.asOf, end + HOUR);
  assert.equal(next.changesAt, null, 'nothing new since');
  const m = h.worked.length;
  const later = h.read(end + 3 * HOUR + 1);
  assert.equal(h.worked.length, m, 'hours with no sample work out nothing');
  assert.deepEqual(later.value, next.value);
});

test('a hub that measures nothing more after it starts works each series out once, on the latest sample, whatever the minute', () => {
  for (const minute of [0, 3, 9, 30, 55, 59]) {
    for (const wait of [30_000, 70 * MIN]) {
      // Measured before the board is read, as a stand set up before it opens.
      const h = hub(hourShift);
      const end = T0 + 2 * DAY + minute * MIN;
      const times = every(T0 + 30_000, end, 2 * MIN);
      for (const t of times) h.measure(t, steady(0.6)(t));
      const at = end + wait;
      // As of the last whole hour when the sample came before it, even before the hour of its
      // subscription comes: as a hub running all along has it from then on. A sample in the
      // hour stays as of itself, as after a sample that contradicts a forecast.
      const hour = Math.floor(at / HOUR) * HOUR;
      const first = h.read(at);
      const what = `:${minute}, read ${wait / MIN} min on`;
      assert.deepEqual([first.value.weekly.asOf, first.value.weekly.anchor!.at, first.changesAt], [Math.max(hour, times.at(-1)!), times.at(-1), null], what);
      for (const later of [at + HOUR, at + 2 * HOUR + 11 * MIN, at + DAY]) h.read(later);
      assert.deepEqual(
        h.worked.map(w => w.why),
        ['first'],
        what,
      );
    }
  }
  // Then a sample in the hour it was worked out as of waits for the next hour.
  const h = hub();
  const end = T0 + 2 * DAY - 90_000;
  for (const t of every(T0 + 30_000, end, 2 * MIN)) h.measure(t, steady(0.6)(t));
  assert.equal(h.read(end + 20 * MIN).value.weekly.asOf, T0 + 2 * DAY);
  h.measure(end + 22 * MIN, steady(0.6)(end + 22 * MIN));
  h.read(end + 22 * MIN + 3000);
  h.read(T0 + 3 * DAY);
  assert.deepEqual(
    h.worked.map(w => [w.why, w.asOf]),
    [['first', T0 + 2 * DAY], ['hour', T0 + 3 * DAY]],
  );
});

test('a series with too little history is worked out at every sample, and speaks at the first with an hour of it', () => {
  const h = hub();
  const first = T0 + 3 * DAY + 10 * MIN + 30_000;
  let spoke: number | null = null;
  drive(h, every(first, first + 3 * HOUR, 2 * MIN), t => [weekly((t - first) / HOUR, T0 + 7 * DAY)], {
    look: now => {
      if (spoke === null && h.read(now).value.weekly.state !== 'needData') spoke = now;
    },
  });
  // Its partial cells count at both ends: an hour of history 50 minutes after the first sample, before the whole hour.
  assert.equal(spoke, first + 50 * MIN + 3000);
  assert.equal(h.worked.find(w => w.asOf === first + 50 * MIN)?.why, 'silent');
});

test('a sample that contradicts the forecast has it worked out at once, on the sample', () => {
  const at = (h: Hub, t: number) => {
    const n = h.worked.length;
    h.read(t + 3000);
    const w = h.worked.slice(n);
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.equal(w[0].asOf, t);
    return w[0].why;
  };
  // Back from zero before the reset: the provider corrected itself.
  {
    const h = hub();
    const end = T0 + 52 * HOUR;
    drive(h, every(T0 + 30_000, end, 2 * MIN), t => [weekly(Math.min(100, Math.round(((2 * (t - T0)) / HOUR) * 10) / 10), T0 + 7 * DAY)]);
    assert.equal(h.read(end + 3000).value.weekly.state, 'usedUp');
    h.measure(end + 2 * MIN, [weekly(97, T0 + 7 * DAY)]);
    assert.equal(at(h, end + 2 * MIN), 'revived');
  }
  // A new window, once it has started: a scheduled reset's first sample is still within the tolerance.
  {
    const h = hub();
    const start = T0 - 4 * DAY;
    const reset = T0 + 3 * DAY;
    drive(h, every(T0 + 30_000, reset - 90_000, 2 * MIN), steady(0.4, start));
    h.read(reset);
    h.measure(reset + 30_000, [weekly(0, reset + 7 * DAY)]);
    const n = h.worked.length;
    h.read(reset + 33_000);
    assert.equal(h.worked.length, n, 'not started yet: no news');
    h.measure(reset + 150_000, [weekly(0, reset + 7 * DAY)]);
    assert.equal(at(h, reset + 150_000), 'newWindow');
  }
  // The used share dropping within the same window.
  {
    const h = hub();
    const end = T0 + 2 * DAY + 20 * MIN + 30_000;
    drive(h, every(T0 + 30_000, end, 2 * MIN), steady(0.6));
    h.measure(end + 2 * MIN, [weekly(10, T0 + 7 * DAY)]);
    assert.equal(at(h, end + 2 * MIN), 'drop');
  }
  // The moment shown has come, a sample at that very moment, and something is left. First read on the hour's first sample: nothing shown before to hold.
  {
    const h = hub();
    const hour = T0 + 66 * HOUR;
    const used = (t: number) => [weekly(Math.min(99, (1.5 * (t - T0)) / HOUR), T0 + 7 * DAY)];
    for (const t of every(T0 + 30_000, hour, 2 * MIN)) h.measure(t, used(t));
    drive(h, every(hour + 30_000, hour + 38 * MIN + 30_000, 2 * MIN), used);
    const shown = h.read(hour + 39 * MIN).value.weekly;
    assert.equal(shown.state, 'runsOut');
    assert.equal(shown.asOf, hour + 30_000);
    assert.ok(Math.abs(shown.shownZero! - (hour + 40 * MIN)) < MIN, String(shown.shownZero! - hour));
    h.measure(shown.shownZero!, [weekly(99, T0 + 7 * DAY)]);
    assert.equal(at(h, shown.shownZero!), 'refuted');
  }
  // The first sample after an hour or more without one.
  {
    const h = hub();
    const sleep = T0 + 2 * DAY + 20 * MIN + 30_000;
    drive(h, every(T0 + 30_000, sleep, 2 * MIN), steady(0.6), {until: sleep + 70 * MIN - 1});
    h.measure(sleep + 70 * MIN, steady(0.6)(sleep + 70 * MIN));
    assert.equal(at(h, sleep + 70 * MIN), 'gap');
  }
});

test('a pause shorter than an hour waits for the hour, however short the samples were said to last', () => {
  const h = hub();
  // The pause begins with the sample the hour's forecast stands on.
  const pause = T0 + 2 * DAY - 90_000;
  drive(h, every(T0 + 30_000, pause, 2 * MIN), steady(0.6), {until: pause + 30 * MIN - 1});
  assert.equal(h.read(pause + 2 * MIN).value.weekly.anchor!.at, pause);
  const n = h.worked.length;
  h.measure(pause + 30 * MIN, steady(0.6)(pause + 30 * MIN));
  h.read(pause + 30 * MIN + 3000);
  assert.equal(h.worked.length, n);
});

test('what does not contradict the forecast waits for the hour: a correction of a few points, a pause no longer than samples last', () => {
  // The used share a few points lower in the same window: the provider correcting itself.
  {
    const h = hub();
    const end = T0 + 2 * DAY + 20 * MIN + 30_000;
    drive(h, every(T0 + 30_000, end, 2 * MIN), steady(0.6));
    const n = h.worked.length;
    h.measure(end + 2 * MIN, [weekly(steady(0.6)(end)[0].used - 4, T0 + 7 * DAY)]);
    h.read(end + 2 * MIN + 3000);
    assert.equal(h.worked.length, n);
  }
  // More than an hour between samples said to last longer still: the hour's forecast, not a gap.
  {
    const h = hub();
    const pause = T0 + 2 * DAY - 90_000;
    const stale = 2.4 * HOUR;
    drive(h, every(T0 + 30_000, pause, 2 * MIN), steady(0.6), {stale, until: pause + 70 * MIN - 1});
    const n = h.worked.length;
    h.measure(pause + 70 * MIN, steady(0.6)(pause + 70 * MIN), stale);
    h.read(pause + 70 * MIN + 3000);
    assert.deepEqual(
      h.worked.slice(n).map(w => w.why),
      ['hour'],
    );
  }
});

test('after a gap nobody read through, the hour worked out on the sample before it is checked again', () => {
  const h = hub();
  const hour = T0 + 2 * DAY;
  const sleep = hour + 20 * MIN + 30_000;
  drive(h, every(T0 + 30_000, sleep, 2 * MIN), steady(0.6));
  // Nothing reads while the laptop sleeps (the hub slept with it).
  const wake = sleep + 70 * MIN;
  h.measure(wake, steady(0.6)(wake));
  const n = h.worked.length;
  const f = h.read(wake + 3000).value.weekly;
  assert.deepEqual(
    h.worked.slice(n).map(w => w.why),
    ['hour', 'gap'],
  );
  assert.equal(f.asOf, wake);
  assert.equal(f.anchor!.at, wake);
});

test('a rolling window not started yet moves its reset at every sample, and that is no news', () => {
  for (const history of [0, 6.5]) {
    const h = hub();
    const until = T0 + history * DAY;
    const samples = history ? every(T0 + 30_000, until - 1, 10 * MIN) : [];
    const rate = (t: number) => [weekly(Math.min(100, Math.round(((0.8 * (t - T0)) / HOUR) * 10) / 10), T0 + 7 * DAY)];
    drive(h, [...samples, ...every(until + 30_000, until + 2 * DAY, 10 * MIN)], t => (t < until ? rate(t) : [idle(t)]), {stale: 19 * MIN, until: until + 2 * DAY + 10 * MIN});
    assert.deepEqual(count(h.worked, 'weekly', until + 30_000), history ? {revived: 1, hour: 48} : {first: 1, hour: 48}, `history ${history} d`);
  }
});

test('a new subscription idle for hours is worked out on the hour until its first use, and speaks 44 minutes after it', () => {
  const h = hub();
  const go = Date.UTC(2026, 8, 14, 9, 7);
  const times = [...every(go - 16 * HOUR, go - 1, 15 * MIN), ...every(go, go + 3 * HOUR, 2 * MIN)];
  let spoke: number | null = null;
  drive(h, times, t => (t < go ? [idle(t)] : [weekly(Math.floor((t - go) / HOUR), go + WEEK * MIN)]), {
    look: now => {
      const state = h.read(now).value.weekly.state;
      if (now >= go && spoke === null && (state === 'lasts' || state === 'runsOut')) spoke = now;
    },
  });
  assert.equal(total(count(h.worked, 'weekly', -Infinity, go)), 17);
  assert.equal(spoke, go + 44 * MIN + 3000);
});

test('a series whose cells cannot count waits for the hour: its own window at zero, or a model\'s under the weekly at zero', () => {
  const connected = Date.UTC(2026, 8, 8, 0, 7);
  const reset = Date.UTC(2026, 8, 11);
  const run = (windows: (t: number) => Win[], window: string) => {
    const h = hub();
    let spoke: number | null = null;
    let before = 0;
    drive(h, every(connected, reset - 1, 15 * MIN), windows, {
      until: reset,
      stale: 30 * MIN,
      look: now => {
        if (now < reset) before = total(count(h.worked, window));
        if (spoke === null && h.read(now).value[window].state !== 'needData') spoke = now;
      },
    });
    return {before, all: total(count(h.worked, window)), spoke: spoke === null ? null : (spoke - connected) / MIN};
  };
  const underWeekly = (earlier: number) => () => [weekly(100, reset - earlier), fable(40, reset)];
  assert.deepEqual(run(underWeekly(0), 'weekly:fable'), {before: 72, all: 73, spoke: null});
  assert.deepEqual(run(underWeekly(30_000), 'weekly:fable'), {before: 72, all: 73, spoke: null});
  assert.deepEqual(run(() => [weekly(99.7, reset)], 'weekly'), {before: 72, all: 73, spoke: null});
  // A weekly at zero that resets sooner leaves the model's window counting: it speaks at the first sample with an hour of it.
  for (const earlier of [90_000, 2 * HOUR]) assert.equal(run(underWeekly(earlier), 'weekly:fable').spoke, 45 + 3000 / MIN);
});

test('a window whose card gives the answer is not worked out at every sample: none without a reset time, waiting for a sample after one', () => {
  const from = T0 + 30_000;
  for (const window of [weekly(40, null, {minutes: null}), weekly(40, T0 - HOUR)]) {
    const h = hub();
    for (const t of every(from, from + 6 * HOUR - 1, 2 * MIN)) {
      h.measure(t, [window]);
      h.read(t + 3000);
    }
    assert.equal(total(count(h.worked)), 6, JSON.stringify(window));
  }
});

test('a window that lost its reset time for an hour is worked out again at the first sample that has one', () => {
  const h = hub();
  const lost = T0 + 3 * DAY + 5 * HOUR + 10 * MIN + 30_000;
  const back = lost + 70 * MIN;
  drive(h, every(T0 + 30_000, back - 1, 2 * MIN), t => {
    const [w] = steady(0.6)(t);
    return [t >= lost ? {...w, resetAt: null} : w];
  });
  assert.equal(h.read(back - 1).value.weekly.state, 'none');
  h.measure(back, steady(0.6)(back));
  const n = h.worked.length;
  assert.notEqual(h.read(back + 3000).value.weekly.state, 'none');
  assert.deepEqual(
    h.worked.slice(n).map(w => [w.why, w.asOf]),
    [['silent', back]],
  );
});

test('a window started a minute before the hour is news to a forecast that stands on it not started', () => {
  const h = hub();
  const reset = Date.UTC(2026, 8, 8, 0, 13, 30);
  const use = Date.UTC(2026, 8, 9, 19, 59);
  const times = [...every(Date.UTC(2026, 8, 7, 0, 0, 30), use - 1, 15 * MIN), ...every(use + 30_000, use + 70 * MIN, 2 * MIN)];
  const said: string[] = [];
  drive(
    h,
    times,
    t => (t < reset ? [weekly(100, reset)] : t < use ? [idle(t)] : [weekly(Math.floor((t - use) / HOUR), use + WEEK * MIN)]),
    {
      look: now => {
        if (now < use) return;
        const f = h.read(now).value.weekly;
        const word = f.state === 'lasts' ? (f.comfy ? `left ${f.shownLeft}` : 'pace') : f.state;
        if (said.at(-1)?.split(' ').slice(1).join(' ') !== word) said.push(`${new Date(now).toISOString().slice(11, 19)} ${word}`);
      },
    },
  );
  // Before, on the window not started, the board shows it idle whatever the forecast says.
  assert.deepEqual(said, ['19:59:33 left 100', '20:01:33 needData', '20:41:33 pace', '21:00:00 runsOut']);
});

// ---------- what a series reads ----------

test("a model's window counts only while its subscription's weekly, the window without a label, is not at zero", () => {
  const reset = T0 + 7 * DAY;
  const zero = (t: number) => t >= T0 + 2 * DAY && t < T0 + 2 * DAY + 10 * HOUR;
  // Claude: the weekly and a model's window reset together.
  {
    const h = hub();
    drive(h, every(T0, T0 + 3 * DAY, 10 * MIN), t => [weekly(zero(t) ? 100 : 50, reset), fable((0.2 * (t - T0)) / HOUR, reset)]);
    assert.equal(h.read(T0 + 3 * DAY + 1).value['weekly:fable'].basis!.hours, 62);
  }
  // Antigravity: every window labelled, none of them the subscription's weekly.
  {
    const h = hub();
    const gemini = (used: number) => weekly(used, reset, {id: 'gemini:weekly', label: 'Gemini'});
    const claude = (used: number) => weekly(used, reset, {id: 'claude:weekly', label: 'Claude'});
    drive(h, every(T0, T0 + 3 * DAY, 10 * MIN), t => [gemini(zero(t) ? 100 : 50), claude((0.2 * (t - T0)) / HOUR)]);
    assert.equal(h.read(T0 + 3 * DAY + 1).value['claude:weekly'].basis!.hours, 72);
  }
});

test('a plan held for an hour starts the history anew: a day with no word of "left"', () => {
  const h = hub();
  const change = T0 + 3 * DAY;
  const times = every(T0 + 30_000, change + 2 * HOUR, 10 * MIN);
  for (const t of times.filter(t => t < change)) h.measure(t, steady(0.2)(t), 3.4 * MIN, 'pro');
  const before = h.read(change - MIN).value.weekly;
  assert.equal(before.comfy, true);
  for (const t of times.filter(t => t >= change)) h.measure(t, steady(0.2)(t), 3.4 * MIN, 'max');
  const after = h.read(change + 2 * HOUR).value.weekly;
  assert.equal(after.state, 'lasts');
  assert.equal(after.comfy, false);
  assert.equal((after.basis as {cold: boolean}).cold, true);
});

// ---------- memory ----------

/** A week's window spending `rate` %/h in tenths, sampled every 10 minutes from T0 on. */
const tenMinutes = (rate: number) => (t: number) => [weekly(Math.round(((rate * (t - T0)) / HOUR) * 10) / 10, T0 + 7 * DAY)];
const out = (Z: number | null = null): Memory => ({win: T0 + 7 * DAY, out: true, Z, X: null, comfy: false});

test('"runs out" is held from one hour to the next', () => {
  const store = new Store(':memory:', T0 - 60 * DAY);
  const h = hub(undefined, store);
  const hour = T0 + 4 * DAY;
  for (const t of every(T0 + 30_000, hour, 10 * MIN)) h.measure(t, tenMinutes(0.59)(t));
  // It ran out the hour before, as the hub kept it.
  store.keep([[`forecast:${h.source}:weekly`, JSON.stringify({asOf: hour - HOUR, memoryIn: null, memoryOut: out()})]]);
  const f = h.read(hour + 1).value.weekly;
  assert.equal(f.state, 'runsOut');
  assert.ok(f.F! > 0 && f.F! <= 2, String(f.F));
  for (const t of every(hour + 10 * MIN, hour + HOUR, 10 * MIN)) h.measure(t, tenMinutes(0.59)(t));
  const g = h.read(hour + HOUR + 1).value.weekly;
  assert.equal(g.asOf, hour + HOUR);
  assert.equal(g.state, 'runsOut');
});

test('a sample come late for the moment a forecast stands on works it out again with the memory it was worked out with', () => {
  const store = new Store(':memory:', T0 - 60 * DAY);
  const h = hub(undefined, store);
  const hour = T0 + 4 * DAY;
  const samples = every(T0 + 30_000, hour, 10 * MIN);
  for (const t of samples) h.measure(t, tenMinutes(0.575)(t));
  const memoryIn = out();
  store.keep([[`forecast:${h.source}:weekly`, JSON.stringify({asOf: hour, memoryIn, memoryOut: null})]]);
  const f = h.read(hour + 5000).value.weekly;
  assert.equal(f.asOf, hour);
  assert.equal(f.state, 'lasts', 'more than a little is left: not held');
  // Another device's sample of a minute before the hour, 1% more spent.
  const late = hour - MIN;
  h.measure(late, [weekly(tenMinutes(0.575)(late)[0].used + 1, T0 + 7 * DAY)]);
  const n = h.worked.length;
  const g = h.read(hour + 10_000).value.weekly;
  assert.deepEqual(
    h.worked.slice(n).map(w => [w.why, w.asOf]),
    [['late', hour]],
  );
  const samplesRead = h.store.seriesSamples(h.source, 'weekly', hour - 23 * DAY, hour);
  const pure = forecastOf({samples: samplesRead, plan: null, since: null}, hour, memoryIn).forecast;
  assert.ok(pure.F! > -5 && pure.F! <= 2, String(pure.F));
  assert.equal(g.state, 'runsOut');
  assert.equal(g.state, pure.state);
  assert.equal(g.F, pure.F);
});

test('a sample that contradicts a forecast works it out again from the memory that forecast left, not the one it went in with', () => {
  const store = new Store(':memory:', T0 - 60 * DAY);
  const h = hub(undefined, store);
  const key = `forecast:${h.source}:weekly`;
  const hour = T0 + 4 * DAY;
  for (const t of every(T0 + 30_000, hour, 10 * MIN)) h.measure(t, tenMinutes(0.575)(t));
  // Worked out on the hour going in "runs out", it came out lasting: the two memories differ.
  store.keep([[key, JSON.stringify({asOf: hour, memoryIn: out(), memoryOut: null})]]);
  assert.equal(h.read(hour + 5000).value.weekly.state, 'lasts');
  h.forecasts.save();
  const left: Memory = JSON.parse(store.kept(key)!).memoryOut;
  assert.equal(left.out, false);
  // The first sample after more than an hour, a point more spent.
  const wake = hour + 70 * MIN;
  h.measure(wake, [weekly(tenMinutes(0.575)(wake)[0].used + 1, T0 + 7 * DAY)]);
  const n = h.worked.length;
  const g = h.read(wake + 3000).value.weekly;
  assert.deepEqual(
    h.worked.slice(n).map(w => w.why),
    ['gap'],
  );
  const samples = h.store.seriesSamples(h.source, 'weekly', wake - 23 * DAY, wake);
  const pure = (memory: Memory) => forecastOf({samples, plan: null, since: null}, wake, memory).forecast;
  assert.notEqual(pure(out()).state, pure(left).state, 'the two memories tell apart here');
  // As the hub tells it: points by minutes from the anchor, moments in whole milliseconds.
  assert.deepEqual(g, told(pure(left)));
});

test('a restarted hub goes on from what it kept, else from the latest sample: never from the hour before it', () => {
  const store = new Store(':memory:', T0 - 60 * DAY);
  const h = hub(undefined, store);
  const first = T0 + 3 * DAY + 10 * MIN + 30_000;
  const spoke = first + 50 * MIN;
  const used = (t: number) => [weekly((t - first) / HOUR, T0 + 7 * DAY)];
  drive(h, every(first, spoke, 2 * MIN), used);
  assert.equal(h.read(spoke + 3000).value.weekly.asOf, spoke);
  h.forecasts.save();
  // Nothing measured since what it kept: that, as it was, however many hours later.
  const same = hub(undefined, store);
  const kept = same.read(spoke + 10 * MIN).value.weekly;
  assert.deepEqual([kept.asOf, kept.state], [spoke, 'lasts']);
  const late = hub(undefined, store);
  assert.deepEqual(late.read(spoke + 2 * HOUR + 17 * MIN).value.weekly, kept);
  assert.deepEqual(late.worked.map(w => [w.why, w.asOf]), [['first', spoke]]);
  // Measured since: on the latest sample, and nothing more until a sample after the next hour.
  for (const t of every(spoke + 2 * MIN, spoke + 30 * MIN, 2 * MIN)) h.measure(t, used(t));
  const again = hub(undefined, store);
  const f = again.read(spoke + 30 * MIN + 3000);
  assert.deepEqual([f.value.weekly.asOf, f.value.weekly.state, f.changesAt], [spoke + 30 * MIN, 'lasts', null]);
  assert.deepEqual(
    again.worked.map(w => w.why),
    ['first'],
  );
  // Worked out on the hour after its last sample: after a restart, that same forecast.
  const other = new Store(':memory:', T0 - 60 * DAY);
  const g = hub(undefined, other);
  const end = T0 + 2 * DAY - 90_000;
  drive(g, every(T0 + 30_000, end, 2 * MIN), steady(0.6), {until: end + 10 * MIN});
  const before = g.read(end + 10 * MIN).value;
  assert.equal(before.weekly.asOf, T0 + 2 * DAY);
  g.forecasts.save();
  assert.deepEqual(hub(undefined, other).read(end + 20 * MIN).value, before);
});

test('a series that fails is none and failed, alone, until the next hour, and keeps nothing', () => {
  const h = hub();
  const original = h.store.seriesSamples.bind(h.store);
  h.store.seriesSamples = (source, window, from, to) => {
    if (window === 'weekly:fable') throw new Error('a broken series');
    return original(source, window, from, to);
  };
  const error = console.error;
  const logged: string[] = [];
  console.error = (line: string) => void logged.push(line);
  try {
    const reset = T0 + 7 * DAY;
    drive(h, every(T0 + 30_000, T0 + 3 * HOUR, 2 * MIN), t => [weekly((0.5 * (t - T0)) / HOUR, reset), fable((0.3 * (t - T0)) / HOUR, reset)]);
    const {value} = h.read(T0 + 3 * HOUR + 3000);
    assert.equal(value['weekly:fable'].state, 'none');
    assert.equal(value['weekly:fable'].failed, true);
    assert.notEqual(value.weekly.state, 'none');
    assert.deepEqual(count(h.worked, 'weekly:fable'), {first: 1, hour: 3});
    assert.equal(logged.length, 4, 'told once each time it was tried');
    h.forecasts.save();
    assert.equal(h.store.kept(`forecast:${h.source}:weekly:fable`), null);
    assert.ok(h.store.kept(`forecast:${h.source}:weekly`));
  } finally {
    console.error = error;
  }
});

// ---------- the hour of each subscription ----------

test("a subscription's forecasts are worked out a while after the hour, the same while every hour", () => {
  const shift = hourShift('claude:0123456789ab');
  assert.equal(shift, hourShift('claude:0123456789ab'));
  assert.ok(shift >= 0 && shift < 10 * MIN);
  const shifts = new Set(Array.from({length: 20}, (_, i) => hourShift(`codex:${i.toString(16).padStart(12, '0')}`)));
  assert.ok(shifts.size > 10, 'spread over the ten minutes');
  const h = hub(() => 7 * MIN);
  const hour = T0 + 2 * DAY;
  drive(h, every(T0 + 30_000, hour + 20 * MIN, 2 * MIN), steady(0.6), {until: hour + 20 * MIN});
  // The whole hours the drive read were worked out 7 minutes late, each as of its hour.
  const n = h.worked.length;
  const at = h.read(hour + HOUR + 7 * MIN - 1);
  assert.equal(h.worked.length, n);
  assert.equal(at.value.weekly.asOf, hour);
  assert.equal(at.changesAt, hour + HOUR + 7 * MIN);
  const after = h.read(hour + HOUR + 7 * MIN);
  assert.equal(after.value.weekly.asOf, hour + HOUR);
});
