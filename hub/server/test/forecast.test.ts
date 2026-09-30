import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {forecastOf, planSince, type Basis, type ForecastInput, type Memory, type SeriesForecast, type SeriesSample} from '../domain/forecast.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A weekly window's length in minutes. */
const WEEK = 10_080;
/** Monday 2026-09-07 00:00 UTC. */
const T0 = Date.UTC(2026, 8, 7);

type Value = {used: number; resetAt: number | null};

/** Samples every `step` from `from` up to `to`, weekly windows, each as `value` has it. */
function sampled(from: number, to: number, step: number, value: (t: number) => Value): SeriesSample[] {
  const samples: SeriesSample[] = [];
  for (let at = from; at <= to; at += step) samples.push({at, minutes: WEEK, ...value(at)});
  return samples;
}

/** A rolling window not started yet: nothing used, its reset a week after now. */
const unstarted = (t: number): Value => ({used: 0, resetAt: t + WEEK * MINUTE});

/** Spending `rate(t)` %/h through weekly resets at `firstReset` and every week after it, sampled every `step`; used starts at `after` in each new window. */
function spending(from: number, to: number, step: number, rate: (t: number) => number, firstReset: number, after = 0): SeriesSample[] {
  const samples: SeriesSample[] = [];
  let used = 0;
  let resetAt = firstReset;
  let previous = from;
  for (let at = from; at <= to; at += step) {
    while (at >= resetAt) {
      resetAt += 7 * DAY;
      used = after;
    }
    used = Math.min(100, used + (rate(previous) * (at - previous)) / HOUR);
    previous = at;
    samples.push({at, used, resetAt, minutes: WEEK});
  }
  return samples;
}

const forecast = (samples: SeriesSample[], asOf: number, memory: Memory | null = null, input: Partial<ForecastInput> = {}) =>
  forecastOf({samples, plan: null, since: null, ...input}, asOf, memory);
