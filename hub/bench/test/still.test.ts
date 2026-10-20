import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {FADE_FOR, PULSE_FOR} from '../../ui/lib/quota.js';
import {hourShift} from '../../server/forecasts.js';
import type {Snapshot} from '../../server/projection.js';
import {DOT_STILL_AFTER, foreseenAt, idlePhaseProblems, idlePhaseScript, idleWindow, MARGIN_MS, overviewCards, quietAfter, SETTLE_MS, stillProblems, warmUntil, type IdlePhase} from '../still.js';
import {scriptPerSecond, tally} from '../report.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('an idle window too short for separate quota and axis deadlines is rejected',()=>{
  for(const seconds of [10,30,60,69])assert.throws(()=>idleWindow(0,seconds,5*MIN),/unsupported idle phase/);
});

test('both idle durations include one cell transition and avoid minute ticks at their endpoints', () => {
  const cell = 5 * MIN;
  for (const seconds of [120, 300]) for (let ready = 0; ready < 2 * cell; ready++) {
    const planned = idleWindow(ready, seconds, cell);
    assert.ok(planned.from >= ready && planned.from - ready < cell);
    assert.equal(planned.to - planned.from, seconds * 1000);
    assert.equal(Math.floor(planned.to / cell) - Math.floor(planned.from / cell), 1);
    assert.ok(planned.from < planned.boundary && planned.boundary < planned.to);
    assert.equal(planned.cellMs, cell);
    assert.equal(planned.expectedTransitions, 1);
    assert.ok(planned.from - ready <= (seconds === 120 ? 240_000 : 60_000));
    assert.equal(planned.quotaBoundary,planned.boundary-50_000+1);
    assert.ok(planned.from<planned.quotaBoundary&&planned.quotaBoundary<planned.to);
    for(const bound of [planned.from,planned.to])assert.ok(Math.min(bound%MIN,MIN-bound%MIN)>=5_000);
  }
});

test('an already eligible idle window starts without waiting for a fixed midpoint', () => {
  const ready = Date.parse('2026-10-11T13:03:17.139Z');
  for (let difference = -1000; difference <= 1000; difference++) {
    const at = ready + difference;
    assert.equal(idleWindow(at, 120, 5 * MIN).from, at);
  }
});

test('the warm deadline stays eligible at one minute before the next grid boundary',()=>{
  const boundary=Date.parse('2026-10-11T13:05:00Z'),ready=boundary-MIN;
  const planned=idleWindow(ready,120,5*MIN);
  assert.equal(planned.from-ready,5_000,'do not skip this cell and add four minutes of waiting');
  assert.equal(planned.boundary,boundary);
  assert.equal(planned.quotaBoundary,boundary-50_000+1);
  assert.ok(planned.from<planned.quotaBoundary&&planned.quotaBoundary<planned.boundary);
});

test('a chart-only window waits for both the next quota retirement and axis transition',()=>{
  const ready=Date.parse('2026-10-11T13:04:17.139Z'),planned=idleWindow(ready,120,5*MIN);
  assert.equal(planned.boundary,Date.parse('2026-10-11T13:10:00Z'));
  assert.equal(planned.quotaBoundary,Date.parse('2026-10-11T13:09:10.001Z'));
  assert.ok(planned.from>=ready&&planned.from<planned.quotaBoundary);
  const late:IdlePhase={from:ready,to:ready+120000,monotonicFrom:0,monotonicTo:120000,cellMs:300000,starts:Array(5).fill(Math.floor(ready/300000)),ends:Array(5).fill(Math.floor((ready+120000)/300000)),transitions:[1,1,1,1,1]};
  const boundary=Date.parse('2026-10-11T13:05:00Z');
  assert.deepEqual(idlePhaseProblems(late,boundary),[]);
  assert.ok(idlePhaseProblems(late,boundary,boundary-50_000+1).includes('idle phase did not include regular quota retirement before the grid boundary'));
});

