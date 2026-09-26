import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Sample} from '../domain/quota.js';
import {activity, barOf, overlap, seriesWork, union, workTime, type Activity, type Stretch} from '../domain/work.js';

const at = (time: string) => Date.parse(`2026-09-22T${time}:00Z`);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A stretch of an agent of its own, unless `change` names one. */
let agent = 0;
const stretch = (from: number, to: number, change: Partial<Stretch> = {}): Stretch => ({
  session: ++agent,
  source: 'codex:1',
  device: 'laptop',
  user: 'ann',
  origin: 'terminal',
  project: 'quotum',
  folder: null,
  startedAt: 0,
  from,
  to,
  ...change,
});

const sample = (time: string, used: number, change: Partial<Sample> = {}): Sample => ({
  sourceId: 'codex:1',
  provider: 'codex',
  id: 'weekly',
  kind: 'weekly',
  label: null,
  at: at(time),
  staleAfterMs: 20 * MIN,
  used,
  remaining: 100 - used,
  resetAt: at('23:00') + 86_400_000,
  minutes: 10080,
  ...change,
});

/** A group's parts of each cell, by the cell's time. */
const parts = (result: Activity, dimension: keyof Activity['by'], key: string) =>
  Object.fromEntries(result.by[dimension].find(g => g.key === key)!.cells.map(([cell, ms]) => [new Date(cell).toISOString().slice(11, 16), ms / MIN]));

/** The invariant of the stack: the parts of every cell add up to its work, each part within a millisecond. */
function assertStacks(result: Activity) {
  for (const dimension of ['source', 'project', 'device'] as const) {
    for (const [cell, work] of result.cells) {
      const groups = result.by[dimension].flatMap(g => g.cells.filter(([c]) => c === cell));
      const sum = groups.reduce((total, [, ms]) => total + ms, 0);
      assert.ok(Math.abs(sum - work) <= groups.length, `${dimension} at ${new Date(cell).toISOString()}: ${sum} of ${work}`);
    }
  }
}

test('the time any agent worked counts each moment once', () => {
  assert.equal(workTime([]), 0);
  assert.equal(workTime([stretch(0, 100), stretch(20, 50)]), 100, 'one within another');
  assert.equal(workTime([stretch(50, 100), stretch(0, 50)]), 100, 'one after another, in any order');
  assert.equal(workTime([stretch(0, 10), stretch(20, 30)]), 20, 'apart');
  assert.equal(workTime([stretch(0, 60), stretch(40, 100), stretch(200, 210)]), 110, 'overlapping, then apart');
  assert.deepEqual(union([stretch(50, 100), stretch(0, 50), stretch(120, 130), stretch(125, 128)]), [
    [0, 100],
    [120, 130],
  ]);
});

test('the overlap of a span with the union reads only what lies within the span', () => {
  const worked = union([stretch(0, 100), stretch(200, 300), stretch(400, 500)]);
  assert.equal(overlap(worked, 50, 250), 100);
  assert.equal(overlap(worked, 100, 200), 0, 'between the stretches');
  assert.equal(overlap(worked, 0, 1000), 300);
  assert.equal(overlap(worked, 450, 1000), 50);
  assert.equal(overlap([], 0, 1000), 0);
});

test('two agents half an hour together: work once, agent time twice, and the moment split between them', () => {
  const stretches = [stretch(at('10:00'), at('11:00')), stretch(at('10:30'), at('11:30'), {project: 'billing', device: 'server'})];
  const result = activity(stretches, {from: at('09:00'), to: at('12:00')}, HOUR, new Map());
  assert.equal(result.workMs, 1.5 * HOUR);
  assert.equal(result.agentMs, 2 * HOUR);
  assert.equal(Math.round((result.agentMs / result.workMs) * 100) / 100, 1.33, 'at once, on average');
  assert.equal(result.agents, 2);
  assert.deepEqual(
    result.cells.map(([cell, work, agentTime, agents]) => [new Date(cell).toISOString().slice(11, 16), work / MIN, agentTime / MIN, agents]),
    [
      ['10:00', 60, 90, 2],
      ['11:00', 30, 30, 1],
    ],
  );
  // In the hour they overlap, each has half of the half hour they worked together.
  assert.deepEqual(parts(result, 'project', '"quotum"'), {'10:00': 45});
  assert.deepEqual(parts(result, 'project', '"billing"'), {'10:00': 15, '11:00': 30});
  assert.deepEqual(parts(result, 'source', 'codex:1'), {'10:00': 60, '11:00': 30});
  // Each group's own hours: how long its agents worked, overlaps with others' not split.
  assert.deepEqual(
    result.by.project.map(g => [g.name, g.ms / MIN]),
    [
      ['billing', 60],
      ['quotum', 60],
    ],
  );
  assertStacks(result);
});

