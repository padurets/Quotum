import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PageClock} from '../lib/clock';
import {ago, agoChangesAt, countdown, countdownChangesAt, duration, durationChangesAt, durationUntilChangesAt} from '../lib/format';
import {cadenceChangesAt, cadenceOf, dotChangesAt, dotOf, resetLine, resetLineChangesAt} from '../lib/quota';
import {resetLabel, resetLabelChangesAt, type ResetStatus} from '../lib/resets';
import {DEFAULT_PLAN, planAt, planChangesAt, planNote} from '../lib/plan';
import {since, sinceChangesAt} from '../lib/agents';
import {frameChangesAt, step, stepChangesAt} from '../lib/periods';
import {cellChangesAt, forecastLine, outlook, outlookText, planCell, planEndOf, type Context} from '../lib/forecast';
import type {SeriesForecast, Win} from '../lib/types';

const S = 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-26T12:00:00Z');

/** A page clock on timers the test runs, and a tab it shows or hides. */
function pageClock() {
  let t = T0;
  let visible = true;
  const timers: {at: number; run: () => void; id: number}[] = [];
  let next = 1;
  const clock = new PageClock({
    now: () => t,
    setTimeout: (run, ms) => {
      timers.push({at: t + ms, run, id: next});
      return next++;
    },
    clearTimeout: id => {
      const i = timers.findIndex(timer => timer.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    visible: () => visible,
  });
  const woken: string[] = [];
  /** A part showing time: it is due at `at`, and says so again after each wake. */
  const part = (name: string, at: (now: number) => number | null) => {
    const watch = clock.watch();
    clock.subscribe(watch, () => {
      woken.push(name);
      clock.due(watch, at(clock.hubNow()), clock.hubNow());
    });
    clock.due(watch, at(clock.hubNow()), clock.hubNow());
    return watch;
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > end) break;
      timers.shift();
      t = due.at;
      due.run();
    }
    t = end;
  };
  return {
    clock,
    part,
    woken,
    timers,
    advance,
    jump: (ms: number) => void (t += ms),
    hide: () => {
      visible = false;
      clock.wakeDue();
    },
    show: () => {
      visible = true;
      clock.wakeDue();
    },
    now: () => t,
  };
}

test('one timer for the whole page, for the nearest moment a part shows something new; each part woken at its own', () => {
  const c = pageClock();
  c.part('minute', now => now - (now % MIN) + MIN);
  c.part('hour', now => now - (now % HOUR) + HOUR);
  c.part('never', () => null);
  assert.equal(c.timers.length, 1);
  assert.equal(c.timers[0].at, T0 + MIN);
  c.advance(59 * MIN);
  assert.deepEqual([c.woken.length, c.woken.every(name => name === 'minute')], [59, true]);
  c.advance(MIN);
  assert.deepEqual(c.woken.slice(-2).sort(), ['hour', 'minute']);
  assert.equal(c.timers.length, 1, 'still one');
});

test('a moment that is not after now is a mistake of its part: taken as a minute on, never a spin', () => {
  const c = pageClock();
  c.part('wrong', now => now);
  c.advance(59 * S);
  assert.deepEqual(c.woken, []);
  c.advance(S);
  assert.deepEqual(c.woken, ['wrong']);
});

test('a hidden tab has no timer; shown again, whatever came due meanwhile is woken at once', () => {
  const c = pageClock();
  c.part('minute', now => now - (now % MIN) + MIN);
  c.hide();
  assert.equal(c.timers.length, 0);
  c.advance(10 * MIN);
  assert.deepEqual(c.woken, []);
  c.show();
  assert.deepEqual(c.woken, ['minute'], 'once, not ten times');
  assert.equal(c.timers.length, 1);
});

test('after a sleep (the wall clock jumped, timers held up), waking wakes what is overdue; a new skew wakes everything', () => {
  const c = pageClock();
  c.part('soon', now => now + MIN);
  c.part('later', now => now + HOUR);
  c.jump(2 * HOUR);
  c.clock.wakeDue();
  assert.deepEqual(c.woken.sort(), ['later', 'soon']);
  c.woken.length = 0;
  c.clock.heard(c.now() + 500);
  assert.deepEqual(c.woken, [], 'half a second off: nothing');
  c.clock.heard(c.now() + 10 * MIN);
  assert.deepEqual(c.woken.sort(), ['later', 'soon']);
  assert.equal(c.clock.hubNow(), c.now() + 10 * MIN);
});

/**
 * Checks a label against its moment of change from many moments: the moment is after now,
 * the label reads the same until it, and (when `exact`) otherwise at it.
 */
