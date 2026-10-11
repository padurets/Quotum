import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  FORECAST_EDGES,
  FORECAST_WIDTHS,
  LIVE_COLUMNS,
  RANGE_COLUMNS,
  announcedOf,
  clip,
  forecastLayout,
  forecastLine,
  outlook,
  outlookText,
  planEndOf,
  spentOf,
  uncounted,
  type Context,
  type ForecastColumn,
  type Outlook,
} from '../lib/forecast';
import {QUOTA_TABLE, columnShown} from '../lib/view';
import {setLocale} from '../i18n';
import type {Resets, ResetStatus} from '../lib/resets';
import type {SeriesForecast, Win} from '../lib/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The start of a weekly window; it resets a week later. */
const start = Date.parse('2026-09-26T10:00:00Z');
const reset = start + 7 * DAY;
/** When the window was measured: three days in, four days to the reset. */
const measured = start + 3 * DAY;
const week = (remaining: number, change: Partial<Win> = {}): Win => ({id: 'weekly', kind: 'weekly', label: null, used: 100 - remaining, remaining, resetAt: reset, minutes: 10080, ...change});
const hours = (remaining: number, change: Partial<Win> = {}): Win => ({id: 'session', kind: 'session', label: null, used: 100 - remaining, remaining, resetAt: start + 5 * HOUR, minutes: 300, ...change});
const context = (change: Partial<Context> = {}): Context => ({windows: [], freeResets: 0, announced: null, ...change});

/** The hub's forecast of a week at 60% left, measured at `measured`: lasts with 20 left by default. */
const lasts = (change: Partial<SeriesForecast> = {}): SeriesForecast => ({
  state: 'lasts',
  asOf: measured,
  resetAt: reset,
  anchor: {at: measured, left: 60},
  F: 20,
  zero: null,
  shownZero: null,
  shownLeft: 20,
  comfy: true,
  points: [
    [0, 60],
    [(4 * DAY) / MIN, 20],
  ],
  basis: {hours: 72, cold: false, usualPerDay: 12, lastDay: 1, burst: null},
  ...change,
});
/** The same week running out `inMs` after the measurement, at 60 points over that time. */
const runsOut = (inMs: number, change: Partial<SeriesForecast> = {}): SeriesForecast =>
  lasts({
    state: 'runsOut',
    F: 60 - (60 * 4 * DAY) / inMs,
    zero: measured + inMs,
    shownZero: measured + inMs,
    shownLeft: null,
    comfy: false,
    points: [
      [0, 60],
      [(4 * DAY) / MIN, 60 - (60 * 4 * DAY) / inMs],
    ],
    ...change,
  });
const said = (ahead: SeriesForecast | null, now = measured, live = week(60), c = context()) => outlook(live, measured, now, ahead, c);
const key = (o: Outlook) => [o.key, o.tone];

// ---------- a weekly window: the hub's forecast, the board's clock ----------

test('a weekly window says what the card tells at once, then what the hub foresees', () => {
  // The card first: its reset gone by, used up, no reset time, a rolling window not started.
  assert.equal(said(lasts(), reset).key, 'awaiting');
  assert.deepEqual(key(said(lasts(), measured, week(0))), ['usedUp', 'v-crit']);
  assert.equal(said(lasts(), measured, week(60, {resetAt: null})).key, 'none');
  assert.equal(outlook(week(60), reset + MIN, reset - MIN, lasts(), context()).key, 'none', 'measured after its reset time');
  assert.equal(said(lasts(), measured, week(100, {resetAt: measured + 7 * DAY})).key, 'idle');
  // The hub: failed, not yet worked out on this window, needing data.
  assert.equal(said({...lasts(), state: 'none', failed: true, resetAt: null, anchor: null}).key, 'unavailable');
  assert.equal(said(null).key, 'renewing');
  assert.equal(said({...lasts(), state: 'none', resetAt: null, anchor: null}).key, 'renewing');
  assert.equal(said(lasts({resetAt: reset + 2 * MIN})).key, 'renewing', 'of another window');
  assert.equal(said(lasts({resetAt: reset + 30_000})).key, 'left', 'the same window, its reset told a little otherwise');
  assert.deepEqual(said(lasts({state: 'needData', basis: {hours: 0.5}})), {key: 'needData', tone: '', why: 'hour'});
  // Used up or waiting to the hub, with something left on the card: the hub works it out again.
  assert.equal(said(lasts({state: 'usedUp'})).key, 'renewing');
  assert.equal(said(lasts({state: 'awaiting'})).key, 'renewing');
});

