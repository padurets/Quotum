import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frameOf, periodLabel, periodOf, PERIODS, step} from '../lib/periods';
import {complete} from '../lib/api';
import {setLocale} from '../i18n';
import type {History} from '../lib/types';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
// Not on a whole minute, as the page's clock rarely is.
const now = 1_800_000_000_000 + 25_000;
const floor = (at: number) => Math.floor(at / minute) * minute;
const long = now - 60 * day;

test('a period this page does not know is the default one; one it knows stays', () => {
  assert.equal(periodOf('2h').id, '24h');
  assert.equal(periodOf('3d').id, '3d');
  setLocale('en');
  assert.deepEqual(PERIODS.map(periodLabel), ['1h', '3h', '6h', '12h', '24h', '3 days', '7 days', '14 days', '30 days']);
});

test('a period ends now with its future on the right; a chosen horizon is no longer than the period', () => {
  assert.deepEqual(frameOf(null, {range: '6h', horizon: 'auto'}, now, long), {from: now - 6 * hour, to: now, length: 6 * hour, future: hour, live: true});
  assert.equal(frameOf(null, {range: '6h', horizon: '3d'}, now, long).future, 6 * hour);
  assert.equal(frameOf(null, {range: '30d', horizon: '1d'}, now, long).future, day);
  assert.equal(frameOf(null, {range: '30d', horizon: 'auto'}, now, now - 2 * day).from, now - 2 * day, 'from where history starts');
  const range = {from: now - 3 * day, to: now - 2 * day};
  assert.deepEqual(frameOf(range, {range: '6h', horizon: 'auto'}, now, long), {...range, length: day, future: 0, live: false}, 'a range has no future');
});

test('‹ on a period ending now goes half of it back, on whole minutes, and one › brings the period back', () => {
  const back = step(null, '24h', -1, now, long);
  assert.deepEqual(back, {from: floor(now - day) - 12 * hour, to: floor(now - day) + 12 * hour});
  assert.equal(step(null, '24h', 1, now, long), null, 'nothing later than now');
  assert.equal(step(back as {from: number; to: number}, '24h', 1, now, long), 'live');
  assert.equal(step(back as {from: number; to: number}, '24h', 1, now + 5 * hour, long), 'live', 'even a while later, within half a step');
  const twice = step(back as {from: number; to: number}, '24h', -1, now, long)!;
  assert.deepEqual(step(twice as {from: number; to: number}, '24h', 1, now, long), back, 'two back and one forward is one back');
});

test('a step is half the length asked for, a whole minute at least', () => {
  const dragged = {from: floor(now) - 3 * hour, to: floor(now) - 3 * hour + 15 * minute};
  assert.deepEqual(step(dragged, '24h', -1, now, long), {from: dragged.from - 7 * minute, to: dragged.to - 7 * minute}, 'a dragged range steps by its own half');
  assert.deepEqual(step(dragged, '24h', 1, now, long), {from: dragged.from + 7 * minute, to: dragged.to + 7 * minute});
  assert.deepEqual(step(null, '7d', -1, now, long), {from: floor(now - 7 * day) - 3.5 * day, to: floor(now - 7 * day) + 3.5 * day});
  // A range the chart shows from where history starts, later than it begins, steps by half of its own length.
  const early = {from: now - 12 * day, to: now - 11 * day};
  assert.equal(frameOf(early, {range: '24h', horizon: 'auto'}, now, now - 11.5 * day).from, now - 11.5 * day);
  assert.deepEqual(step(early, '24h', 1, now, now - 11.5 * day), {from: floor(early.from) + 12 * hour, to: floor(early.from) + 36 * hour});
  const dragToNow = {from: floor(now) - 2 * hour, to: floor(now) - 10 * minute};
  assert.equal(step(dragToNow, '7d', 1, now, long), 'live', 'a dragged range moved up to now is the chosen period again');
});

test('‹ stops where history starts, or the hub stops keeping it, and is off there', () => {
  const start = now - 2 * day + 30_000; // history starts on no whole minute
  const back = step(null, '24h', -1, now, start)!;
  assert.deepEqual(back, {from: floor(now - day) - 12 * hour, to: floor(now - day) + 12 * hour});
  const edge = step(back as {from: number; to: number}, '24h', -1, now, start) as {from: number; to: number};
  assert.equal(edge.from, Math.ceil(start / minute) * minute, 'no earlier than history, on a whole minute');
  assert.equal(edge.to - edge.from, day, 'the length stays');
  assert.equal(step(edge, '24h', -1, now, start), null, 'off once there');
  assert.equal(step(null, '30d', -1, now, now - 20 * day), null, 'history shorter than the period: nowhere back');
  let range = step(null, '30d', -1, now, 0) as {from: number; to: number};
  for (let i = 0; i < 10 && range; i++) {
    const next = step(range, '30d', -1, now, 0);
    if (!next) break;
    range = next as {from: number; to: number};
  }
  assert.equal(range.from, Math.ceil((now - 90 * day + hour) / minute) * minute, 'an hour inside the 90 days the hub keeps');
  assert.equal(step(range, '30d', -1, now, 0), null);
});

test('only an answer that is all there is of a range is kept on the page', () => {
  const cellMs = 5 * minute;
  const range = {from: now - 2 * day - 3 * minute, to: now - day - 3 * minute};
  const answer = {range: '', now, since: 0, to: Math.ceil(range.to / cellMs) * cellMs, cellMs, historyStart: 0, series: [], events: [], refreshInMs: null} as History;
  assert.equal(complete(answer, range), true);
  assert.equal(complete({...answer, to: now - day - 4 * minute}, range), false, 'cut to the hub’s now');
  assert.equal(complete({...answer, refreshInMs: 60_000}, range), false, 'a newer one is on its way');
});
