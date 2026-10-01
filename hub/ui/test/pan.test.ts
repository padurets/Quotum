import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pan, type PanStart} from '../lib/pan';
import type {TimeRange} from '../lib/timeRange';

const DAY = 86_400_000;
function setup(selected: TimeRange | null = null) {
  let now = 100 * DAY;
  const commits: (TimeRange | null)[] = [];
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let id = 0;
  const pan = new Pan({now: () => now, commit: r => commits.push(r), requestFrame: run => {frames.set(++id, run); return id;}, cancelFrame: n => frames.delete(n as number), setTimeout: run => {timers.set(++id, run); return id;}, clearTimeout: n => timers.delete(n as number)});
  const start: PanStart = {source: Symbol('source'), input: 'pointer', selected, now, length: selected ? selected.to - selected.from : DAY, historyStart: 20 * DAY, span: DAY, width: 500};
  const paint = () => {const queued = [...frames.values()]; frames.clear(); queued.forEach(run => run());};
  return {pan, start, commits, frames, timers, paint, clock: (ms: number) => {now += ms;}, now};
}

test('all deltas accumulate, one preview per RAF and one committed gesture', () => {
  const s = setup();
  const token = s.pan.begin(s.start)!;
  for (let i = 0; i < 60; i++) s.pan.move(token, -1);
  assert.equal(s.frames.size, 1);
  assert.equal(s.pan.get()!.to, s.now);
  assert.equal(s.commits.length, 0);
  s.paint();
  assert.equal(s.pan.get()!.to, s.now - 60 * DAY / 500);
  s.pan.finish(token);
  assert.deepEqual(s.commits, [{from: s.now - DAY - 60 * DAY / 500, to: s.now - 60 * DAY / 500}]);
  assert.equal(s.frames.size + s.timers.size, 0);
});

test('captured CSS scale, fractional movement and selected duration survive serialization', () => {
  const s = setup({from: 97 * DAY, to: 98 * DAY + 123});
  const token = s.pan.begin({...s.start, span: 2 * DAY, width: 500})!;
  s.pan.move(token, -0.125);
  s.paint();
  assert.equal(s.pan.get()!.to, s.start.selected!.to - 43_200);
  s.pan.finish(token);
  assert.equal(s.commits[0]!.to - s.commits[0]!.from, s.start.length);
});

test('a still drag and an upper-bound wheel do not freeze live after the clock advances', () => {
  for (const input of ['pointer', 'wheel'] as const) {
    const s = setup();
    const token = s.pan.begin({...s.start, input})!;
    s.pan.move(token, input === 'wheel' ? 1_000 : 0);
    s.clock(10 * DAY);
    s.pan.finish(token);
    assert.deepEqual(s.commits, []);
    assert.equal(s.pan.get(), null);
  }
});

test('return to origin is a no-op before fresh live snap, including nearby custom ranges', () => {
  for (const selected of [null, {from: 99 * DAY - 1_000, to: 100 * DAY - 1_000}]) {
    const s = setup(selected);
    const token = s.pan.begin(s.start)!;
    s.pan.move(token, -50);
    s.pan.move(token, 50);
    s.clock(DAY);
    s.pan.finish(token);
    assert.deepEqual(s.commits, []);
  }
});

test('bounds discard overscroll, so reversal moves on its first delta', () => {
  const s = setup();
  const token = s.pan.begin(s.start)!;
  s.pan.move(token, 500);
  s.pan.move(token, -1);
  s.paint();
  assert.equal(s.pan.get()!.to, s.now - DAY / 500);
  s.pan.move(token, -100_000);
  s.paint();
  const end = s.pan.get()!.to;
  s.pan.move(token, 1);
  s.paint();
  assert.equal(s.pan.get()!.to, end + DAY / 500);
});

test('live snap uses eight source CSS pixels only after actual movement', () => {
  for (const pixels of [7.99, 8, 8.01]) {
    const s = setup({from: 97 * DAY, to: 98 * DAY});
    const token = s.pan.begin(s.start)!;
    s.pan.move(token, 1_000 - pixels);
    s.pan.finish(token);
    assert.equal(s.commits[0] === null, pixels <= 8);
  }
});

test('cancellation releases every callback and obsolete tokens cannot affect a new drag', () => {
  const s = setup();
  const first = s.pan.begin(s.start)!;
  s.pan.move(first, -50);
  const stale = [...s.frames.values()][0];
  s.pan.cancel(first);
  const next = s.pan.begin(s.start)!;
  s.pan.move(next, -100);
  stale();
  s.pan.cancel(first);
  s.pan.finish(first);
  s.paint();
  assert.equal(s.pan.get()!.token, next);
  s.pan.cancel(next);
  assert.equal(s.frames.size + s.timers.size + s.commits.length, 0);
});

const wheel = (timeStamp: number, deltaX = -12) => ({deltaX, deltaY: 0, deltaMode: 0, cancelable: true, shiftKey: false, timeStamp});
test('wheel crossing charts keeps source scale and each pause commits one transaction', () => {
  const s = setup();
  assert.equal(s.pan.wheel(s.start, wheel(1_000)), true);
  assert.equal(s.pan.wheel({...s.start, source: Symbol(), width: 1_000}, wheel(1_016)), true);
  s.paint();
  assert.equal(s.pan.get()!.to, s.now - 24 * DAY / 500);
  assert.equal(s.timers.size, 1);
  s.pan.wheel({...s.start, selected: {from: s.now - DAY - 24 * DAY / 500, to: s.now - 24 * DAY / 500}}, wheel(1_216));
  assert.equal(s.commits.length, 1, 'a delayed end callback is finished before the next input');
  [...s.timers.values()][0]();
  assert.equal(s.commits.length, 2);
  assert.equal(s.timers.size + s.frames.size, 0);
});

test('pointer drag excludes concurrent wheel and a non-cancelable event is untouched', () => {
  const s = setup();
  s.pan.begin(s.start);
  assert.equal(s.pan.wheel(s.start, wheel(1_000)), false);
  s.pan.cancel();
  assert.equal(s.pan.wheel(s.start, {...wheel(1_000), cancelable: false}), false);
  assert.equal(s.pan.active(), null);
});
