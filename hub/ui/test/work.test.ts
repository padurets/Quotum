import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lineWork, workCells, workNotes, WORK_PACE_FROM, type WorkCell} from '../lib/work';
import {workHours} from '../lib/format';
import {setLocale} from '../i18n';
import type {SeriesWork} from '../lib/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const from = Date.parse('2026-09-19T10:00:00Z');
const work = (change: Partial<SeriesWork> = {}): SeriesWork => ({from, ms: 21 * HOUR, consumed: 62, coveredMs: 21 * HOUR, duringWork: 55.8, ...change});
const value = (cell: WorkCell) => ('value' in cell ? Math.round(cell.value * 100) / 100 : cell);

test("the issue's example: 62% over 21 hours of work is about 3% an hour, and the 38% left last about 13 hours of work", () => {
  const cells = workCells(work(), 38, 5 * DAY);
  assert.equal(value(cells.work), 21 * HOUR);
  assert.equal(value(cells.perwork), 2.95);
  assert.equal(Math.round(('value' in cells.workleft ? cells.workleft.value : 0) / HOUR * 10) / 10, 12.9);
  assert.equal(value(cells.during), 90);
});

test('the pace is taken over the work measured without gaps, not over all of it', () => {
  // Nine of the 21 hours fell into a gap between measurements, whose spending is not counted either.
  const cells = workCells(work({coveredMs: 12 * HOUR, consumed: 36}), 38, null);
  assert.equal(value(cells.perwork), 3);
  assert.equal(value(cells.work), 21 * HOUR, 'the hours are all of them');
});

test('each dash says why', () => {
  const none = (cell: WorkCell) => ('none' in cell ? cell.none : null);
  const unknown = workCells(work({ms: null}), 38, null);
  assert.deepEqual(Object.values(unknown).map(none), ['unknown', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(Object.values(workCells(work({ms: 0, coveredMs: 0, duringWork: 0}), 38, null)).map(value), [{none: 'none'}, {none: 'none'}, {none: 'none'}, 0], 'spent, and none of it while agents worked');
  const short = workCells(work({coveredMs: 29 * MIN}), 38, null);
  assert.deepEqual([none(short.perwork), none(short.workleft)], ['short', 'short']);
  assert.equal(none(workCells(work({coveredMs: WORK_PACE_FROM}), 38, null).perwork), null, 'half an hour is enough');
  const idle = workCells(work({consumed: 0, duringWork: 0}), 38, null);
  assert.deepEqual([value(idle.perwork), none(idle.workleft), none(idle.during)], [0, 'nospend', 'nospend']);
  assert.equal(none(workCells(work(), null, null).workleft), 'noend', 'no measurement at the end of a range');
  assert.equal(value(workCells(work(), 0, null).workleft), 0, 'nothing left, nothing to work on');
});

test('work enough to last beyond the reset says so, in a period up to now', () => {
  // About 12.9 hours of work left.
  assert.ok('untilReset' in workCells(work(), 38, 12 * HOUR).workleft, 'the reset comes first');
  assert.ok('value' in workCells(work(), 38, 13 * HOUR).workleft);
  assert.ok('value' in workCells(work(), 38, null).workleft, 'a range, or a reset already past');
});

test('over a range what is left is what was left at its end, and the reset is only ahead of a period up to now', () => {
  const now = from + 7 * DAY;
  const line = {work: work(), current: 80, remainingAtEnd: 38};
  const hoursLeft = (cells: ReturnType<typeof lineWork>) => (cells && 'value' in cells.workleft ? Math.round((cells.workleft.value / HOUR) * 10) / 10 : cells?.workleft);
  assert.equal(hoursLeft(lineWork(line, true, now + HOUR, now)), 12.9, 'at the end of the range, and no reset over a range');
  assert.equal(hoursLeft(lineWork(line, false, null, now)), 27.1, 'now');
  assert.ok(lineWork(line, false, now + HOUR, now)?.workleft && 'untilReset' in lineWork(line, false, now + HOUR, now)!.workleft);
  assert.equal(hoursLeft(lineWork(line, false, now - MIN, now)), 27.1, 'a reset already past, not measured after');
  assert.equal(lineWork({...line, work: null}, false, null, now), null, 'a hidden card');
});

test('a tooltip says since when work is known, and over how much work the pace is, only when that matters', () => {
  assert.deepEqual(workNotes(work(), from), {since: null, basis: null});
  assert.deepEqual(workNotes(work(), from - DAY), {since: from, basis: null}, 'known from later than the period begins');
  assert.deepEqual(workNotes(work({ms: null}), from - DAY), {since: null, basis: null}, 'not known at all is its own dash');
  assert.deepEqual(workNotes(work({coveredMs: 12 * HOUR}), from), {since: null, basis: 12 * HOUR});
  assert.deepEqual(workNotes(work({coveredMs: 21 * HOUR - 2 * MIN}), from), {since: null, basis: null}, 'a couple of minutes at the edges of the measurements');
});

test('hours of work are minutes within the hour, tenths up to ten, whole hours after, and never days', () => {
  setLocale('en');
  assert.deepEqual(
    [20_000, 45 * MIN, 2.5 * HOUR, 21 * HOUR, 150 * HOUR, 0].map(workHours),
    ['1m', '45m', '2.5h', '21h', '150h', '0m'],
  );
  setLocale('ru');
  assert.deepEqual([45 * MIN, 2.5 * HOUR, 150 * HOUR].map(workHours), ['45 мин', '2,5 ч', '150 ч']);
  setLocale('en');
});
