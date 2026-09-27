import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dashOf, lineWork, MIN_RATE, workCells, workNotes, WORK_PACE_FROM, type WorkCell} from '../lib/work';
import {rateText, shareText, workHours} from '../lib/format';
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
  assert.deepEqual(Object.values(workCells(work({ms: 0, coveredMs: 0, duringWork: 0}), 38, null)).map(value), [{none: 'none'}, {none: 'none'}, {none: 'none'}, {none: 'none'}], 'none worked: no share of theirs either');
  const short = workCells(work({coveredMs: 29 * MIN}), 38, null);
  assert.deepEqual([none(short.perwork), none(short.workleft), none(short.during)], ['short', 'short', 'short']);
  const inGaps = workCells(work({coveredMs: 0, duringWork: 0}), 38, null);
  assert.equal(none(inGaps.during), 'short', 'work all in gaps between measurements: not a share of 0');
  assert.equal(none(workCells(work({coveredMs: WORK_PACE_FROM}), 38, null).perwork), null, 'half an hour is enough');
  const idle = workCells(work({consumed: 0, duringWork: 0}), 38, null);
  assert.deepEqual([value(idle.perwork), none(idle.workleft), none(idle.during)], [0, 'nospend', 'nospend']);
  assert.equal(none(workCells(work({consumed: 0.1}), 38, null).workleft), 'slow', 'spent, but too little an hour of work to foresee');
  assert.equal(none(workCells(work({consumed: 0.63}), 38, null).workleft), 'slow', '0.03% an hour would last over a thousand hours');
  assert.ok('untilReset' in workCells(work({consumed: 0.63}), 38, 5 * DAY).workleft, 'however slow, it lasts to a reset that comes first');
  assert.ok('outlasts' in workCells(work({consumed: 0.63}), 38, null, 7 * DAY).workleft, 'and past a whole window');
  assert.equal(none(workCells(work({consumed: 21 * MIN_RATE}), 38, null).workleft), null);
  // 5% over 21 hours of work: the 78% left would last over 300 hours, more than a week's window.
  assert.deepEqual(workCells(work({consumed: 5}), 78, null, 7 * DAY).workleft, {outlasts: (78 / (5 / 21)) * HOUR, windowMs: 7 * DAY}, 'longer than a whole window, as over a range: it lasts to the reset');
  assert.ok('value' in workCells(work({consumed: 5}), 78, null, null).workleft, 'a window of no known length');
  assert.ok('untilReset' in workCells(work({consumed: 5}), 78, 2 * DAY, 7 * DAY).workleft, 'up to now, the reset comes first');
  // Five hours: 30% over two hours of work is 15% an hour, and the 80% left lasts over five hours; 90% spent would not.
  const session = (consumed: number, remaining: number) => workCells(work({ms: 2 * HOUR, coveredMs: 2 * HOUR, consumed, duringWork: consumed}), remaining, null, 5 * HOUR).workleft;
  assert.ok('outlasts' in session(30, 80), 'a pace far from too slow, still no forecast shorter than the window');
  assert.ok('value' in session(90, 80), 'what runs out within the window is foreseen');
  assert.deepEqual(workCells(work(), 0, null).workleft, {usedUp: true}, 'nothing left, nothing to work on');
  assert.deepEqual(workCells(work({coveredMs: 29 * MIN}), 0, null).workleft, {usedUp: true}, 'however the work went');
  assert.deepEqual(workCells(work({ms: 0, coveredMs: 0}), 0, null).workleft, {usedUp: true});
});

test('work enough to last beyond the reset says so, in a period up to now', () => {
  // About 12.9 hours of work left.
  assert.ok('untilReset' in workCells(work(), 38, 12 * HOUR).workleft, 'the reset comes first');
  assert.ok('value' in workCells(work(), 38, 13 * HOUR).workleft);
  assert.ok('value' in workCells(work(), 38, null).workleft, 'a range, or a reset already past');
});