test('idle phase rejects missing coverage, extra grid movement and clock discontinuity', () => {
  const phase: IdlePhase = {from: 240000, to: 360000, monotonicFrom: 1000, monotonicTo: 121000, cellMs: 300000, starts: [0,0,0,0,0], ends: [1,1,1,1,1], transitions: [1,1,1,1,1]};
  assert.deepEqual(idlePhaseProblems(phase, 300000), []);
  for (const changed of [{transitions: [0,0,0]}, {transitions: [1,2,1]}, {starts: []}, {ends: [1,1,0]}, {transitions: [1,1,1,1]}, {starts: [0,0,0,0]}, {ends: [1,1,1,1]}, {transitions: [1,1,1,1,0]}, {ends: [1,1,1,1,0]}, {from: 310000}, {monotonicTo: 124000}]) {
    assert.ok(idlePhaseProblems({...phase, ...changed}, 300000).length);
  }
});

test('the actual idle phase probe requires and observes every explicit chart widget', () => {
  const widgets = ['quota-history', 'quota-session-history', 'activity', 'budget-history', 'subscription-funds'];
  function probe(missing?: string) {
    const axes = widgets.filter(widget => widget !== missing).map(widget => ({widget, dataset: {axisEnd: '240000'}}));
    const selected: string[] = [], observed: string[] = [];
    let now = 240000, monotonic = 1000, notify = () => {}, disconnected = 0;
    const window = {__quotumIdlePhase: undefined as {read(): IdlePhase; stop(): void} | undefined};
    runInNewContext(idlePhaseScript(300000), {
      window, Date: {now: () => now}, performance: {now: () => monotonic},
      document: {querySelector: (selector: string) => {
        selected.push(selector);
        return axes.find(axis => selector === '[data-widget="' + axis.widget + '"] [data-axis-end]') ?? null;
      }},
      MutationObserver: class {
        constructor(callback: () => void) {notify = callback;}
        observe(axis: typeof axes[number], options: {attributes: boolean; attributeFilter: string[]}) {
          observed.push(axis.widget);
          assert.equal(options.attributes, true); assert.deepEqual(Array.from(options.attributeFilter), ['data-axis-end']);
        }
        disconnect() {disconnected++;}
      },
    });
    return {selected, observed, cross(frozen?: string): IdlePhase {
      for (const axis of axes) if (axis.widget !== frozen) axis.dataset.axisEnd = '360000';
      now = 360000; monotonic = 121000; notify();
      const phase = JSON.parse(JSON.stringify(window.__quotumIdlePhase!.read())) as IdlePhase;
      window.__quotumIdlePhase!.stop(); assert.equal(disconnected, 1);
      return phase;
    }};
  }
  const complete = probe(), phase = complete.cross();
  assert.deepEqual(complete.selected, widgets.map(widget => '[data-widget="' + widget + '"] [data-axis-end]'));
  assert.deepEqual(complete.observed, widgets);
  assert.deepEqual(phase.starts, [0,0,0,0,0]); assert.deepEqual(phase.ends, [1,1,1,1,1]); assert.deepEqual(phase.transitions, [1,1,1,1,1]);
  assert.deepEqual(idlePhaseProblems(phase, 300000), []);
  for (const widget of widgets) {
    assert.throws(() => probe(widget), /idle phase requires all five chart axes/);
    const frozen = probe().cross(widget);
    assert.equal(frozen.transitions[widgets.indexOf(widget)], 0);
    assert.ok(idlePhaseProblems(frozen, 300000).includes('idle phase did not observe one transition in each chart'), widget);
    assert.ok(idlePhaseProblems(frozen, 300000).includes('idle chart grid disagrees with the measurement clock'), widget);
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
  const measured={...still,id:'measured',successAt:from};
  assert.deepEqual(stillProblems([measured],from,to,'measured'),[],'its own measurement may restart its dot');
  assert.deepEqual(stillProblems([{...measured,windows:[{resetAt:to}]}],from,to,'measured'),['measured has a limit that resets'],'the measured card keeps its quota deadline');
  assert.deepEqual(stillProblems([{...measured,id:'other'}],from,to,'measured'),["other's dot still fades"],'other cards stay under the original clock guard');
  const creditClock={allowDotClock:true};
  assert.deepEqual(stillProblems([{...measured,id:'other'}],from,to,'measured',creditClock),[],'credit rendering separately bounds natural dot clocks');
  assert.deepEqual(stillProblems([{...measured,staleAfterMs:MIN,windows:[{resetAt:to}]}],from,to,'measured',creditClock),['measured goes stale','measured has a limit that resets']);
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
  assert.deepEqual(stillProblems([late],lateAt-MIN,lateAt+MIN,undefined,{allowDotClock:true}),told,'dot clock admission does not suppress forecast work');
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