test('"runs out" counts from the moment the hub said; past it, no measurement since means it ran out, one since that the hub works it out again', () => {
  const ahead = runsOut(10 * HOUR);
  assert.deepEqual(said(ahead, measured + HOUR), {key: 'runsOut', at: measured + 10 * HOUR, inMs: 9 * HOUR, tone: 'v-crit'});
  assert.deepEqual(said(ahead, measured + 10 * HOUR), {key: 'pastZero', at: measured + 10 * HOUR, tone: ''});
  assert.equal(outlook(week(60), measured + 10 * HOUR, measured + 10 * HOUR, ahead, context()).key, 'renewing', 'measured at the moment');
});

test('"left" only as the hub says it is comfortably so, and never "~0%"', () => {
  assert.deepEqual(said(lasts()), {key: 'left', left: 20, tone: ''});
  // F well above what counts as left, yet the hub holds "just enough": the board follows it.
  assert.equal(said(lasts({F: 60, shownLeft: 60, comfy: false})).key, 'pace');
  assert.equal(said(lasts({F: 3, shownLeft: 0, comfy: true})).key, 'pace', 'a dead band may hold the share at 0');
  assert.deepEqual(said(lasts({F: 6, shownLeft: 5, comfy: true})), {key: 'left', left: 5, tone: ''}, 'from 5');
});

test('red when it runs out within half the time to the reset, yellow at most in a first day, with free resets or before an announced reset', () => {
  const soon = runsOut(30 * HOUR);
  assert.equal(said(soon).tone, 'v-crit');
  assert.equal(said(runsOut(60 * HOUR)).tone, 'v-warn');
  assert.equal(said(runsOut(30 * HOUR, {basis: {hours: 12, cold: true, usualPerDay: 12, lastDay: null, burst: null}})).tone, 'v-warn');
  assert.equal(said(soon, measured, week(60), context({freeResets: 1})).tone, 'v-warn');
  assert.equal(said(soon, measured, week(60), context({announced: measured + 20 * HOUR})).tone, 'v-warn');
  assert.equal(said(soon, measured, week(60), context({announced: measured + 40 * HOUR})).tone, 'v-crit', 'a reset for everyone after it runs out');
});

test('a reset for everyone counts from its announced time until a measurement sees it, whatever this browser shows, and a banked one never', () => {
  const status = (scheduled: ResetStatus['scheduled']): Resets => ({codex: {scheduled, watch: null, latest: null, policy: null, credit: {name: 'Codex Resets', url: 'https://x'}}});
  const event = {url: 'https://x', text: 'reset', at: measured - DAY};
  const regular = status({...event, scheduledFor: measured + DAY, kind: 'regular'});
  assert.equal(announcedOf(regular, 'codex', measured), measured + DAY);
  assert.equal(announcedOf(regular, 'codex', measured + DAY), null, 'a measurement at its time has seen it');
  assert.equal(announcedOf(regular, 'claude', measured), null);
  assert.equal(announcedOf(status({...event, scheduledFor: measured + DAY, kind: 'banked'}), 'codex', measured), null);
  assert.equal(announcedOf(status({...event, scheduledFor: null, kind: 'regular'}), 'codex', measured), null);
  assert.equal(announcedOf(status({...event, scheduledFor: measured + DAY, kind: null}), 'codex', measured), measured + DAY);
  assert.equal(announcedOf(null, 'codex', measured), null);
});

test("too little history says why: too few hours, its limit at zero, or its subscription's weekly limit at zero", () => {
  const needs = (window: Win, windows: Win[]) => said(lasts({state: 'needData', basis: {hours: 0}}), measured, window, context({windows}));
  const fable = (used: number) => week(100 - used, {id: 'weekly:fable', label: 'Fable'});
  const weekly = (used: number, change: Partial<Win> = {}) => week(100 - used, change);
  assert.equal(needs(week(0.3), [week(0.3)]).key, 'needData');
  assert.deepEqual(needs(week(0.3, {used: 99.7}), [week(0.3, {used: 99.7})]), {key: 'needData', tone: '', why: 'atZero'});
  for (const earlier of [0, 30_000]) assert.equal((needs(fable(30), [weekly(100, {resetAt: reset - earlier}), fable(30)]) as {why: string}).why, 'weeklyAtZero', `${earlier} ms`);
  for (const w of [weekly(100, {resetAt: reset - 90_000}), weekly(100, {resetAt: reset - DAY}), weekly(100, {resetAt: null}), weekly(99.4)])
    assert.equal((needs(fable(30), [w, fable(30)]) as {why: string}).why, 'hour', JSON.stringify(w));
  // Antigravity labels every window: none is the subscription's weekly.
  const gemini = week(0, {id: 'gemini:weekly', label: 'Gemini'});
  assert.equal((needs(fable(30), [gemini, fable(30)]) as {why: string}).why, 'hour');
  assert.equal(uncounted([week(0.6)], week(0.6)), null, 'a window at 99.4');
});

