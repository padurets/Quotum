import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {forecastOf, started as hubStarted, uncounted as hubUncounted, type Memory} from '../../server/domain/forecast.js';
import {told} from '../../server/forecasts.js';
import {lineOf, outlook, uncounted as boardUncounted} from '../../ui/lib/forecast.js';
import {started as boardStarted} from '../../ui/lib/plan.js';
import type {Win} from '../../ui/lib/types.js';

// The hub and the board keep copies of two rules, as neither's code reaches the other's:
// these cases hold them to the same answers.

const MIN = 60_000;
const DAY = 86_400_000;
const at = Date.parse('2026-09-28T12:00:00Z');
const win = (change: Partial<Win> = {}): Win => ({id: 'weekly', kind: 'weekly', label: null, used: 0, remaining: 100, resetAt: at + 7 * DAY, minutes: 10080, ...change});

test('a window has started the same on the hub and on the board', () => {
  const cases: [string, Win, boolean][] = [
    ['a rolling window not started: its reset a week from the moment', win(), false],
    ['started a minute ago: within the tolerance', win({resetAt: at + 7 * DAY - MIN}), false],
    ['started three minutes ago', win({resetAt: at + 7 * DAY - 3 * MIN}), true],
    ['started days ago', win({resetAt: at + 2 * DAY, used: 40, remaining: 60}), true],
    ['no reset time', win({resetAt: null}), false],
    ['no length', win({minutes: null}), false],
  ];
  for (const [what, w, expected] of cases) {
    assert.equal(hubStarted(w, at), expected, `hub: ${what}`);
    assert.equal(boardStarted(w, at), expected, `board: ${what}`);
  }
});

test("a window's time counts, or cannot, the same on the hub and on the board", () => {
  const reset = at + 3 * DAY;
  const weekly = (used: number, change: Partial<Win> = {}) => win({used, remaining: 100 - used, resetAt: reset, ...change});
  const fable = (used: number) => win({id: 'weekly:fable', label: 'Fable', used, remaining: 100 - used, resetAt: reset});
  const cases: [string, Win[], Win, 'atZero' | 'weeklyAtZero' | null][] = [
    ['the weekly and a model\'s window reset together, the weekly at zero', [weekly(100), fable(30)], fable(30), 'weeklyAtZero'],
    ['the weekly resets 30 s sooner', [weekly(100, {resetAt: reset - 30_000}), fable(30)], fable(30), 'weeklyAtZero'],
    ['the weekly resets a day later', [weekly(100, {resetAt: reset + DAY}), fable(30)], fable(30), 'weeklyAtZero'],
    ['a window at 99.5', [weekly(99.5)], weekly(99.5), 'atZero'],
    ['the weekly resets 90 s sooner', [weekly(100, {resetAt: reset - 90_000}), fable(30)], fable(30), null],
    ['the weekly resets a day sooner', [weekly(100, {resetAt: reset - DAY}), fable(30)], fable(30), null],
    ['the weekly has no reset time', [weekly(100, {resetAt: null}), fable(30)], fable(30), null],
    ['every window labelled (Antigravity)', [win({id: 'gemini:weekly', label: 'Gemini', used: 100, remaining: 0, resetAt: reset}), fable(30)], fable(30), null],
    ['the weekly at 99.4', [weekly(99.4), fable(30)], fable(30), null],
    ['a window at 99.4', [weekly(99.4)], weekly(99.4), null],
  ];
  for (const [what, windows, window, expected] of cases) {
    assert.equal(hubUncounted(windows, window), expected, `hub: ${what}`);
    assert.equal(boardUncounted(windows, window), expected, `board: ${what}`);
  }
});

type Golden = {id: string; t: string; memoryIn: Memory | null; expected: {state: string; tone: 'red' | 'yellow' | null}; samples: [number, number, number, number][]};

test("the board says the golden cases as the reference did: left or just enough, and the tone", () => {
  const golden = JSON.parse(readFileSync(new URL('../../server/test/fixtures/forecast-golden.json', import.meta.url), 'utf8')) as {cases: Golden[]};
  for (const c of golden.cases) {
    const t = Date.parse(c.t);
    const samples = c.samples.map(([at, used, resetAt, minutes]) => ({at: at * MIN, used, resetAt: resetAt * MIN, minutes}));
    const ahead = told(forecastOf({samples, plan: null, since: null}, t, c.memoryIn).forecast);
    const last = samples.filter(s => s.at <= t).at(-1)!;
    const live = win({used: last.used, remaining: 100 - last.used, resetAt: last.resetAt, minutes: last.minutes});
    const said = outlook(live, last.at, t, ahead, {windows: [live], freeResets: 0, announced: null});
    assert.equal(said.key, c.expected.state, c.id);
    assert.equal(said.tone, c.expected.tone === 'red' ? 'v-crit' : c.expected.tone === 'yellow' ? 'v-warn' : c.expected.state === 'usedUp' ? 'v-crit' : '', c.id);
  }
});

test("the board reads the hub's line as the model drew it, and a window's forecast stays within a few kilobytes", () => {
  const golden = JSON.parse(readFileSync(new URL('../../server/test/fixtures/forecast-golden.json', import.meta.url), 'utf8')) as {cases: Golden[]};
  let lines = 0;
  for (const c of golden.cases) {
    const samples = c.samples.map(([at, used, resetAt, minutes]) => ({at: at * MIN, used, resetAt: resetAt * MIN, minutes}));
    const drawn = forecastOf({samples, plan: null, since: null}, Date.parse(c.t), c.memoryIn).forecast;
    const ahead = told(drawn);
    assert.ok(JSON.stringify(ahead).length <= 3 * 1024, `${c.id}: ${JSON.stringify(ahead).length} bytes`);
    if (!drawn.points) continue;
    lines++;
    const read = lineOf(ahead);
    assert.equal(read.length, drawn.points.length, c.id);
    for (let i = 0; i < read.length; i++) {
      assert.ok(Math.abs(read[i][0] - drawn.points[i][0]) <= 60, `${c.id}: point ${i} at ${read[i][0] - drawn.points[i][0]} ms`);
      assert.ok(Math.abs(read[i][1] - drawn.points[i][1]) <= 0.05, `${c.id}: point ${i} left ${read[i][1]} against ${drawn.points[i][1]}`);
    }
  }
  assert.ok(lines >= 10, `${lines} cases with a line`);
});