test('an agent counts once in a bar and in the period, however many stretches it worked', () => {
  const stretches = [stretch(at('10:00'), at('10:10'), {session: 7}), stretch(at('10:40'), at('11:20'), {session: 7}), stretch(at('10:20'), at('10:30'))];
  const result = activity(stretches, {from: at('10:00'), to: at('12:00')}, HOUR, new Map());
  assert.equal(result.agents, 2);
  assert.deepEqual(
    result.cells.map(([cell, , , agents]) => [new Date(cell).toISOString().slice(11, 16), agents]),
    [
      ['10:00', 2],
      ['11:00', 1],
    ],
  );
});

test('a period is drawn in bars of up to an hour, as long as there are enough of them, or in its cells when they are longer', () => {
  assert.equal(barOf(5 * MIN, 24 * HOUR), HOUR, 'a day in hours');
  assert.equal(barOf(5 * MIN, 24 * HOUR - 3 * MIN), HOUR, 'a few minutes short of the day');
  assert.equal(barOf(30 * MIN, 7 * 24 * HOUR), HOUR, 'a week in hours');
  assert.equal(barOf(2 * HOUR, 30 * 24 * HOUR), 2 * HOUR, 'a month in its cells');
  assert.equal(barOf(5 * MIN, 12 * HOUR), 30 * MIN, 'too few hours in half a day');
  assert.equal(barOf(MIN, 2 * HOUR), 5 * MIN);
  assert.equal(barOf(MIN, 15 * MIN), MIN, 'never shorter than a cell');
});

test('stretches are cut at the edges of cells and of the known part of the period', () => {
  const result = activity([stretch(at('08:40'), at('10:20'))], {from: at('09:00'), to: at('10:10')}, 30 * MIN, new Map());
  assert.equal(result.workMs, 70 * MIN);
  assert.deepEqual(
    result.cells.map(([cell, work]) => [new Date(cell).toISOString().slice(11, 16), work / MIN]),
    [
      ['09:00', 30],
      ['09:30', 30],
      ['10:00', 10],
    ],
  );
  assert.deepEqual(parts(result, 'device', 'laptop'), {'09:00': 30, '09:30': 30, '10:00': 10});
});

test('cells are aligned to their length, so the first one of a period from any moment is partial', () => {
  const result = activity([stretch(at('09:05'), at('09:40'))], {from: at('09:05'), to: at('09:40')}, 15 * MIN, new Map());
  assert.deepEqual(
    result.cells.map(([cell, work]) => [new Date(cell).toISOString().slice(11, 16), work / MIN]),
    [
      ['09:00', 10],
      ['09:15', 15],
      ['09:30', 10],
    ],
  );
});

test('projects and machines beyond seven are one group whose own hours are their union', () => {
  // Nine projects, each an hour longer than the next; the last two worked at the same time.
  const stretches = Array.from({length: 9}, (_, i) => stretch(at('00:00') + i * 10 * HOUR, at('00:00') + i * 10 * HOUR + (9 - i) * HOUR, {project: `p${i}`}));
  stretches[8] = stretch(stretches[7].from, stretches[7].from + HOUR, {project: 'p8'});
  const result = activity(stretches, {from: at('00:00'), to: at('00:00') + 100 * HOUR}, 2 * HOUR, new Map());
  assert.deepEqual(
    result.by.project.map(g => g.name ?? `other ${g.count}`),
    ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'other 2'],
  );
  const other = result.by.project.at(-1)!;
  assert.equal(other.other, true);
  assert.equal(other.ms, 2 * HOUR, 'their union, not 2 h + 1 h');
  // In its cell the two had half an hour together and one of them another half hour: the whole hour is theirs.
  assert.deepEqual(
    other.cells.map(([cell, ms]) => [(cell - at('00:00')) / HOUR, ms / MIN]),
    [[70, 120]],
  );
  assertStacks(result);
});

