import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dashOf, lineWork, MIN_RATE, workCells, workLeftChangesAt, workNotes, workText, WORK_PACE_FROM, type WorkCell} from '../lib/work';
import {rateText, shareText, stamp, workAbout, workHours} from '../lib/format';
import {setLocale, t} from '../i18n';
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
  // 1% left at 0.03% an hour: some 33 hours of work, short of a reset in five days or of a week.
  assert.equal(Math.round((value(workCells(work({consumed: 0.63}), 1, 5 * DAY).workleft) as number) / HOUR), 33, 'however slow, what runs out before the reset is named');
  assert.ok('value' in workCells(work({consumed: 0.63}), 1, null, 7 * DAY).workleft, 'and what runs out within a window');
  assert.ok('value' in workCells(work({consumed: 0.63}), 1, null).workleft, 'with neither, some 33 hours are still short of a week');
  // 0.03% an hour: 5% lasts some 167 hours, 5.1% some 170, past a week.
  assert.ok('value' in workCells(work({consumed: 0.63}), 5, null).workleft);
  assert.equal(none(workCells(work({consumed: 0.63}), 5.1, null).workleft), 'slow', 'a week bounds what is named');
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
  assert.deepEqual(lineWork({...line, work: work({ms: 0, coveredMs: 0})}, false, now - MIN, now)?.workleft, {none: 'none'}, 'with none of them working, none worked');
  assert.deepEqual(lineWork({...line, current: 0}, false, now - MIN, now)?.workleft, {none: 'awaiting'}, 'used up before the reset, not since');
  assert.deepEqual(lineWork({...line, current: 0, work: work({ms: 0, coveredMs: 0})}, false, now - MIN, now)?.workleft, {none: 'none'}, 'used up before the reset, with none of them working: that none worked, not used up');
  assert.deepEqual(lineWork(line, false, now, now)?.workleft, {none: 'awaiting'}, 'the reset right now');
  assert.equal(hoursLeft(lineWork(line, true, now - MIN, now)), 12.9, 'a range is of its own end, whatever came after');
  assert.equal(lineWork({...line, work: null}, false, null, now), null, 'a hidden card');
  assert.equal(lineWork({...line, remainingAtEnd: null}, true, null, now), null, 'a range with no measurement has no end to foresee from');
});

test('the hours of work left read otherwise when the reset comes nearer than they are, and when it goes by', () => {
  const now = from + 7 * DAY;
  // About 27.1 hours of work left now (80% at 2.95% an hour).
  const line = {work: work(), current: 80, remainingAtEnd: 38, minutes: 7 * 24 * 60};
  const left = lineWork(line, false, now + 2 * DAY, now)!.workleft as {value: number};
  const turns = workLeftChangesAt(line, now + 2 * DAY, now)!;
  assert.equal(turns, Math.ceil(now + 2 * DAY - left.value), 'when the reset is as near as the hours');
  assert.ok('value' in lineWork(line, false, now + 2 * DAY, turns - 1)!.workleft && 'untilReset' in lineWork(line, false, now + 2 * DAY, turns)!.workleft, 'named until then, lasting to the reset from then');
  assert.equal(workLeftChangesAt(line, now + HOUR, now), now + HOUR, 'lasting to the reset already: it waits for a measurement once the reset goes by');
  assert.equal(workLeftChangesAt(line, now - MIN, now), null, 'waiting: only a measurement changes it');
  assert.equal(workLeftChangesAt(line, null, now), null, 'no reset told');
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
  assert.deepEqual(dashOf('awaiting', since), {text: 'awaiting', knownFrom: null}, 'waiting for a measurement is not about the work known');
});

test('hours of work are minutes within the hour, tenths up to ten, whole hours after, and never days', () => {
  setLocale('en');
  assert.deepEqual(
    [20_000, 30_000, 59_000, MIN, 45 * MIN, 2.5 * HOUR, 21 * HOUR, 150 * HOUR, 0].map(workHours),
    ['< 1m', '< 1m', '< 1m', '1m', '45m', '2.5h', '21h', '150h', '0m'],
    'two agents half a minute each are not a minute each',
  );
  assert.deepEqual([30_000, 45 * MIN].map(workAbout), ['< 1m', '~45m'], 'foreseen, about so many, but under a minute as it is');
  setLocale('ru');
  assert.deepEqual([20_000, 45 * MIN, 2.5 * HOUR, 150 * HOUR].map(workHours), ['< 1 мин', '45 мин', '2,5 ч', '150 ч']);
  setLocale('en');
});

test('a pace under a twentieth reads "≈ 0" and, with nothing to bound the hundreds of hours it would last, foresees none; one above never reads 0', () => {
  setLocale('en');
  assert.deepEqual(
    [0, 0.001, 0.03, MIN_RATE, 0.07, 0.149, 0.995, 2.95].map(rateText),
    ['0', '≈ 0', '≈ 0', '0.05', '0.07', '0.15', '1', '3'],
    'hundredths under 1: at a tenth, 0.05 would read as twice what it is',
  );
  assert.deepEqual([0, 0.3, 0.5, 49.6].map(shareText), ['0', '< 1', '1', '50'], 'a share above 0 never reads 0 either');
  for (const consumed of [0.21, 0.63, 1, 5]) {
    const cells = workCells(work({consumed}), 38, null);
    const pace = 'value' in cells.perwork ? cells.perwork.value : 0;
    assert.equal(rateText(pace) === '≈ 0', 'none' in cells.workleft && cells.workleft.none === 'slow', `${consumed}% over 21 hours`);
  }
});

