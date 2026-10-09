import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FADE_FOR, PULSE_FOR} from '../../ui/lib/quota.js';
import {hourShift} from '../../server/forecasts.js';
import type {Snapshot} from '../../server/projection.js';
import {DOT_STILL_AFTER, foreseenAt, idlePhaseProblems, idleWindow, MARGIN_MS, overviewCards, SETTLE_MS, stillProblems, warmUntil, type IdlePhase} from '../still.js';
import {scriptPerSecond, tally} from '../report.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('both idle durations include exactly one centred cell transition at every warmup phase', () => {
  const cell = 5 * MIN;
  for (const seconds of [120, 300]) for (let ready = 0; ready < 2 * cell; ready += 1000) {
    const planned = idleWindow(ready, seconds, cell);
    assert.ok(planned.from >= ready && planned.from - ready < cell);
    assert.equal(planned.to - planned.from, seconds * 1000);
    assert.equal(Math.floor(planned.to / cell) - Math.floor(planned.from / cell), 1);
    assert.equal(planned.boundary - planned.from, seconds * 500);
  }
});

test('idle phase rejects missing coverage, extra grid movement and clock discontinuity', () => {
  const phase: IdlePhase = {from: 240000, to: 360000, monotonicFrom: 1000, monotonicTo: 121000, cellMs: 300000, starts: [0,0,0,0], ends: [1,1,1,1], transitions: [1,1,1,1]};
  assert.deepEqual(idlePhaseProblems(phase, 300000), []);
  for (const changed of [{transitions: [0,0,0]}, {transitions: [1,2,1]}, {starts: []}, {ends: [1,1,0]}, {from: 310000}, {monotonicTo: 124000}]) {
    assert.ok(idlePhaseProblems({...phase, ...changed}, 300000).length);
  }
});

test('the page is counted once every dot has faded out, and not before it settled', () => {
  const opened = 10 * HOUR;
  const cards = [
    {id: 'a', successAt: opened - 5 * MIN, staleAfterMs: 3 * HOUR, windows: [], forecast: undefined},
    {id: 'b', successAt: opened - 2 * HOUR, staleAfterMs: 7 * MIN, windows: [], forecast: undefined},
    {id: 'c', successAt: null, staleAfterMs: null, windows: [], forecast: undefined},
  ];
  assert.equal(DOT_STILL_AFTER, PULSE_FOR + FADE_FOR + 30_000);
  assert.equal(warmUntil(cards, opened), opened - 5 * MIN + DOT_STILL_AFTER);
  assert.equal(warmUntil([cards[1], cards[2]], opened), opened + SETTLE_MS, 'long faded: it only settles');
});

test('a stand that would change by itself during the window is told, card by card', () => {
  const from = 10 * HOUR;
  const to = from + 2 * MIN;
  const still = {id: 'still', successAt: from - 6 * MIN, staleAfterMs: 3 * HOUR, windows: [{resetAt: from + 3 * HOUR}, {resetAt: null}], forecast: undefined};
  assert.deepEqual(stillProblems([still, {id: 'never', successAt: null, staleAfterMs: null, windows: [], forecast: undefined}], from, to), []);
  assert.deepEqual(stillProblems([{...still, id: 'stale', staleAfterMs: 7 * MIN}], from, to), ['stale goes stale']);
  assert.deepEqual(stillProblems([{...still, id: 'fading', successAt: from - 4 * MIN}], from, to), ["fading's dot still fades"]);
  assert.deepEqual(stillProblems([{...still, id: 'pulsing', successAt: from - MIN}], from, to), ["pulsing's dot still fades"], 'fading all through the window');
  assert.deepEqual(stillProblems([{...still, id: 'reset', windows: [{resetAt: to}]}], from, to), ['reset has a limit that resets']);
});

/**
 * Cards as the benchmark reads them from `/api/overview`: the cards, and their forecasts
 * beside them by source, with only what it reads of either.
 */
async function overview(cards: {id: string; successAt: number; asOf: number[]}[]) {
  const asked: string[] = [];
  const read = await overviewCards(async path => {
    asked.push(path);
    return {
      sources: cards.map(({id, successAt}) => ({id, successAt, staleAfterMs: 3 * HOUR, windows: []})),
      forecast: Object.fromEntries(cards.map(({id, asOf}) => [id, Object.fromEntries(asOf.map((at, i) => [`w${i}`, {asOf: at}]))])),
    } as unknown as Snapshot;
  }, 'board 1');
  assert.deepEqual(asked, ['/api/overview?board=board%201']);
  return read;
}

test("a card's forecasts worked out again by themselves are told, as the overview keeps them beside the cards", async () => {
  // Measured after the hour its forecasts are of: worked out again at its next hour, some minutes past it.
  const [late, taken, two, none] = await overview([
    {id: 'codex:late', successAt: 10 * HOUR + MIN, asOf: [10 * HOUR]},
    {id: 'codex:taken', successAt: 10 * HOUR + MIN, asOf: [10 * HOUR + MIN]},
    {id: 'codex:two', successAt: 10 * HOUR + MIN, asOf: [10 * HOUR, 9 * HOUR]},
    {id: 'codex:none', successAt: 10 * HOUR + MIN, asOf: []},
  ]);
  const lateAt = 11 * HOUR + hourShift('codex:late');
  assert.equal(foreseenAt(late), lateAt);
  assert.equal(foreseenAt(taken), null, 'its forecasts took in its last measurement, as a still hub\'s do');
  assert.equal(foreseenAt(none), null, 'no weekly window');
  assert.equal(foreseenAt(two), 10 * HOUR + hourShift('codex:two'), 'the earlier of its windows');

  const told = ['codex:late has its forecasts worked out again'];
  assert.deepEqual(stillProblems([late], lateAt - MIN, lateAt + MIN), told);
  // Within a few seconds of either end: its frame may come in the window.
  assert.deepEqual(stillProblems([late], lateAt + MARGIN_MS / 2, lateAt + 3 * MIN), told);
  assert.deepEqual(stillProblems([late], lateAt - 3 * MIN, lateAt - MARGIN_MS / 2), told);
  assert.deepEqual(stillProblems([late], lateAt + MARGIN_MS + 1, lateAt + 3 * MIN), []);
  assert.deepEqual(stillProblems([late], lateAt - 3 * MIN, lateAt - MARGIN_MS - 1), []);
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