test('over a range what is left is what was left at its end, and the reset is only ahead of a period up to now', () => {
  const now = from + 7 * DAY;
  const line = {work: work(), current: 80, remainingAtEnd: 38, minutes: 7 * 24 * 60};
  const hoursLeft = (cells: ReturnType<typeof lineWork>) => (cells && 'value' in cells.workleft ? Math.round((cells.workleft.value / HOUR) * 10) / 10 : cells?.workleft);
  assert.equal(hoursLeft(lineWork(line, true, now + HOUR, now)), 12.9, 'at the end of the range, and no reset over a range');
  assert.equal(hoursLeft(lineWork(line, false, null, now)), 27.1, 'now');
  assert.ok(lineWork(line, false, now + HOUR, now)?.workleft && 'untilReset' in lineWork(line, false, now + HOUR, now)!.workleft);
  assert.deepEqual(lineWork(line, false, now - MIN, now)?.workleft, {none: 'awaiting'}, 'a reset already past, not measured after: what is left is not known');
  assert.equal(value(lineWork(line, false, now - MIN, now)!.perwork), 2.95, 'the pace over the period is');
  assert.equal(lineWork({...line, work: null}, false, null, now), null, 'a hidden card');
  assert.equal(lineWork({...line, remainingAtEnd: null}, true, null, now), null, 'a range with no measurement has no end to foresee from');
});

test('a tooltip says since when work is known, over how much work the pace is, and that little came during work, only when that matters', () => {
  const none = {since: null, basis: null, share: null};
  assert.deepEqual(workNotes(work(), from), none);
  assert.deepEqual(workNotes(work(), from - DAY), {...none, since: from}, 'known from later than the period begins');
  assert.deepEqual(workNotes(work({ms: null}), from - DAY), none, 'not known at all is its own dash');
  assert.deepEqual(workNotes(work({coveredMs: 12 * HOUR}), from), {...none, basis: 12 * HOUR});
  assert.deepEqual(workNotes(work({coveredMs: 21 * HOUR - 2 * MIN}), from), none, 'a couple of minutes at the edges of the measurements');
  assert.deepEqual(workNotes(work({duringWork: 6.2}), from), {...none, share: 10}, 'a tenth of the spending during work');
  assert.deepEqual(workNotes(work({duringWork: 31}), from), none, 'half of it');
  assert.deepEqual(workNotes(work({duringWork: 30.8}), from), none, '49.7%, told as half');
  assert.deepEqual(workNotes(work({duringWork: 0, coveredMs: 29 * MIN}), from), none, 'too little work measured to tell a share');
});

test('a dash about the whole period says since when, where work is known from later', () => {
  const since = from + DAY;
  assert.deepEqual(dashOf('none', null), {text: 'none', knownFrom: null});
  assert.deepEqual(dashOf('none', since), {text: 'noneSince', knownFrom: null}, 'none worked since then; before is not known');
  assert.deepEqual(dashOf('nospend', since), {text: 'nospendSince', knownFrom: null}, 'the spending before is in the period’s');
  assert.deepEqual(dashOf('short', since), {text: 'short', knownFrom: since}, 'a reason of its own, with since when as a line');
  assert.deepEqual(dashOf('slow', null), {text: 'slow', knownFrom: null});
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

test('a pace too small to foresee from reads "≈ 0" wherever it is told, and one that foresees never reads 0', () => {
  setLocale('en');
  assert.deepEqual([0, 0.001, 0.03, MIN_RATE, 2.95].map(rateText), ['0', '≈ 0', '≈ 0', '0.1', '3']);
  assert.deepEqual([0, 0.3, 0.5, 49.6].map(shareText), ['0', '< 1', '1', '50'], 'a share above 0 never reads 0 either');
  for (const consumed of [0.21, 0.63, 1, 5]) {
    const cells = workCells(work({consumed}), 38, null);
    const pace = 'value' in cells.perwork ? cells.perwork.value : 0;
    assert.equal(rateText(pace) === '≈ 0', 'none' in cells.workleft && cells.workleft.none === 'slow', `${consumed}% over 21 hours`);
  }
});