// ---------- the cell's words ----------

test("the cell's tooltip says a part a line, each only where it applies, in plural forms of the number shown", () => {
  setLocale('ru');
  try {
    const burst = {times: 4.96, zero: measured + 30 * HOUR};
    const ahead = runsOut(30 * HOUR, {basis: {hours: 200, cold: false, usualPerDay: 14.2, lastDay: 4.96, burst}});
    const o = said(ahead, measured, week(60), context({freeResets: 2, announced: measured + 2 * DAY}));
    const text = outlookText(o, week(60), ahead, context({freeResets: 2, announced: measured + 2 * DAY}), null);
    assert.equal(text.text, 'закончится через ~30 ч');
    assert.equal(text.burst, true);
    assert.equal(text.title.length, 8);
    assert.match(text.title[0], /^Закончится около /);
    assert.equal(text.title[1], 'Обычно уходит ~14% в сутки');
    assert.equal(text.title[2], 'Последние сутки — в 5 раз больше обычного', 'five as shown, not 4.96');
    assert.equal(text.title[3], 'Последние 6 ч — в 5 раз быстрее обычного');
    assert.match(text.title[4], /^При таком темпе — около /);
    assert.equal(text.title[5], 'Чтобы хватило до сброса — до ~15% в сутки');
    assert.equal(text.title[6], 'Бесплатных сбросов: 2');
    assert.match(text.title[7], /^Сброс для всех — /);
    for (const line of text.title) assert.ok(!line.includes(' · ') && !line.includes('\n'), line);
    const day = (lastDay: number | null) => outlookText(said(lasts()), week(60), lasts({basis: {hours: 200, cold: false, usualPerDay: 0.3, lastDay, burst: null}}), context(), null).title;
    assert.deepEqual(day(1.05), ['Обычно уходит < 1% в сутки', 'Чтобы хватило до сброса — до ~15% в сутки'], 'as usual: no line, and under a point no "~"');
    assert.equal(day(0.05)[1], 'Последние сутки — почти без трат');
    assert.equal(day(0.5)[1], 'Последние сутки — в 2 раза меньше обычного');
    assert.equal(day(1.52)[1], 'Последние сутки — в 1,5 раза больше обычного');
    assert.equal(day(0.92).length, 2, 'as usual down to 0.9');
    assert.equal(day(0.88)[1], 'Последние сутки — в 1,1 раза меньше обычного');
    // A reset for everyone announced after the window's own says nothing of it.
    const after = outlookText(said(lasts()), week(60), lasts(), context({announced: reset + HOUR}), null).title;
    assert.ok(!after.some(line => line.startsWith('Сброс для всех')), after.join(' | '));
    const cold = outlookText(said(lasts({comfy: false})), week(60), lasts({basis: {hours: 7.9, cold: true, usualPerDay: 3, lastDay: null, burst: null}}), context(), null);
    assert.deepEqual(cold.title, ['По первым 7 ч', 'Чтобы хватило до сброса — до ~15% в сутки']);
    assert.equal(cold.text, 'хватит впритык');
    const first = outlookText(said(lasts({comfy: false})), week(60), lasts({basis: {hours: 1.9, cold: true, usualPerDay: 3, lastDay: null, burst: null}}), context(), null);
    assert.equal(first.title[0], 'По первому часу');
    // Under two days to the reset, by the hour, as the countdown turns to hours then.
    const allowed = (hours: number) => outlookText(said(lasts()), week(60), lasts({anchor: {at: reset - hours * HOUR, left: 60}}), context(), null).title.at(-1);
    assert.equal(allowed(48), 'Чтобы хватило до сброса — до ~30% в сутки');
    assert.equal(allowed(47.5), 'Чтобы хватило до сброса — до 1,3%/ч');
    assert.equal(allowed(0.25), 'Чтобы хватило до сброса — до 240%/ч');
    setLocale('en');
    const en = outlookText(o, week(60), ahead, context({freeResets: 2, announced: measured + 2 * DAY}), null);
    assert.equal(en.text, 'runs out in ~30h');
    assert.equal(en.title[2], 'The last day: 5 times the usual');
    assert.equal(outlookText(said(lasts()), week(60), lasts({basis: {hours: 1, cold: true, usualPerDay: 3, lastDay: null, burst: null}}), context(), null).title[0], 'By the first hour');
    assert.equal(outlookText(said(lasts()), week(60), lasts({basis: {hours: 2, cold: true, usualPerDay: 3, lastDay: null, burst: null}}), context(), null).title[0], 'By the first 2 hours');
    assert.equal(outlookText(said(lasts()), week(60), lasts({basis: {hours: 200, cold: false, usualPerDay: 0, lastDay: null, burst: null}}), context(), null).title[0], 'Usually 0% a day');
  } finally {
    setLocale('en');
  }
});