function changesAtItsMoment<T>(what: string, show: (now: number) => T, changesAt: (now: number) => number | null, moments: number[], exact = true) {
  for (const now of moments) {
    const seen = JSON.stringify(show(now));
    const at = changesAt(now);
    if (at === null) {
      for (const later of [now + 1, now + MIN, now + DAY, now + 30 * DAY])
        assert.equal(JSON.stringify(show(later)), seen, `${what}: never changes after ${now - T0}, yet does at +${later - now}`);
      continue;
    }
    assert.ok(at > now, `${what}: a moment after ${now - T0}, not ${at - T0}`);
    for (const t of [now + 1, Math.floor((now + at) / 2), at - 1])
      if (t < at) assert.equal(JSON.stringify(show(t)), seen, `${what}: from ${now - T0} the same until ${at - T0}, not at ${t - T0}`);
    if (exact) assert.notEqual(JSON.stringify(show(at)), seen, `${what}: from ${now - T0}, otherwise at ${at - T0}`);
  }
}

/** Moments around `from`: every second of the first hours, then further and further. */
const around = (from: number) => [
  ...Array.from({length: 400}, (_, i) => from + i * 7_919),
  ...Array.from({length: 200}, (_, i) => from - DAY + i * 997_331),
  ...[0, 1, 29_999, 30_000, 44_499, 44_500, 59_999, 60_000, 3_599_499, 86_399_499, 2 * DAY + 5].map(d => from + d),
];

/** Moments before `to`, what counts down to it: its last two hours a minute at a time, and either side of each unit. */
const before = (to: number) => [
  ...Array.from({length: 125}, (_, i) => to - 2 * HOUR + i * 60_013),
  ...[2 * DAY + 1, 2 * DAY, DAY + 1, DAY, HOUR + 1, HOUR, HOUR - 1, MIN + 1, MIN, MIN - 1, 30_001, 30_000, 1].map(d => to - d),
];

test('ago, countdown and duration say when they read otherwise, to the millisecond', () => {
  const time = T0 - 3 * S;
  changesAtItsMoment(
    'ago',
    now => ago(time, now),
    now => agoChangesAt(time, now),
    around(time),
  );
  changesAtItsMoment(
    'countdown',
    now => countdown(time + 3 * DAY - now),
    now => countdownChangesAt(time + 3 * DAY, now),
    [...around(time), ...before(time + 3 * DAY)],
  );
  changesAtItsMoment(
    'duration since',
    now => duration(now - time),
    now => durationChangesAt(time, now),
    around(time),
  );
  changesAtItsMoment(
    'duration since, short',
    now => duration(now - time, true),
    now => durationChangesAt(time, now, true),
    around(time),
  );
  const to = T0 + 3 * DAY + 17 * S;
  changesAtItsMoment(
    'duration until',
    now => duration(to - now),
    now => durationUntilChangesAt(to, now),
    [...around(T0), ...before(to)],
  );
  changesAtItsMoment(
    'duration until, short',
    now => duration(to - now, true),
    now => durationUntilChangesAt(to, now, true),
    [...around(T0), ...before(to)],
  );
  assert.equal(agoChangesAt(null, T0), null);
  changesAtItsMoment(
    'running for',
    now => since(now - time),
    now => sinceChangesAt(time, now),
    around(time),
  );
});

test("a card's dot and its pace say when they look otherwise", () => {
  const source = {stale: false, error: null, successAt: T0, cadence: {next: T0 + 5 * MIN, why: 'idle' as const}};
  changesAtItsMoment(
    'dot',
    now => dotOf(source, now),
    now => dotChangesAt(source, now),
    around(T0),
  );
  changesAtItsMoment(
    'cadence',
    now => cadenceOf(source, now)?.when,
    now => cadenceChangesAt(source, now),
    [...around(T0), ...before(source.cadence.next)],
  );
  assert.equal(dotChangesAt({...source, stale: true}, T0), null, 'trouble passes when the hub says');
  const w = {resetAt: T0 + 2 * DAY + 13 * S};
  changesAtItsMoment(
    'reset line',
    now => {
      const line = resetLine(w, now);
      return line.key === 'resetsIn' ? duration(line.inMs) : line.key;
    },
    now => resetLineChangesAt(w, now),
    [...around(T0), ...before(w.resetAt)],
  );
});