const at = (samples: SeriesSample[], moment: number) => samples.filter(s => s.at <= moment);
const lastAt = (samples: SeriesSample[], moment: number) => at(samples, moment).at(-1)!.at;
/** The forecast at the last sample up to `moment`, from the samples up to it. */
const upTo = (samples: SeriesSample[], moment: number, memory: Memory | null = null) => forecast(at(samples, moment), lastAt(samples, moment), memory).forecast;
const hoursOf = (f: SeriesForecast) => f.basis!.hours;
const basisOf = (f: SeriesForecast) => f.basis as Basis;
const near = (actual: number | null, expected: number, tolerance = 0.006) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected} ± ${tolerance}`);

// ---------- golden cases ----------

type Golden = {
  id: string;
  t: string;
  memoryIn: Memory | null;
  expected: {state: string; F: number | null; zero: string | null; shownZero: string | null; shownLeft: number | null; hours: number | null};
  memoryOut: Omit<Memory, 'comfy'>;
  samples: [number, number, number, number][];
};
const golden = JSON.parse(readFileSync(new URL('./fixtures/forecast-golden.json', import.meta.url), 'utf8')) as {cases: Golden[]};
const moment = (iso: string | null) => (iso === null ? null : Date.parse(iso));
const sameMoment = (actual: number | null, expected: number | null) =>
  (actual === null && expected === null) || (actual !== null && expected !== null && Math.abs(actual - expected) <= MINUTE);

test('the golden cases of the reference come out the same', () => {
  assert.equal(golden.cases.length, 28);
  let lasting = 0;
  for (const c of golden.cases) {
    const samples = c.samples.map(([at, used, resetAt, minutes]) => ({at: at * MINUTE, used, resetAt: resetAt * MINUTE, minutes}));
    const {forecast: f, memory} = forecast(samples, Date.parse(c.t), c.memoryIn);
    const x = c.expected;
    const lasts = x.state === 'pace' || x.state === 'left';
    assert.equal(f.state, lasts ? 'lasts' : x.state, c.id);
    if (x.F !== null) near(f.F, x.F, 0.01);
    assert.ok(sameMoment(f.zero, moment(x.zero)), `${c.id}: zero`);
    assert.ok(sameMoment(f.shownZero, moment(x.shownZero)), `${c.id}: shownZero`);
    assert.equal(f.shownLeft, lasts ? c.memoryOut.X : x.shownLeft, `${c.id}: shownLeft`);
    if (x.hours === null) assert.equal(f.basis, null, c.id);
    else near(hoursOf(f), x.hours, 1e-9);
    const out = c.memoryOut;
    assert.ok(memory && memory.win === out.win && memory.out === out.out && memory.X === out.X && sameMoment(memory.Z, out.Z), `${c.id}: memory`);
    // The golden memory knows no `comfy`: "left" is then F against its band, as the reference said it.
    if (lasts) {
      lasting++;
      assert.equal(f.comfy && f.shownLeft! >= 5, x.state === 'left', `${c.id}: left or just enough`);
    }
  }
  assert.equal(lasting, 11);
});

// ---------- windows and cells ----------

test('a rolling window not started yet is idle time, not a new window at every sample', () => {
  const end = T0 + DAY;
  const go = T0 + 3 * DAY;
  const samples = sampled(T0 + 30_000, go + 10 * HOUR, 15 * MINUTE, t =>
    t < end ? {used: 60 + (t - T0) / HOUR, resetAt: end} : t < go ? unstarted(t) : {used: (t - go) / HOUR, resetAt: go + WEEK * MINUTE},
  );
  near(hoursOf(upTo(samples, go + 10 * HOUR)), 81.67);
});

test('the time between the last sample before a reset and the start of the new window, when longer than a cell, is not known', () => {
  const R = T0 + 7 * DAY;
  const samples = [...sampled(T0, R - 3 * HOUR, 10 * MINUTE, t => ({used: (0.5 * (t - T0)) / HOUR, resetAt: R})), {at: R + 2 * HOUR, used: 2, resetAt: R + 7 * DAY, minutes: WEEK}];
  assert.equal(hoursOf(forecast(samples, R + 2 * HOUR).forecast), 167);
});

test('a sample past the reset of the one before is of a new window, however far its own reset moved', () => {
  // Weekly windows on a schedule; the device was off for 8 days across a reset.
  const s0 = T0 - 30 * DAY;
  const value = (t: number): Value => {
    const start = s0 + Math.floor((t - s0) / (7 * DAY)) * 7 * DAY;
    return {used: Math.floor((0.5 * (t - start)) / HOUR), resetAt: start + 7 * DAY};
  };
  const samples = [...sampled(s0, T0 - 12 * DAY, 10 * MINUTE, value), ...sampled(T0 - 4 * DAY, T0, 10 * MINUTE, value)];
  assert.equal(hoursOf(forecast(samples, T0).forecast), 648);
});

test('a reset time that went back leaves the spending of its pairs unknown', () => {
  const R = T0 + 7 * DAY;
  const clean = sampled(T0 + HOUR, T0 + 4 * DAY, 10 * MINUTE, t => ({used: (0.5 * (t - T0 - HOUR)) / HOUR, resetAt: R}));
  const back = clean.map(s => (s.at === T0 + 3 * DAY ? {...s, resetAt: R - 2 * HOUR} : s));
  const asOf = T0 + 4 * DAY;
  const F = forecast(clean.filter(s => s.at !== T0 + 3 * DAY), asOf).forecast.F!;
  near(F, 16.5, 0.05);
  near(forecast(back, asOf).forecast.F, F, 0.05);
});

test('a sample without a reset time in the middle of a series changes nothing', () => {
  const samples = sampled(T0, T0 + 3 * DAY, 10 * MINUTE, t => ({used: (0.5 * (t - T0)) / HOUR, resetAt: T0 + 7 * DAY}));
  const blank = samples.map(s => (s.at === T0 + 2 * DAY + 3 * HOUR ? {...s, resetAt: null} : s));
  const without = forecast(samples.filter(s => s.at !== T0 + 2 * DAY + 3 * HOUR), T0 + 3 * DAY).forecast;
  const f = forecast(blank, T0 + 3 * DAY).forecast;
  assert.equal(f.state, without.state);
  assert.equal(f.F, without.F);
  assert.equal(hoursOf(f), 72);
  assert.equal(hoursOf(without), 72);
});

test('a plan change starts the history anew: a cold series, never "left"', () => {
  const samples = sampled(T0, T0 + 3 * DAY, 10 * MINUTE, t => ({used: (0.2 * (t - T0)) / HOUR, resetAt: T0 + 7 * DAY}));
  const since = T0 + 2.5 * DAY;
  const f = forecast(samples, T0 + 3 * DAY, null, {since}).forecast;
  assert.equal(hoursOf(f), 12);
  assert.equal(basisOf(f).cold, true);
  assert.equal(f.state, 'lasts');
  assert.equal(f.comfy, false);
  // Without the change the same spending leaves plenty.
  assert.equal(forecast(samples, T0 + 3 * DAY).forecast.comfy, true);
});

test('after a plan change the series is as young as the change: its history begins with its first use', () => {
  const s0 = T0 - 40 * DAY;
  const since = T0 + 2 * DAY;
  const R = T0 + 3 * DAY + 19 * HOUR;
  const go = R + 20 * HOUR;
  const all = sampled(s0, go + 2 * HOUR, 2 * MINUTE, t => {
    if (t < since) {
      const start = s0 + Math.floor((t - s0) / (7 * DAY)) * 7 * DAY;
      return {used: Math.min(100, Math.floor((t - start) / HOUR)), resetAt: start + 7 * DAY};
    }
    if (t < R) return {used: 100, resetAt: R};
    if (t < go) return unstarted(t);
    return {used: Math.floor((t - go) / HOUR), resetAt: go + WEEK * MINUTE};
  });
  // What the hub reads: 23 days back and the last sample before.
  const read = (moment: number) => {
    const asOf = lastAt(all, moment);
    const first = all.findIndex(s => s.at >= asOf - 23 * DAY);
    return {samples: all.slice(Math.max(0, first - 1)).filter(s => s.at <= asOf), asOf};
  };
  const early = read(go + 30 * MINUTE);
  const f = forecast(early.samples, early.asOf, null, {since}).forecast;
  assert.equal(f.state, 'needData');
  near(hoursOf(f), 0.5);
  const later = read(go + 70 * MINUTE);
  const g = forecast(later.samples, later.asOf, null, {since}).forecast;
  assert.equal(g.state, 'runsOut');
  near(g.F, -44);
});

test("a model's window does not count while the subscription's weekly is used up and resets no earlier", () => {
  const R = T0 + 7 * DAY;
  const samples = sampled(T0, T0 + 3 * DAY, 10 * MINUTE, t => ({used: (0.2 * (t - T0)) / HOUR, resetAt: R}));
  const weekly = (shift: number, zero = 100) =>
    sampled(T0, T0 + 3 * DAY, 10 * MINUTE, t => ({used: t >= T0 + 2 * DAY && t < T0 + 2 * DAY + 10 * HOUR ? zero : 50, resetAt: R + shift}));
  const hours = (shift: number, zero?: number) => hoursOf(forecast(samples, T0 + 3 * DAY, null, {plan: weekly(shift, zero)}).forecast);
  assert.equal(hours(0), 62);
  assert.equal(hours(-30_000), 62);
  assert.equal(hours(DAY), 62);
  assert.equal(hours(-DAY), 72);
  // At zero from 99.5: Claude tells its share in fractions.
  assert.equal(hours(0, 99.7), 62);
  assert.equal(hours(0, 99.4), 72);
});

// ---------- speaking ----------

test('a new series speaks an hour after its first sample, whatever the minute, leaning on the mean of a window begun before it', () => {
  for (const [minute, F] of [
    [0.5, 93.98],
    [10.5, 94.0],
    [30, 93.99],
    [55, 94.05],
  ]) {
    const first = T0 + 3 * DAY + minute * MINUTE;
    const samples = sampled(first, first + 62 * MINUTE, 2 * MINUTE, t => ({used: (t - first) / HOUR, resetAt: T0 + 7 * DAY}));
    const f = upTo(samples, samples.find(s => s.at >= first + HOUR)!.at);
    assert.equal(f.state, 'lasts', `:${minute}`);
    near(f.F, F);
  }
  const first = T0 + 3 * DAY + 30_000;
  const samples = sampled(first, first + 50 * MINUTE, 2 * MINUTE, t => ({used: (t - first) / HOUR, resetAt: T0 + 7 * DAY}));
  const f = upTo(samples, first + 50 * MINUTE);
  assert.equal(f.state, 'lasts');
  near(hoursOf(f), 1);
});

test('the straight line of a new series runs up to its last sample', () => {
  for (const [minute, after, F] of [
    [0.5, 50, -69.17],
    [55, 60, -188.57],
  ]) {
    const first = Date.UTC(2026, 8, 7, 10) + minute * MINUTE;
    const start = first - HOUR;
    const samples = sampled(first, first + after * MINUTE, 2 * MINUTE, t => ({used: Math.floor((2 * (t - start)) / HOUR), resetAt: start + 7 * DAY}));
    const f = upTo(samples, first + after * MINUTE);
    assert.equal(f.state, 'runsOut', `:${minute}`);
    near(f.F, F);
  }
});

// ---------- the pace ----------

/** Fourteen days of 0.5 %/h, then six hours at `k` times that. */
function burstSeries({k = 3, reset = T0 + 3 * DAY, counted = 6}: {k?: number; reset?: number; counted?: number}) {
  const top = T0 + 14 * DAY + 12 * HOUR;
  const from = top - 6 * HOUR;
  const rate = (t: number) => (t >= from ? 0.5 * k : 0.5);
  let samples = spending(T0, top, 10 * MINUTE, rate, reset);
  if (counted < 6) {
    // The window at zero for the first hours of the burst, then a free reset.
    const back = from + (6 - counted) * HOUR;
    let used = 0;
    let previous = back;
    samples = samples.map(s => {
      if (s.at < from) return s;
      if (s.at < back) return {...s, used: 100};
      used += (rate(previous) * (s.at - previous)) / HOUR;
      previous = s.at;
      return {...s, used, resetAt: back + 7 * DAY};
    });
  }
  return basisOf(forecast(samples, top).forecast).burst;
}

test('a burst: six hours at least twice the usual for them that would run out before the reset', () => {
  const burst = burstSeries({k: 3});
  assert.ok(burst && Math.abs(burst.times - 3) < 0.1, JSON.stringify(burst));
  assert.equal(burstSeries({k: 1.5}), null);
  // Running out at that pace only after the reset.
  assert.equal(burstSeries({k: 3, reset: T0 + 18 * HOUR}), null);
  // Two of the six hours counted: the window was at zero in the others.
  assert.equal(burstSeries({k: 3, counted: 2}), null);
});

test('no burst for a cold series, nor after a week of nothing', () => {
  const cold = spending(T0 + HOUR, T0 + 24 * HOUR, 10 * MINUTE, t => (t >= T0 + 18 * HOUR ? 1.5 : 0.5), T0 + 7 * DAY);
  const f = forecast(cold, T0 + 24 * HOUR).forecast;
  assert.equal(hoursOf(f), 23);
  assert.equal(basisOf(f).burst, null);
  const R = T0 + 7 * DAY;
  const idle = spending(T0 - 14 * DAY, R + 6 * HOUR, 10 * MINUTE, t => (t >= T0 && t < R ? 0 : t >= R ? 5 : 0.5), T0 - 7 * DAY);
  assert.equal(basisOf(forecast(idle, R + 6 * HOUR).forecast).burst, null);
});

test("an hour's usual is at least the average hour: a little spending in a quiet evening is no burst", () => {
  const end = T0 + 8 * DAY + 22 * HOUR;
  const office = (t: number) => {
    const hour = Math.floor(t / HOUR) % 24;
    return (hour >= 8 && hour < 17 ? 0.9 : 0) + (t > end - 5 * HOUR ? 0.5 : 0);
  };
  const samples = spending(T0, end, 10 * MINUTE, office, T0 + 7 * DAY, 80);
  assert.equal(basisOf(forecast(samples, end).forecast).burst, null);
});

test('the last day against the usual is the level of the shape of the day alone', () => {
  const doubled = (days: number, base: (t: number) => number) => {
    const end = T0 + days * DAY + 12 * HOUR;
    const samples = spending(T0, end, 10 * MINUTE, t => (t >= end - 24 * HOUR ? 2 * base(t) : base(t)), T0 + 3 * DAY);
    return basisOf(forecast(samples, end).forecast).lastDay;
  };
  near(doubled(8, () => 0.5), 1.75, 0.0005);
  const weekend = (t: number) => ([5, 6].includes((Math.floor(t / DAY) + 3) % 7) ? 0.1 : 0.6);
  near(doubled(21, weekend), 1.38, 0.0005);
});

test('after a week of nothing, a day of work forecasts as without the idle week', () => {
  const R = T0 + 7 * DAY;
  const idle = spending(T0 - 14 * DAY, R + DAY, 10 * MINUTE, t => (t >= T0 && t < R ? 0 : 0.5), T0 - 7 * DAY);
  const busy = spending(T0 - 14 * DAY, R + DAY, 10 * MINUTE, () => 0.5, T0 - 7 * DAY);
  near(forecast(idle, R + DAY).forecast.F, 16, 0.05);
  near(forecast(busy, R + DAY).forecast.F, 16, 0.05);
});

test('the hours count up to the end of the last sample\'s hour, no later than the moment', () => {
  // An hour's forecast on a sample a moment before the hour takes that hour whole.
  const hot = (end: number, first: number) => spending(first, end, 2 * MINUTE, t => (t >= end - HOUR ? 3 : 0.5), T0 + 7 * DAY);
  const asOf = T0 + 2 * DAY + 17 * HOUR;
  const samples = hot(asOf, T0 + 11 * HOUR + 30_000);
  assert.equal(samples.at(-1)!.at, T0 + 2 * DAY + 16 * HOUR + 58 * MINUTE + 30_000);
  near(forecast(samples, asOf).forecast.F, 8.94);
  near(forecast(hot(asOf, T0 + 11 * HOUR), asOf).forecast.F, 8.47);
  // An instant forecast within an hour takes no part of the hour that has not come.
  const warm = spending(T0 + 30_000, T0 + 3 * DAY + 40 * MINUTE, 2 * MINUTE, t => (t >= T0 + 3 * DAY ? 4 : 0.5), T0 + 7 * DAY);
  const anchor = warm.at(-1)!.at;
  assert.equal(anchor, T0 + 3 * DAY + 38 * MINUTE + 30_000);
  const f = forecast(warm, anchor).forecast;
  near(f.F, 13.79);
  near(basisOf(f).lastDay, 1, 0.0005);
  assert.equal(basisOf(f).burst, null);
});

// ---------- the verdict ----------

test('a moment already past is not held', () => {
  const R = T0 + 7 * DAY;
  const samples = sampled(T0, T0 + 3 * DAY, 10 * MINUTE, t => ({used: (100 * (t - T0)) / (72.5 * HOUR), resetAt: R}));
  const asOf = T0 + 3 * DAY;
  const zero = forecast(samples, asOf).forecast.zero!;
  assert.ok(zero - asOf > 25 * MINUTE && zero - asOf < 35 * MINUTE);
  const f = forecast(samples, asOf, {win: R, out: true, Z: asOf - 10 * MINUTE, X: null, comfy: false}).forecast;
  assert.equal(f.shownZero, zero);
});

test('"runs out" holds for the same window only, within a minute of its reset time, while the line ends up to 2 over zero', () => {
  const R = T0 + 7 * DAY;
  const samples = sampled(T0, T0 + 5 * DAY, 10 * MINUTE, t => ({used: (0.61 * (t - T0)) / HOUR, resetAt: R}));
  const asOf = T0 + 5 * DAY;
  const base = forecast(samples, asOf).forecast;
  assert.ok(base.F! > -5 && base.F! <= 2, String(base.F));
  assert.equal(base.state, 'lasts');
  assert.equal(forecast(samples, asOf, {win: R + 7 * DAY, out: true, Z: R - 2 * HOUR, X: null, comfy: false}).forecast.state, 'lasts');
  assert.equal(forecast(samples, asOf, {win: R + 30_000, out: true, Z: base.zero ?? R, X: null, comfy: false}).forecast.state, 'runsOut');
  // A line ending just over zero reaches none: held, it runs out at the reset, or at the moment shown before while that moved less than its dead zone.
  const over = sampled(T0, T0 + 5 * DAY, 10 * MINUTE, t => ({used: (0.595 * (t - T0)) / HOUR, resetAt: R}));
  const lasting = forecast(over, asOf).forecast;
  assert.ok(lasting.F! > 0 && lasting.F! <= 2, String(lasting.F));
  assert.equal(lasting.state, 'lasts');
  const held = forecast(over, asOf, {win: R, out: true, Z: null, X: null, comfy: false});
  assert.equal(held.forecast.state, 'runsOut');
  assert.equal(held.forecast.zero, null);
  assert.equal(held.forecast.shownZero, R);
  assert.equal(held.memory!.Z, R);
  const shown = forecast(over, asOf, {win: R, out: true, Z: R - 2 * HOUR, X: null, comfy: false}).forecast;
  assert.equal(shown.state, 'runsOut');
  assert.equal(shown.shownZero, R - 2 * HOUR);
});

test('no forecast without samples or when the last has no reset time; the memory stays as it was', () => {
  assert.equal(forecast([], T0).forecast.state, 'none');
  const samples = sampled(T0, T0 + 2 * DAY, 10 * MINUTE, t => ({used: (t - T0) / HOUR, resetAt: T0 + 7 * DAY}));
  const blank = [...samples, {at: T0 + 2 * DAY + 10 * MINUTE, used: 49, resetAt: null, minutes: WEEK}];
  const memory: Memory = {win: T0 + 7 * DAY, out: true, Z: T0 + 3 * DAY, X: null, comfy: false};
  const result = forecast(blank, T0 + 2 * DAY + 10 * MINUTE, memory);
  assert.equal(result.forecast.state, 'none');
  assert.equal(result.forecast.anchor, null);
  assert.equal(result.memory, memory);
});

test('"left" or "just enough" holds with hysteresis a day\'s worth of whole percents wide', () => {
  const t0 = Date.UTC(2026, 8, 7, 10);
  const samples = sampled(t0 + 30_000, t0 + 14 * DAY - MINUTE, 2 * MINUTE, t => {
    const start = t0 + Math.floor((t - t0) / (7 * DAY)) * 7 * DAY;
    return {used: Math.floor(Math.min(100, (0.45 * (t - start)) / HOUR)), resetAt: start + 7 * DAY};
  });
  const second = t0 + 7 * DAY;
  const comfy = (hours: number, memory: boolean | null | 'none', win = second + 7 * DAY) => {
    const asOf = second + hours * HOUR;
    const f = forecast(at(samples, asOf), asOf, memory === 'none' ? null : {win, out: false, Z: null, X: null, comfy: memory}).forecast;
    return {F: f.F!, comfy: f.comfy};
  };
  // F 23.78 against a band of 29.58 ± 5.92.
  near(comfy(26, 'none').F, 23.78);
  assert.deepEqual([true, false, 'none' as const].map(m => comfy(26, m).comfy), [true, false, false]);
  // The last window's memory is not this one's.
  assert.equal(comfy(26, true, second).comfy, false);
  // F 29.83 against a band of 28.54 ± 5.71.
  near(comfy(31, 'none').F, 29.83);
  assert.deepEqual([true, false, 'none' as const].map(m => comfy(31, m).comfy), [true, false, true]);
  // What it said is kept for the next one.
  const asOf = second + 26 * HOUR;
  assert.equal(forecast(at(samples, asOf), asOf, {win: second + 7 * DAY, out: false, Z: null, X: null, comfy: true}).memory!.comfy, true);
});

// ---------- the cold start ----------

/** A subscription seen with its rolling window not started: 16 hours idle, then 1 %/h in whole percents. */
function firstUse(until: number) {
  const first = Date.UTC(2026, 8, 10, 9, 7);
  const go = first + 16 * HOUR;
  const R = go + 7 * DAY;
  const samples = sampled(first, until, 2 * MINUTE, t =>
    t < go ? unstarted(t) : t < R ? {used: Math.min(100, Math.floor((t - go) / HOUR)), resetAt: R} : {used: Math.floor((t - R) / HOUR), resetAt: R + WEEK * MINUTE},
  );
  return {samples, go, R};
}

test("a new subscription's history begins with its first use, not with connecting it", () => {
  const {go} = firstUse(0);
  const {samples} = firstUse(go + 60 * MINUTE);
  const before = upTo(samples, go - 10 * MINUTE);
  assert.equal(before.state, 'needData');
  assert.equal(hoursOf(before), 0);
  const early = upTo(samples, go + 30 * MINUTE);
  assert.equal(early.state, 'needData');
  near(hoursOf(early), 0.67);
  const f = upTo(samples, go + 60 * MINUTE);
  assert.equal(f.state, 'runsOut');
  near(f.F, -66.89);
  // A week on, the history goes on through the reset.
  const {samples: week, R} = firstUse(go + 7 * DAY + 10 * MINUTE);
  const g = upTo(week, R + 10 * MINUTE);
  assert.equal(g.state, 'runsOut');
  near(g.F, -67.86);
  near(hoursOf(g), 100.17);
});

test("a cold series that saw its window start blends with the window's mean from the first half hour, and never says \"left\"", () => {
  const first = T0 + 3 * DAY - 3 * HOUR;
  const R = T0 + 3 * DAY;
  const go = R + 2 * HOUR;
  const series = (tenths: boolean) =>
    sampled(first, go + 2 * HOUR, 2 * MINUTE, t =>
      t < R
        ? {used: Math.floor(90 + (t - first) / HOUR), resetAt: R}
        : t < go
          ? unstarted(t)
          : {used: tenths ? Math.round((10 * (t - go)) / HOUR) / 10 : Math.floor((t - go) / HOUR), resetAt: go + WEEK * MINUTE},
    );
  const whole = series(false);
  const asOf = lastAt(whole, go + 20 * MINUTE);
  const result = forecast(at(whole, asOf), asOf);
  assert.equal(result.forecast.state, 'lasts');
  near(result.forecast.F, 37.13);
  assert.equal(result.forecast.comfy, false);
  assert.equal(result.memory!.comfy, false);
  const f = upTo(whole, go + 70 * MINUTE);
  assert.equal(f.state, 'runsOut');
  near(f.F, -31.36);
  const g = upTo(series(true), go + 52 * MINUTE);
  assert.equal(g.state, 'runsOut');
  near(g.F, -55.91);
  // Its first sample 5 minutes into the window: it still saw the window start.
  const begun = Date.UTC(2026, 8, 9, 10);
  const late = sampled(begun + 5 * MINUTE, begun + 2 * HOUR, 2 * MINUTE, t => ({used: Math.round((15 * (t - begun)) / HOUR) / 10, resetAt: begun + WEEK * MINUTE}));
  near(upTo(late, begun + 75 * MINUTE).F, -153.87, 0.01);
});

test("a young window's mean only lifts the pace a cold series knows from before the reset", () => {
  const R = Date.UTC(2026, 8, 14, 12, 7);
  const first = R - 10 * HOUR;
  const series = (after: number) =>
    sampled(first, R + 9 * HOUR, 2 * MINUTE, t => (t < R ? {used: Math.floor(40 + (t - first) / HOUR), resetAt: R} : {used: Math.floor((after * (t - R)) / HOUR), resetAt: R + WEEK * MINUTE}));
  const f = upTo(series(1), R + 52 * MINUTE);
  assert.equal(f.state, 'runsOut');
  near(f.F, -36.75);
  // Once the window is a twentieth of its length old, its mean counts either way.
  const g = upTo(series(0.5), R + 9 * HOUR);
  assert.equal(g.state, 'lasts');
  near(g.F, 8.83);
});

test('connected on a used-up window, a series begins with the first window it saw start', () => {
  for (const {minute, round, early, F} of [
    {minute: 0, round: (h: number) => Math.floor(h), early: 0.5, F: -47.01},
    {minute: 7, round: (h: number) => Math.round(10 * h) / 10, early: 0.67, F: -72.85},
  ]) {
    const R = T0 + 3 * DAY + 19 * HOUR + minute * MINUTE;
    const go = R + 20 * HOUR;
    const samples = sampled(T0 + 30_000, go + 70 * MINUTE, 2 * MINUTE, t =>
      t < R ? {used: 100, resetAt: R} : t < go ? unstarted(t) : {used: round((t - go) / HOUR), resetAt: go + WEEK * MINUTE},
    );
    const e = upTo(samples, go + 30 * MINUTE);
    assert.equal(e.state, 'needData', `:${minute}`);
    near(hoursOf(e), early);
    const f = upTo(samples, go + 70 * MINUTE);
    assert.equal(f.state, 'runsOut', `:${minute}`);
    near(f.F, F);
  }
});

test('connected in the quiet tail of a window, a series begins with the next rolling window', () => {
  const connected = Date.UTC(2026, 8, 11, 18);
  const R = Date.UTC(2026, 8, 12, 10);
  const go = Date.UTC(2026, 8, 14, 9);
  const samples = sampled(connected + 30_000, go + 70 * MINUTE, 2 * MINUTE, t =>
    t < R ? {used: 40, resetAt: R} : t < go ? unstarted(t) : {used: Math.floor((t - go) / HOUR), resetAt: go + WEEK * MINUTE},
  );
  assert.equal(upTo(samples, go + 30 * MINUTE).state, 'needData');
  const f = upTo(samples, go + 70 * MINUTE);
  assert.equal(f.state, 'runsOut');
  near(f.F, -47.01);
});

test('a window on a schedule keeps the idle hours before its first spending in the history', () => {
  // As Claude's: the next window begins at the reset, a week long, and stays at 0 until Monday.
  const connected = Date.UTC(2026, 8, 11, 18);
  const R = Date.UTC(2026, 8, 12, 10);
  const go = Date.UTC(2026, 8, 14, 9);
  const samples = sampled(connected + 30_000, go + 70 * MINUTE, 2 * MINUTE, t =>
    t < R ? {used: 40, resetAt: R} : {used: t < go ? 0 : Math.floor((t - go) / HOUR), resetAt: R + WEEK * MINUTE},
  );
  const f = upTo(samples, go + 70 * MINUTE);
  assert.equal(f.state, 'lasts');
  near(f.F, 94.01);
  assert.equal(f.comfy, true);
  near(hoursOf(f), 48.17);
  // Its first sample within ten minutes of a window begun on the schedule, and nothing spent
  // in that one: it saw the window begin, yet the idle week is history too.
  const begun = Date.UTC(2026, 8, 10, 10);
  const weeks = (after: number) =>
    sampled(begun + after, begun + 7 * DAY + 6 * HOUR, 2 * MINUTE, t => {
      const start = begun + Math.floor((t - begun) / (7 * DAY)) * 7 * DAY;
      return {used: start === begun ? 0 : Math.floor((t - start) / HOUR), resetAt: start + WEEK * MINUTE};
    });
  const g = upTo(weeks(5 * MINUTE), begun + 7 * DAY + 6 * HOUR);
  assert.equal(g.state, 'lasts');
  near(g.F, 67.58, 0.01);
  near(hoursOf(g), 174, 0.01);
  // Its first sample eleven minutes in: it did not see the window begin, and its history begins with the next one.
  const late = upTo(weeks(11 * MINUTE), begun + 7 * DAY + 6 * HOUR);
  assert.equal(late.state, 'runsOut');
  near(late.F, -40.31, 0.01);
  near(hoursOf(late), 6, 0.01);
});

test("a series whose life began before what the hub reads keeps its history: a break is not its beginning", () => {
  const s0 = T0 - 40 * DAY;
  const b0 = T0 - 24 * DAY;
  const b1 = T0 - 21 * DAY;
  const all = sampled(s0, T0 + 12 * HOUR, 10 * MINUTE, t => {
    if (t >= b0 && t < b1) return unstarted(t);
    const from = t < b0 ? s0 : b1;
    const start = from + Math.floor((t - from) / (7 * DAY)) * 7 * DAY;
    return {used: Math.min(100, Math.floor((t - start) / HOUR)), resetAt: start + 7 * DAY};
  });
  const asOf = T0 + 12 * HOUR;
  const first = all.findIndex(s => s.at >= asOf - 23 * DAY);
  const read = all.slice(first - 1);
  near(hoursOf(forecast(read, asOf).forecast), 348.17);
  // A first sample without a reset time is read all the same.
  const blank = read.map((s, i) => (i === 0 ? {...s, resetAt: null} : s));
  near(hoursOf(forecast(blank, asOf).forecast), 348);
});

// ---------- plan changes ----------

test('a plan change counts once it held for an hour', () => {
  const rows = (...changes: [number, string][]) => changes.map(([minutes, plan]) => ({at: T0 + minutes * MINUTE, plan}));
  // The first plan is where the history begins anyway.
  assert.equal(planSince(rows([0, 'pro']), T0 + DAY), null);
  // A moment of another plan starts nothing.
  assert.equal(planSince(rows([0, 'pro'], [60, 'max'], [70, 'pro']), T0 + DAY), null);
  assert.equal(planSince(rows([0, 'pro'], [60, 'max']), T0 + DAY), T0 + HOUR);
  // Not yet an hour old.
  assert.equal(planSince(rows([0, 'pro'], [60, 'max']), T0 + 110 * MINUTE), null);
  assert.equal(planSince(rows([0, 'pro'], [60, 'max'], [180, 'pro']), T0 + DAY), T0 + 3 * HOUR);
  // A change after the moment is not known then, nor how long the one before it held.
  assert.equal(planSince(rows([0, 'pro'], [60, 'max'], [180, 'pro']), T0 + 150 * MINUTE), T0 + HOUR);
  assert.equal(planSince(rows([0, 'pro'], [60, 'max'], [180, 'pro']), T0 + 110 * MINUTE), null);
});