test('a cell says what it foresees and its tooltip why, a part a line', () => {
  setLocale('en');
  const resetAt = from + 5 * DAY;
  const reset = stamp(resetAt);
  const lines = (cell: {title?: string}) => cell.title?.split('\n') ?? [];
  const basis = (value: string) => t('work.basis', {value});
  const under = t('work.basisUnder', {value: '0.05'});
  // Some 59 hours at a pace that reads "≈ 0": named, with how small the pace is.
  const ledger = workText('workleft', {value: 59 * HOUR}, work({consumed: 0.8}), from, resetAt, 0.038);
  assert.deepEqual([ledger.content, lines(ledger)], [t('work.left', {time: '~59h'}), [under]]);
  assert.deepEqual(lines(workText('workleft', {value: 13 * HOUR}, work(), from, resetAt, 2.95)), [basis('3')], 'a pace that reads, told as it reads');
  // Past the reset, or a whole window: as slow, no hours, only that they last; at a pace that reads, their number.
  assert.deepEqual(lines(workText('workleft', {untilReset: 2000 * HOUR}, work(), from, resetAt, 0.019)), [t('work.untilResetSlow', {reset}), under]);
  assert.deepEqual(lines(workText('workleft', {untilReset: 150 * HOUR}, work(), from, resetAt, 0.25)), [t('work.untilResetHint', {time: '~150h', reset}), basis('0.25')]);
  assert.deepEqual(lines(workText('workleft', {outlasts: 2000 * HOUR, windowMs: 7 * DAY}, work(), from, null, 0.019)), [t('work.outlastsSlow', {window: '7d'}), under]);
  assert.deepEqual(lines(workText('workleft', {outlasts: 782 * HOUR, windowMs: 7 * DAY}, work(), from, null, 0.1)), [t('work.outlastsHint', {time: '~782h', window: '7d'}), basis('0.1')]);
  assert.equal(workText('workleft', {value: 30_000}, work(), from, null, 60).content, t('work.left', {time: '< 1m'}), 'under a minute, not about it');
  assert.deepEqual(workText('workleft', {usedUp: true}, work(), from, null, 3), {content: t('work.usedUp')}, 'used up, with nothing to add');
  // The pace itself, to a hundredth under 1.
  assert.equal(workText('perwork', {value: 0.07}, work(), from, null, 0.07).content, t('table.perHour', {value: '0.07'}));
  // A share of the spending during work: none at all, or little, told by the pace and the forecast, not by the hours.
  const none = work({duringWork: 0});
  assert.deepEqual(lines(workText('perwork', {value: 3}, none, from, null, 3)), [t('work.noShare')]);
  assert.deepEqual(lines(workText('workleft', {value: 13 * HOUR}, none, from, null, 3)), [basis('3'), t('work.noShare')]);
  assert.deepEqual(lines(workText('perwork', {value: 3}, work({duringWork: 6.2}), from, null, 3)), [t('work.lowShare', {value: '10'})]);
  assert.deepEqual(lines(workText('during', {value: 90}, work(), from, null, 3)), [t('work.upperBound')]);
  // Taken over less work than the hours shown, and work known from later than the period begins: a line each, the hours of work too.
  const later = work({coveredMs: 12 * HOUR});
  assert.deepEqual(lines(workText('workleft', {value: 13 * HOUR}, later, from - DAY, null, 3)), [basis('3'), t('work.basisMeasured', {time: '12h'}), t('work.since', {time: stamp(from)})]);
  assert.deepEqual(lines(workText('work', {value: 21 * HOUR}, later, from - DAY, null, 3)), [t('work.since', {time: stamp(from)})]);
  assert.equal(workText('work', {value: 21 * HOUR}, none, from, null, 3).title, undefined);
  // Each dash says why.
  const dash = (reason: Parameters<typeof dashOf>[0] | 'unknown', periodFrom = from) => workText('workleft', {none: reason}, work(), periodFrom, null, null);
  assert.deepEqual(dash('slow'), {content: '—', title: [t('work.slow'), under].join('\n')}, 'over a week of work, and how small the pace is');
  assert.deepEqual(dash('none', from - DAY), {content: '—', title: t('work.noneSince', {time: stamp(from)})}, 'none since work is known');
  assert.deepEqual(dash('none'), {content: '—', title: t('work.none')});
  assert.deepEqual(dash('short'), {content: '—', title: t('work.short')});
  assert.deepEqual(dash('short', from - DAY), {content: '—', title: [t('work.short'), t('work.since', {time: stamp(from)})].join('\n')});
  assert.deepEqual(dash('nospend'), {content: '—', title: t('work.noSpend')});
  assert.deepEqual(dash('nospend', from - DAY), {content: '—', title: t('work.noSpendSince', {time: stamp(from)})});
  assert.deepEqual(dash('awaiting', from - DAY), {content: '—', title: t('forecast.awaiting')}, 'waiting for a measurement, not about the work known');
  assert.deepEqual(dash('unknown'), {content: '—', title: t('work.unknown', {time: stamp(from)})});
});