test('every subscription keeps its own group, however many', () => {
  const stretches = Array.from({length: 9}, (_, i) => stretch(at('10:00'), at('10:00') + (i + 1) * MIN, {source: `claude:${i}`}));
  const result = activity(stretches, {from: at('10:00'), to: at('11:00')}, HOUR, new Map());
  assert.equal(result.by.source.length, 9);
  assert.ok(result.by.source.every(g => !g.other));
  assert.deepEqual(
    result.by.source.map(g => g.key),
    stretches.map(s => s.source).reverse(),
    'the longest first',
  );
  assertStacks(result);
});

test('work outside any project is a group of its own, and one project name of two people is one group', () => {
  const stretches = [
    stretch(at('10:00'), at('10:30'), {project: null}),
    stretch(at('10:00'), at('10:20'), {project: 'null'}),
    stretch(at('10:00'), at('10:10'), {project: 'quotum', user: 'ann'}),
    stretch(at('10:30'), at('10:40'), {project: 'quotum', user: 'ben', device: 'ben-mac'}),
  ];
  const names = new Map([
    ['laptop', 'Ann laptop'],
    ['ben-mac', 'Ben mac'],
  ]);
  const result = activity(stretches, {from: at('10:00'), to: at('11:00')}, HOUR, names);
  assert.deepEqual(
    result.by.project.map(g => [g.key, g.name, g.ms / MIN]),
    [
      ['null', null, 30],
      ['"null"', 'null', 20],
      ['"quotum"', 'quotum', 20],
    ],
  );
  assert.deepEqual(
    result.by.device.map(g => [g.name, g.ms / MIN]),
    [
      ['Ann laptop', 30],
      ['Ben mac', 10],
    ],
  );
  assert.deepEqual(
    result.by.source.map(g => g.name),
    [null],
  );
  assertStacks(result);
});

test('no work: empty cells and groups', () => {
  const result = activity([], {from: at('10:00'), to: at('11:00')}, MIN, new Map());
  assert.deepEqual(result, {barMs: MIN, workMs: 0, agentMs: 0, agents: 0, cells: [], by: {source: [], project: [], device: []}});
});

test("a window's pace basis: only steps edge proves, from the known part on, and the work within them", () => {
  const worked = union([stretch(at('10:05'), at('10:15')), stretch(at('11:00'), at('11:30'))]);
  // Each step, up to the sample it is written by.
  const samples = [
    sample('09:50', 10),
    sample('10:00', 11), // begins before the known part: not counted
    sample('10:10', 13), // work within: counted, during work
    sample('10:20', 14), // work within: counted, during work
    sample('10:30', 15), // no work: counted, not during work
    sample('11:10', 19), // a gap of 40 minutes: not counted
    sample('11:20', 21), // work within: counted, during work
    sample('11:25', 22, {resetAt: at('23:00') + 3 * 86_400_000}), // a reset: not counted
  ];
  const result = seriesWork(samples, worked, {from: at('10:00'), to: at('12:00')});
  assert.equal(result.from, at('10:00'));
  assert.equal(result.ms, 40 * MIN);
  assert.equal(result.consumed, 2 + 1 + 1 + 2);
  assert.equal(result.coveredMs, (5 + 5 + 10) * MIN, 'the work in the gap and the reset is not a basis');
  assert.equal(result.duringWork, 2 + 1 + 2);
});

test('nothing of the period known: no hours, and since when it is', () => {
  const since = at('12:00');
  assert.deepEqual(seriesWork([sample('10:00', 10), sample('10:10', 12)], [], {from: since, to: at('11:00')}), {
    from: since,
    ms: null,
    consumed: 0,
    coveredMs: 0,
    duringWork: 0,
  });
  assert.equal(seriesWork([], [], {from: since, to: at('13:00')}).ms, 0, 'known, with no work');
});