test('the burst is an arrow beside the words, its size only in the tooltip, and changes neither the words nor the tone', () => {
  const burst = {times: 3.2, zero: measured + 20 * HOUR};
  const plain = runsOut(60 * HOUR);
  const fast = runsOut(60 * HOUR, {basis: {hours: 200, cold: false, usualPerDay: 12, lastDay: 1, burst}});
  const [a, b] = [said(plain), said(fast)];
  assert.deepEqual(a, b);
  const [ta, tb] = [outlookText(a, week(60), plain, context(), null), outlookText(b, week(60), fast, context(), null)];
  assert.equal(tb.text, ta.text);
  assert.ok(!/\d/.test(tb.text.replace(/~\d+\w*/, '')), tb.text);
  assert.deepEqual([ta.burst, tb.burst], [false, true]);
});

test("the plan's line: when a plan the owner chose ends before the reset, what the forecast has left then", () => {
  setLocale('en');
  const plan = [30, 30, 20, 20, 0, 0, 0];
  // The plan ends four days in, a day after the measurement.
  const end = start + 4 * DAY;
  const at = (ahead: SeriesForecast) => planEndOf(week(60), measured, measured, plan, ahead);
  assert.deepEqual(at(lasts()), {at: end, left: 50, before: false});
  const line = (ahead: SeriesForecast) => outlookText(said(ahead), week(60), ahead, context(), at(ahead)).title.at(-1)!;
  assert.match(line(lasts()), /^By the end of the plan \(.+\): ~50% left$/);
  assert.match(line(lasts({points: [[0, 60], [DAY / MIN, 3], [(4 * DAY) / MIN, -30]], F: -30})), /^By the end of the plan \(.+\): on plan$/);
  assert.match(line(runsOut(20 * HOUR)), /^Runs out before the plan ends \(.+\)$/);
  assert.equal(planEndOf(week(60), measured, measured, null, lasts()), null, 'no plan chosen');
  assert.equal(planEndOf(week(60), measured, end, plan, lasts()), null, 'the plan is over');
  assert.equal(planEndOf(week(60), measured, measured, [10, 10, 10, 10, 20, 20, 20], lasts()), null, 'a plan that ends at the reset');
});

test('a window without a forecast says why in its tooltip', () => {
  setLocale('en');
  const title = (o: Outlook) => outlookText(o, week(60), null, context(), null).title;
  assert.deepEqual(title({key: 'needData', tone: '', why: 'hour'}), ['Too little history: the forecast comes once there is an hour of it']);
  assert.deepEqual(title({key: 'needData', tone: '', why: 'atZero'}), ['The limit is at zero: the forecast comes after the reset']);
  assert.deepEqual(title({key: 'needData', tone: '', why: 'weeklyAtZero'}), ['The shared weekly limit is at zero: the forecast comes after the reset']);
  assert.deepEqual(title({key: 'renewing', tone: ''}), ['The forecast is being worked out again']);
  assert.deepEqual(title({key: 'unavailable', tone: ''}), ['The forecast could not be worked out: an error on the hub']);
  assert.equal(title({key: 'pastZero', at: measured, tone: ''}).length, 2);
});

// ---------- the line on the chart ----------

