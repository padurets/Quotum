import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDLE_SCRIPT_MS_PER_SECOND, idleProblems, LATENCY_P95_MS, measuredProblems, percentile, type Idle} from '../budget.js';
import type {Counted} from '../probe.js';

const MIN = 60_000;
const part = (region: string, kind: string | null, count: number): Counted => ({
  node: kind ? `span[data-time=${kind}]#1` : 'div#2',
  time: kind !== null,
  kind,
  region,
  count,
});

/** Two minutes of a page that only shows time, on a history of five-minute cells. */
const idle = (change: Partial<Idle> = {}): Idle => ({
  from: 10 * MIN + 30_000,
  to: 12 * MIN + 30_000,
  cellMs: 5 * MIN,
  requests: {count: 0, byPath: {}},
  events: {ping: 5},
  renders: [part('card:s1', 'mark', 3), part('analytics', 'chart', 1)],
  mutations: [part('agents', 'since', 2)],
  scriptMsPerSecond: IDLE_SCRIPT_MS_PER_SECOND,
  ...change,
});

test('an idle page within its budget has nothing to answer for', () => {
  assert.deepEqual(idleProblems(idle()), []);
});

test('an idle page answers for asking, being told, and working outside what shows time', () => {
  const problems = idleProblems(
    idle({
      requests: {count: 2, byPath: {'/api/overview': 2}},
      events: {ping: 5, card: 1},
      renders: [part('header', null, 1)],
      mutations: [part('card:s2', null, 3)],
      scriptMsPerSecond: IDLE_SCRIPT_MS_PER_SECOND + 0.01,
    }),
  );
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.match(problems[0], /asked the hub 2 times/);
  assert.match(problems[1], /card ×1/);
  assert.match(problems[2], /rendered outside what shows time: header/);
  assert.match(problems[3], /changed outside what shows time: card:s2/);
  assert.match(problems[4], /script took/);
});

test('a label shows time at most once a minute, the chart and the table once a cell', () => {
  // From 10:30 to 12:30 of an hour on five-minute cells: two minutes, no boundary of a cell.
  assert.deepEqual(idleProblems(idle({renders: [part('card:s1', 'ago', 3)]})), [], 'minutes + 1');
  assert.equal(idleProblems(idle({renders: [part('card:s1', 'ago', 4)]})).length, 1);
  assert.deepEqual(idleProblems(idle({mutations: [part('analytics', 'table', 1)]})), [], 'no boundary in the window: once, as it opens');
  assert.equal(idleProblems(idle({mutations: [part('analytics', 'table', 2)]})).length, 1, 'a chart that moves each minute is too busy');
  assert.deepEqual(idleProblems(idle({from: 14 * MIN, to: 16 * MIN, renders: [part('analytics', 'chart', 2)]})), [], 'one boundary: twice');
});

test('measurements of a card show on it in time and render nothing of another card or the header', () => {
  const quick = Array.from({length: 20}, (_, i) => 100 + i * 10);
  const renders = [part('card:s1', null, 20), part('agents', null, 1), part('analytics', null, 3), part('card:s2', 'mark', 2)];
  assert.deepEqual(measuredProblems('s1', quick, renders, [part('card:s1', null, 20)]), []);
  assert.equal(percentile(quick, 0.95), 280);
  assert.equal(percentile(quick, 0.5), 190);
  const late = [...quick.slice(0, 18), LATENCY_P95_MS + 1, Infinity];
  assert.match(measuredProblems('s1', late, [], [])[0], /95th percentile/);
  const busy = measuredProblems('s1', quick, [part('card:s2', null, 1), part('page', null, 1)], [part('header', null, 1), part('analytics', null, 4)]);
  assert.equal(busy.length, 2, busy.join('\n'));
  assert.match(busy[0], /rendered card:s2 .* page /);
  assert.match(busy[1], /changed header/);
});