test('what a card says of resets for everyone says when it changes', () => {
  const credit = {name: 'Codex Resets', url: 'https://codex-resets.com/'};
  const event = (at: number) => ({url: 'https://x', text: 'x', at});
  const statuses: ResetStatus[] = [
    {scheduled: {...event(T0 - HOUR), scheduledFor: T0 + 5 * HOUR, kind: 'regular'}, watch: null, latest: null, policy: null, credit},
    {
      scheduled: null,
      watch: {...event(T0), expiresAt: T0 + 2 * HOUR, chance: 0.4, window: '5h'},
      latest: event(T0 - HOUR) && {...event(T0 - HOUR), scope: 'all'},
      policy: event(T0 - DAY),
      credit,
    },
    {scheduled: null, watch: null, latest: {...event(T0 - 20 * HOUR), scope: 'all'}, policy: event(T0 - 50 * HOUR), credit},
  ];
  for (const status of statuses)
    changesAtItsMoment(
      'reset label',
      now => resetLabel(status, now),
      now => resetLabelChangesAt(status, now),
      [...around(T0), ...before(T0 + 5 * HOUR), ...before(T0 + 2 * HOUR)],
      false,
    );
});

test("a limit's plan says when its mark, its gap or its end show otherwise", () => {
  const weekly: Win = {id: 'w', kind: 'weekly', label: null, used: 37.5, remaining: 62.5, resetAt: T0 + 4 * DAY + 7 * HOUR, minutes: 10080};
  const session: Win = {id: 's', kind: 'session', label: null, used: 20, remaining: 80, resetAt: T0 + 3 * HOUR, minutes: 300};
  const measuredAt = T0 - MIN;
  const shown = (w: Win, now: number) => {
    const point = planAt(w, measuredAt, now, DEFAULT_PLAN);
    const note = planNote(w, measuredAt, now, DEFAULT_PLAN);
    // The table's cell too: its number, the gap and whether the gap is worth marking.
    const cell = planCell(w, measuredAt, now, DEFAULT_PLAN);
    return [point && Math.round(point.remaining), point?.done, note && [note.key, Math.round(note.value)], cell && [Math.round(cell.remaining), Math.round(cell.delta), cell.notable]];
  };
  // Close to its plan: the gap grows past the mark the table draws from.
  const close: Win = {...weekly, id: 'c', used: 64.5, remaining: 35.5};
  // Left in whole points: the end of the plan is told by its being over, no rounding of the gap there.
  const whole: Win = {...weekly, id: 'e', used: 38, remaining: 62};
  for (const w of [weekly, session, close, whole]) {
    const moments = [...Array.from({length: 150}, (_, i) => T0 + i * 1_234_567), ...before(w.resetAt!)].filter(t => t < w.resetAt!);
    changesAtItsMoment(
      `plan ${w.kind}`,
      now => shown(w, now),
      now => planChangesAt(w, measuredAt, now, DEFAULT_PLAN),
      moments,
      false,
    );
  }
  assert.equal(planChangesAt(weekly, measuredAt, T0, null), null, 'no plan: nothing to change');
});

test('the arrows of the analytics say when they turn on or off; the frame moves on a cell at a time', () => {
  const arrows = (selected: {from: number; to: number} | null, range: string, historyStart: number) => (now: number) =>
    [step(selected, range, -1, now, historyStart) !== null, step(selected, range, 1, now, historyStart) !== null];
  // A history begun a while ago: the period ending now reaches back to it after a while.
  for (const [range, start] of [['24h', T0 - 3 * HOUR], ['7d', T0 - 2 * DAY], ['30d', T0 - 100 * DAY]] as const)
    changesAtItsMoment(`‹ › of ${range}`, arrows(null, range, start), now => stepChangesAt(null, range, now, start), around(T0));
  // A range stepped back to: it falls out of what the hub keeps at last.
  const range = {from: T0 - 80 * DAY, to: T0 - 79 * DAY};
  changesAtItsMoment('‹ › of a range', arrows(range, '24h', 0), now => stepChangesAt(range, '24h', now, 0), [T0, T0 + 5 * DAY, T0 + 9 * DAY, T0 + 9 * DAY + 22 * HOUR]);
  assert.equal(frameChangesAt(null, 5 * MIN, T0 + 7 * S), T0 + 5 * MIN);
  assert.equal(frameChangesAt({from: T0 - DAY, to: T0 - HOUR}, 5 * MIN, T0), null, 'a range in the past stands still');
  assert.equal(frameChangesAt({from: T0 - DAY, to: T0 + HOUR}, 5 * MIN, T0), T0 + 5 * MIN, 'one reaching past now does not');
});

