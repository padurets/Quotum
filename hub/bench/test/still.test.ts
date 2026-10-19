import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FADE_FOR, PULSE_FOR} from '../../ui/lib/quota.js';
import {hourShift} from '../../server/forecasts.js';
import type {Snapshot} from '../../server/projection.js';
import {DOT_STILL_AFTER, foreseenAt, MARGIN_MS, overviewCards, quietAfter, SETTLE_MS, stillProblems, warmUntil} from '../still.js';
import {scriptPerSecond, tally} from '../report.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

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
  const measured={...still,id:'measured',successAt:from};
  assert.deepEqual(stillProblems([measured],from,to,'measured'),[],'its own measurement may restart its dot');
  assert.deepEqual(stillProblems([{...measured,windows:[{resetAt:to}]}],from,to,'measured'),['measured has a limit that resets'],'the measured card keeps its quota deadline');
  assert.deepEqual(stillProblems([{...measured,id:'other'}],from,to,'measured'),["other's dot still fades"],'other cards stay under the original clock guard');
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

test('credit setup waits beyond forecast grace and resets before qualifying its unchanged quota baseline',()=>{
  const card={id:'codex:late',successAt:10*HOUR+MIN,staleAfterMs:3*HOUR,windows:[] as {resetAt:number|null}[],forecast:{weekly:{asOf:10*HOUR}}};
  const deadline=11*HOUR+hourShift(card.id),from=deadline-1000,to=deadline+8000;
  assert.deepEqual(stillProblems([card],from,to,card.id),[`${card.id} has its forecasts worked out again`]);
  const quiet=quietAfter([card],from,to)!;
  assert.deepEqual(quiet,{resets:[],forecasts:[deadline],until:deadline+MARGIN_MS+1});
  assert.deepEqual(stillProblems([card],quiet.until,quiet.until+to-from,card.id),[]);
  assert.equal(quietAfter([card],quiet.until,quiet.until+to-from),null);
  assert.deepEqual(quietAfter([card],deadline+MARGIN_MS/2,deadline+8000)?.forecasts,[deadline],'a recently fired timer remains inside the same scheduler grace');
  const reset={...card,forecast:undefined,windows:[{resetAt:deadline+2000}]};
  assert.deepEqual(quietAfter([card,reset],from,to),{resets:[deadline+2000],forecasts:[deadline],until:deadline+2000+MARGIN_MS+1});
  assert.equal(quietAfter([{...card,forecast:undefined}],from,to),null);
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