test("a weekly window's line is the hub's, from the card's last value to zero or to the reset, cut at the chart's edges", () => {
  const ahead = runsOut(40 * HOUR);
  const line = forecastLine(week(60), measured, measured, ahead, context(), start, reset + DAY)!;
  assert.deepEqual(line.points, [
    [measured, 60],
    [measured + 40 * HOUR, 0],
  ]);
  assert.deepEqual([line.zero, line.at], [measured + 40 * HOUR, measured + 40 * HOUR]);
  // The moment the cell says may differ from the line's zero: it moves only past a dead band.
  const held = forecastLine(week(60), measured, measured, runsOut(40 * HOUR, {shownZero: measured + 41 * HOUR}), context(), start, reset + DAY)!;
  assert.deepEqual([held.zero, held.at], [measured + 40 * HOUR, measured + 41 * HOUR]);
  const cut = forecastLine(week(60), measured, measured, ahead, context(), measured + 10 * HOUR, measured + 20 * HOUR)!;
  assert.deepEqual(cut.points, [
    [measured + 10 * HOUR, 45],
    [measured + 20 * HOUR, 30],
  ]);
  assert.equal(cut.zero, measured + 40 * HOUR, 'where it reaches zero is known beyond the edge');
  // "Runs out" held with a little left at the reset: the line reaches the reset, and no label.
  const heldAtReset = runsOut(40 * HOUR, {F: 1, zero: null, shownZero: reset, points: [[0, 60], [(4 * DAY) / MIN, 1]]});
  const toReset = forecastLine(week(60), measured, measured, heldAtReset, context(), start, reset + DAY)!;
  assert.deepEqual([toReset.points.at(-1), toReset.zero, toReset.at], [[reset, 1], null, null]);
  const left = forecastLine(week(60), measured, measured, lasts(), context(), start, reset + DAY)!;
  assert.deepEqual([left.points.at(-1), left.zero, left.at], [[reset, 20], null, null]);
  // Lasting, though its line reaches zero just before the reset: cut there, and no label.
  const justEnough = lasts({F: -2, zero: reset - 2 * HOUR, shownLeft: null, comfy: false, points: [[0, 60], [(4 * DAY) / MIN, -2]]});
  const pace = forecastLine(week(60), measured, measured, justEnough, context(), start, reset + DAY)!;
  assert.equal(pace.points.at(-1)![1], 0);
  assert.deepEqual([pace.zero, pace.at], [null, null]);
});

test("measured since the hour its forecast stands on, a weekly window's line starts at the card's last value, in the same shape", () => {
  const hour = measured + HOUR;
  // Spending faster than foreseen: 50 left an hour on, where the line had 58.5.
  const faster = forecastLine(week(50), hour, hour, runsOut(40 * HOUR), context(), start, reset + DAY)!;
  assert.deepEqual(faster.points[0], [hour, 50]);
  assert.equal(faster.points.at(-1)![1], 0);
  assert.ok(Math.abs(faster.zero! - (measured + 34 * HOUR + 20 * MIN)) < 1000, String((faster.zero! - measured) / HOUR));
  assert.equal(faster.at, measured + 40 * HOUR, 'said at the moment the table says');
  // Slower: 65 left where a line reaching zero at the reset had 59.4; moved up, it reaches none.
  const slower = forecastLine(week(65), hour, hour, runsOut(96 * HOUR), context(), start, reset + DAY)!;
  assert.deepEqual(slower.points[0], [hour, 65]);
  assert.deepEqual([slower.points.at(-1)![0], slower.zero, slower.at], [reset, null, null]);
  // Measured at the hour itself: the hub's line as it is.
  assert.deepEqual(forecastLine(week(60), measured, measured, runsOut(40 * HOUR), context(), start, reset + DAY)!.points[0], [measured, 60]);
});

test('no line where the table has no forecast', () => {
  const none = (live: Win, ahead: SeriesForecast | null, now = measured) => forecastLine(live, measured, now, ahead, context(), start, reset + DAY);
  assert.equal(none(week(0), lasts()), null, 'used up');
  assert.equal(none(week(60), lasts({state: 'needData', basis: {hours: 0}})), null, 'too little history');
  assert.equal(none(week(60), null), null, 'being worked out');
  assert.equal(none(week(60), runsOut(10 * HOUR), measured + 11 * HOUR), null, 'past its moment');
  assert.equal(none(hours(100, {resetAt: measured + 5 * HOUR}), null), null, 'idle');
});

// ---------- a five-hour window: its own pace since it started ----------