test('the forecast cell says when it reads otherwise: its countdown, its tone, its moment, the end of the plan it tells of, the reset; and when its line is drawn no more', () => {
  const start = T0 - 72 * HOUR;
  const reset = start + 7 * DAY;
  const week = (remaining: number, change: Partial<Win> = {}): Win => ({id: 'w', kind: 'weekly', label: null, used: 100 - remaining, remaining, resetAt: reset, minutes: 10080, ...change});
  /** The hub's forecast at T0 of a week at `left`, reaching `F` at the reset in a straight line. */
  const ahead = (left: number, F: number, change: Partial<SeriesForecast> = {}): SeriesForecast => {
    const zero = F < 0 ? T0 + Math.ceil(((reset - T0) * left) / (left - F)) : null;
    return {
      state: F <= -5 ? 'runsOut' : 'lasts',
      asOf: T0,
      resetAt: reset,
      anchor: {at: T0, left},
      F,
      zero,
      shownZero: F <= -5 ? zero : null,
      shownLeft: F <= -5 ? null : Math.round(F / 5) * 5,
      comfy: F >= 25,
      points: [
        [0, left],
        [(reset - T0) / MIN, F],
      ],
      basis: {hours: 72, cold: false, usualPerDay: 12, lastDay: 1.4, burst: null},
      ...change,
    };
  };
  const plain: Context = {windows: [], freeResets: 0, announced: null};
  const shown = (live: Win, forecast: SeriesForecast | null, context: Context, plan: number[] | null) => (now: number) => {
    const said = outlook(live, T0, now, forecast, context);
    const text = outlookText(said, live, forecast, context, planEndOf(live, T0, now, plan, forecast));
    return [said.key, said.tone, text.text, text.burst, text.title, 'left' in said ? said.left : null];
  };
  // A plan the owner chose that ends two days before the reset.
  const early = [20, 20, 20, 20, 20, 0, 0];
  const held = ahead(38, -60);
  const cases: [string, Win, SeriesForecast | null, Context, number[] | null][] = [
    ['runs out', week(38), ahead(38, -60), plain, null],
    // The line reaches zero two hours before the moment the table goes on saying.
    ['runs out, at the moment said before', week(38), {...held, shownZero: held.zero! + 2 * HOUR}, plain, null],
    // Runs out in 59 hours of the 96 left: said louder once under half of what is left.
    ['runs out later', week(45), ahead(45, -28), plain, null],
    ['runs out, never louder with free resets', week(45), ahead(45, -28), {...plain, freeResets: 1}, null],
    ['runs out in a first day', week(45), ahead(45, -28, {basis: {hours: 12, cold: true, usualPerDay: 12, lastDay: null, burst: null}}), plain, null],
    ['runs out, with a burst and the plan', week(38), ahead(38, -60, {basis: {hours: 72, cold: false, usualPerDay: 12, lastDay: 2, burst: {times: 3, zero: T0 + 20 * HOUR}}}), plain, early],
    ['left, with a plan ending before the reset', week(60), ahead(60, 40), plain, early],
    ['just enough', week(40), ahead(40, 2), plain, null],
    ['too little history', week(99), ahead(99, 50, {state: 'needData', basis: {hours: 0.5}}), plain, null],
    ['a five-hour window', {id: 's', kind: 'session', label: null, used: 70, remaining: 30, resetAt: T0 + 2 * HOUR, minutes: 300}, null, plain, null],
    ['a five-hour window that lasts', {id: 's', kind: 'session', label: null, used: 20, remaining: 80, resetAt: T0 + 2 * HOUR, minutes: 300}, null, plain, null],
    // Reaches zero a little before the reset, on its pace: said on pace until then.
    ['a five-hour window on pace', {id: 's', kind: 'session', label: null, used: 60.2, remaining: 39.8, resetAt: T0 + 2 * HOUR, minutes: 300}, null, plain, null],
    ['used up', week(0), null, plain, null],
    ['of no known length', week(50, {minutes: null}), null, plain, null],
  ];
  for (const [what, live, forecast, context, plan] of cases) {
    // Up to the moment it runs out, when the countdown has stopped reading otherwise.
    const said = outlook(live, T0, T0, forecast, context);
    const moments = [...Array.from({length: 300}, (_, i) => T0 + i * 1_987_654), ...Array.from({length: 300}, (_, i) => T0 + i * 13_331), ...(said.key === 'runsOut' ? before(said.at) : [])];
    changesAtItsMoment(what, shown(live, forecast, context, plan), now => cellChangesAt(live, T0, now, forecast, context, plan), moments);
    const line = (now: number) => forecastLine(live, T0, now, forecast, context, -Infinity, Infinity);
    changesAtItsMoment(`${what}: its line`, line, now => line(now)?.until ?? null, [...moments, ...(line(T0) ? before(line(T0)!.until) : [])]);
  }
});
