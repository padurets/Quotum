import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FADE_FOR, PULSE_FOR} from '../../ui/lib/quota.js';
import {hourShift} from '../../server/forecasts.js';
import {DOT_STILL_AFTER, foreseenAt, SETTLE_MS, stillFrom, stillProblems, warmUntil} from '../still.js';
import {scriptPerSecond, tally} from '../report.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('the page is counted once every dot has faded out, and not before it settled', () => {
  const opened = 10 * HOUR;
  const cards = [
    {id: 'a', successAt: opened - 5 * MIN, staleAfterMs: 3 * HOUR, windows: []},
    {id: 'b', successAt: opened - 2 * HOUR, staleAfterMs: 7 * MIN, windows: []},
    {id: 'c', successAt: null, staleAfterMs: null, windows: []},
  ];
  assert.equal(DOT_STILL_AFTER, PULSE_FOR + FADE_FOR + 30_000);
  assert.equal(warmUntil(cards, opened), opened - 5 * MIN + DOT_STILL_AFTER);
  assert.equal(warmUntil([cards[1], cards[2]], opened), opened + SETTLE_MS, 'long faded: it only settles');
});

test('a stand that would change by itself during the window is told, card by card', () => {
  const from = 10 * HOUR;
  const to = from + 2 * MIN;
  const still = {id: 'still', successAt: from - 6 * MIN, staleAfterMs: 3 * HOUR, windows: [{resetAt: from + 3 * HOUR}, {resetAt: null}]};
  assert.deepEqual(stillProblems([still, {id: 'never', successAt: null, staleAfterMs: null, windows: []}], from, to), []);
  assert.deepEqual(stillProblems([{...still, id: 'stale', staleAfterMs: 7 * MIN}], from, to), ['stale goes stale']);
  assert.deepEqual(stillProblems([{...still, id: 'fading', successAt: from - 4 * MIN}], from, to), ["fading's dot still fades"]);
  assert.deepEqual(stillProblems([{...still, id: 'pulsing', successAt: from - MIN}], from, to), ["pulsing's dot still fades"], 'fading all through the window');
  assert.deepEqual(stillProblems([{...still, id: 'reset', windows: [{resetAt: to}]}], from, to), ['reset has a limit that resets']);
});

test("the window goes past each card's own hour when the hub works its forecasts out again", () => {
  const from = 10 * HOUR + 3 * MIN;
  const card = (id: string, successAt: number, asOf: number[]) => ({id, successAt, staleAfterMs: 3 * HOUR, windows: [], forecast: Object.fromEntries(asOf.map((at, i) => [`w${i}`, {asOf: at}]))});
  // Measured after the hour its forecasts are of: worked out again at its next hour, some minutes past it.
  const late = card('codex:late', 10 * HOUR + MIN, [10 * HOUR]);
  const lateAt = 11 * HOUR + hourShift('codex:late');
  assert.equal(foreseenAt(late), lateAt);
  assert.equal(foreseenAt(card('codex:taken', 10 * HOUR - MIN, [10 * HOUR])), null, 'its forecasts took in its last measurement');
  assert.equal(foreseenAt({...late, forecast: undefined}), null, 'no weekly window');
  assert.equal(foreseenAt(card('codex:two', 10 * HOUR + MIN, [10 * HOUR, 9 * HOUR])), 10 * HOUR + hourShift('codex:two'), 'the earlier of its windows');

  assert.deepEqual(stillProblems([late], lateAt - MIN, lateAt + MIN), ['codex:late has its forecasts worked out again']);
  assert.deepEqual(stillProblems([late], lateAt + MIN, lateAt + 3 * MIN), []);
  assert.equal(stillFrom([late], from, 2 * MIN), from, 'the window ends before it');
  assert.equal(stillFrom([late], lateAt - MIN, 2 * MIN), lateAt + SETTLE_MS);
  // One past the other: the window moves past both.
  const other = card('claude:other', 10 * HOUR + MIN, [10 * HOUR]);
  const [first, second] = [lateAt, 11 * HOUR + hourShift('claude:other')].sort((a, b) => a - b);
  assert.ok(second - first < 5 * MIN, 'the two are close enough to move the window twice');
  assert.equal(stillFrom([late, other], first - MIN, 5 * MIN), second + SETTLE_MS);
});

test('the report adds up work outside what shows time by region, and the busiest label', () => {
  const counted = [
    {node: 'a', time: false, kind: null, region: 'card:s1', count: 2},
    {node: 'b', time: false, kind: null, region: 'card:s1', count: 1},
    {node: 'c', time: false, kind: null, region: 'header', count: 4},
    {node: 'd', time: true, kind: 'mark', region: 'card:s1', count: 3},
    {node: 'e', time: true, kind: 'since', region: 'agents', count: 5},
  ];
  assert.deepEqual(tally(counted), {outside: 7, outsideBy: {'card:s1': 3, header: 4}, timeNodes: 2, timeMax: 5});
  assert.equal(scriptPerSecond({ScriptDuration: 1}, {ScriptDuration: 1.5}, 100, 10), 40, 'milliseconds a second, less the probe');
});