const fiveHour = (remaining: number, elapsed: number, later = 0) => outlook(hours(remaining), start + elapsed, start + elapsed + later, null, context());

test('a five-hour window goes at its pace since it started, to its reset, and tells it', () => {
  // 20 points in an hour: runs out at the fifth, the reset.
  assert.deepEqual(fiveHour(80, HOUR), {key: 'pace', tone: '', rate: 20});
  const fast = fiveHour(70, HOUR);
  assert.deepEqual(key(fast), ['runsOut', 'v-warn'], 'at +3h20m of the four hours to the reset');
  assert.deepEqual(key(fiveHour(40, HOUR)), ['runsOut', 'v-crit']);
  assert.equal((fast as {rate: number}).rate, 30);
  assert.deepEqual(key(fiveHour(90, HOUR)), ['left', '']);
  assert.equal(Math.round((fiveHour(90, HOUR) as {left: number}).left), 50);
  setLocale('en');
  assert.deepEqual(outlookText(fast, hours(70), null, context(), null).title.at(-1), 'Spent per hour since the window started: 30%/h');
});

test('a five-hour window started too recently waits: half an hour, or a twentieth of the window', () => {
  assert.equal(fiveHour(80, 30 * MIN - 1, 5 * MIN).key, 'needData');
  assert.equal(fiveHour(80, 30 * MIN, 5 * MIN).key, 'runsOut');
  const line = forecastLine(hours(70), start + HOUR, start + HOUR, null, context(), start, start + 6 * HOUR)!;
  assert.deepEqual(line.points.at(-1), [start + HOUR + (70 / 30) * HOUR, 0]);
  assert.equal(line.zero, line.at);
});

test('what the table says a period spent: points, nothing spent while measured, or unknown', () => {
  assert.deepEqual(spentOf({consumed: 40, coveredMs: 20 * HOUR}), {key: 'points', value: 40});
  assert.deepEqual(spentOf({consumed: 0, coveredMs: 20 * DAY}), {key: 'unused'});
  assert.deepEqual(spentOf({consumed: 0, coveredMs: 0}), {key: 'unknown'});
});

test('a line is cut where it crosses the edges', () => {
  assert.deepEqual(clip([[0, 100], [10, 0]], 20, 30), []);
  assert.deepEqual(clip([[0, 100], [4, 60], [10, 0]], 2, 8), [[2, 80], [4, 60], [8, 20]]);
});

test('the table stays a table while its chosen columns fit the widget, and becomes a list when they do not', () => {
  for (const columns of [LIVE_COLUMNS, RANGE_COLUMNS, ['now', 'work'] as const]) {
    const width = columns.reduce((sum, column) => sum + FORECAST_WIDTHS[column], FORECAST_WIDTHS.limit + FORECAST_EDGES);
    assert.equal(forecastLayout(columns, width - 1), 'list');
    assert.equal(forecastLayout(columns, width), 'table');
  }
  assert.equal(forecastLayout(['now'], 360), 'table', 'fewer columns, a table on a narrower widget');
  assert.equal(forecastLayout(LIVE_COLUMNS, 360), 'list');
  // A widget as wide as the board: the page's content is 1184 pixels, less the panel's border.
  const view = {version: 3 as const, layout: {columns: 6, places: {}}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};
  const shown = (columns: readonly ForecastColumn[]) => columns.filter(column => columnShown(view, QUOTA_TABLE, column));
  assert.equal(forecastLayout(shown(LIVE_COLUMNS), 1182), 'table', 'every column on by default, on a widget as wide as the board');
  // As measured on the board, with the padding of the cells at the table's edges.
  assert.equal(forecastLayout(shown(LIVE_COLUMNS), 1169), 'table');
  assert.equal(forecastLayout(shown(LIVE_COLUMNS), 1168), 'list');
  assert.equal(forecastLayout(shown(RANGE_COLUMNS), 1182), 'table');
  for (const columns of [LIVE_COLUMNS, RANGE_COLUMNS])
    assert.equal(
      forecastLayout(
        columns.filter(c => c === 'agenthours' || columnShown(view, QUOTA_TABLE, c)),
        1182,
      ),
      'list',
      'agent-hours added to the defaults exceed the full width',
    );
  assert.deepEqual(
    LIVE_COLUMNS.filter(column => !shown(LIVE_COLUMNS).includes(column)),
    ['agenthours', 'during'],
    'agent-hours and the share while active does not fit beside them',
  );
});
