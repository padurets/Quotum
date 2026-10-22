import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pan, type PanStart} from '../lib/pan';
import type {TimeRange} from '../lib/timeRange';

const DAY = 86_400_000;
function setup(selected: TimeRange | null = null) {
  let now = 100 * DAY, deliveredAt = 0;
  const commits: (TimeRange | null)[] = [];
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let id = 0;
  const delays: number[] = [];
  const pan = new Pan({now: () => now, commit: r => commits.push(r), requestFrame: run => {frames.set(++id, run); return id;}, cancelFrame: n => frames.delete(n as number), setTimeout: (run, ms) => {delays.push(ms); timers.set(++id, run); return id;}, clearTimeout: n => timers.delete(n as number)}, () => deliveredAt);
  const start: PanStart = {source: Symbol('source'), input: 'pointer', selected, now, length: selected ? selected.to - selected.from : DAY, historyStart: 20 * DAY, span: DAY, width: 500};
  const paint = () => {const queued = [...frames.values()]; frames.clear(); queued.forEach(run => run());};
  return {pan, start, commits, frames, timers, delays, paint, delivered: (at: number) => {deliveredAt = at;}, clock: (ms: number) => {now += ms;}, now};
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

test('a moved frame clamps to the fresh retention boundary after a late clock correction', () => {
  const s = setup();
  const token = s.pan.begin({...s.start, historyStart: 0})!;
  s.pan.move(token, -1e6); s.paint();
  const captured = s.pan.get()!;
  s.clock(6 * 3_600_000);
  s.pan.finish(token);
  const result = s.commits[0]!;
  assert.equal(result.from, s.now + 6 * 3_600_000 - 90 * DAY + 3_600_000);
  assert.equal(result.to - result.from, DAY);
  assert.ok(result.from > captured.from);
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
  assert.equal(s.pan.newestEnd, s.now);
  s.pan.move(token, -1);
  s.paint();
  assert.equal(s.pan.get()!.to, s.now - DAY / 500);
  s.pan.move(token, -100_000);
  s.paint();
  const end = s.pan.get()!.to;
  assert.equal(s.pan.oldestEnd, end);
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
  s.delivered(1_000);
  assert.equal(s.pan.wheel(s.start, wheel(1_000)), true);
  s.delivered(1_016);
  assert.equal(s.pan.wheel({...s.start, source: Symbol(), width: 1_000}, wheel(1_016)), true);
  s.paint();
  assert.equal(s.pan.get()!.to, s.now - 24 * DAY / 500);
  assert.equal(s.timers.size, 1);
  s.delivered(1_216);
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

test('final geometry is delivered before the URL commit, including an input not yet painted', () => {
  const s = setup();
  const order: string[] = [];
  s.pan.onStop(stop => {
    assert.equal(s.commits.length, 0);
    assert.equal(s.pan.active(), null);
    assert.equal(stop.presented.to, s.now);
    assert.equal(stop.draft.to, s.now - DAY / 10);
    assert.equal(stop.changed, true);
    order.push('prepared');
  });
  const token = s.pan.begin(s.start)!;
  s.pan.move(token, -50);
  s.pan.finish(token);
  assert.deepEqual(order, ['prepared']);
  assert.equal(s.commits.length, 1);
});

test('Shift-wheel retains its scale across pauses and commits only on releasing Shift', () => {
  const s = setup();
  s.pan.setShift(true);
  s.pan.wheel({...s.start, span: 2 * DAY}, {...wheel(1_000), shiftKey: true});
  s.paint();
  const first = s.pan.get()!;
  s.pan.wheel({...s.start, span: DAY, width: 1_000}, {...wheel(1_500), shiftKey: true});
  s.paint();
  assert.equal(s.pan.get()!.token, first.token);
  assert.equal(first.originEnd - first.to, first.to - s.pan.get()!.to);
  assert.equal(s.timers.size + s.commits.length, 0);
  s.pan.setShift(false);
  assert.equal(s.commits.length, 1);
  assert.equal(s.pan.active(), null);
});

test('Shift selects chart input immediately after a vertical page wheel', () => {
  const s = setup();
  assert.equal(s.pan.wheel(s.start, {...wheel(1_000, 0), deltaY: -12}), false);
  s.pan.setShift(true);
  assert.equal(s.pan.wheel(s.start, {...wheel(1_016, 0), deltaY: -12, shiftKey: true}), true);
  s.paint();
  assert.equal(s.pan.get()!.to, s.now - 12 * DAY / 500);
  s.pan.setShift(false);
  assert.equal(s.commits.length, 1);
});

test('Shift-wheel return and cancellation never add an address entry on key release', () => {
  for (const cancel of [false, true]) {
    const s = setup();
    s.pan.wheel(s.start, {...wheel(1_000), shiftKey: true});
    if (cancel) s.pan.cancel();
    else s.pan.wheel(s.start, {...wheel(1_500, 12), shiftKey: true});
    s.clock(DAY);
    s.pan.setShift(false);
    assert.equal(s.commits.length + s.timers.size + s.frames.size, 0);
  }
});

test('a pointer can continue a held Shift-wheel transaction and release it once', () => {
  const s = setup();
  s.pan.wheel(s.start, {...wheel(1_000), shiftKey: true});
  s.paint();
  const token = s.pan.get()!.token;
  assert.equal(s.pan.begin(s.start), token);
  s.pan.move(token, -12);
  s.pan.setShift(false);
  assert.equal(s.pan.active(), token, 'pointer capture remains latched');
  s.pan.finish(token);
  assert.equal(s.commits.length, 1);
  assert.equal(s.commits[0]!.to, s.now - 24 * DAY / 500);
});

test('browser wheel properties on its prototype survive modifier normalization', () => {
  const s = setup();
  const event = Object.create({...wheel(1_000), shiftKey: true}) as ReturnType<typeof wheel>;
  assert.equal(s.pan.wheel(s.start, event), true);
  s.paint();
  assert.equal(s.pan.get()!.to, s.now - 12 * DAY / 500);
  s.pan.setShift(false);
  assert.equal(s.commits.length, 1);
});

test('restarting from an unfinished visible frame separates its semantic end from its URL origin', () => {
  const commits: unknown[] = [], frames: (() => void)[] = [];
  const H = 3_600_000, now = 100 * H, origin = {from: now - 2 * H, to: now - H};
  const pan = new Pan({now: () => now, commit: value => commits.push(value), requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const start = {source: Symbol('chart'), input: 'pointer' as const, selected: origin, semanticEnd: origin.to - H / 4, length: H, now, historyStart: 0, span: 2 * H, width: 600};
  const token = pan.begin(start)!;
  assert.equal(pan.get()!.to, start.semanticEnd);
  pan.finish(token); assert.deepEqual(commits, [], 'a no-motion restart preserves its URL origin');
  const next = pan.begin(start)!; pan.move(next, -30); frames.pop()!();
  assert.equal(pan.get()!.to, start.semanticEnd - H / 10);
  pan.cancel(next); assert.deepEqual(commits, [], 'cancel rolls back to the address rather than the borrowed visible frame');
});

test('wheel capture and delivery gaps must agree before splitting a gesture', () => {
  const s = setup();
  // Queued input can have close capture times followed by close delivery times.
  const events = [[65549.2, 65582.6, -448], [65582.8, 65846.5, -24], [65849.3, 65896.4, -193]];
  let token: number | null = null, end = s.now;
  for (const [stamp, delivered, delta] of events) {
    s.delivered(delivered);
    assert.equal(s.pan.wheel(s.start, wheel(stamp, delta)), true);
    token ??= s.pan.active();
    assert.equal(s.pan.active(), token, 'neither clock alone can end an in-flight wheel');
    assert.equal(s.commits.length, 0, 'queued input never commits the address');
    end += delta * (DAY / 500);
    s.paint();
    assert.equal(s.pan.get()!.to, end);
  }
  assert.equal(s.timers.size, 1);
  assert.ok(s.delays.every(ms => ms === 200));
  [...s.timers.values()][0]();
  assert.equal(s.commits.length, 1);
  assert.equal(s.commits[0]!.to, Math.round(end));
  assert.equal(s.frames.size + s.timers.size, 0);
});

test('wheel idle keeps its existing 200 ms boundary in both clocks', () => {
  for (const [captureGap, deliveryGap] of [[200, 199], [199, 200], [200, 200], [201, 201]]) {
    const s = setup();
    s.delivered(1000); s.pan.wheel(s.start, wheel(1000)); const first = s.pan.active();
    s.delivered(1000 + deliveryGap); s.pan.wheel(s.start, wheel(1000 + captureGap));
    const ended = captureGap >= 200 && deliveryGap >= 200;
    assert.equal(s.commits.length, ended ? 1 : 0);
    assert.equal(s.pan.active() === first, !ended);
    assert.ok(s.delays.every(ms => ms === 200));
    [...s.timers.values()][0]();
    assert.equal(s.commits.length, ended ? 2 : 1);
    assert.equal(s.frames.size + s.timers.size, 0);
  }
});

test('wheel axis ownership survives a capture-only or delivery-only gap', () => {
  for (const axis of ['x', 'y']) for (const [captureGap, deliveryGap] of [[400, 16], [16, 400]]) {
    const s = setup(); s.delivered(1000);
    assert.equal(s.pan.wheel(s.start, {...wheel(1000, axis === 'x' ? -12 : 0), deltaY: axis === 'y' ? -12 : 0}), axis === 'x');
    s.delivered(1000 + deliveryGap);
    assert.equal(s.pan.wheel(s.start, {...wheel(1000 + captureGap), deltaY: -24}), axis === 'x');
    assert.equal(s.commits.length, 0);
    if (axis === 'x') {
      s.paint();
      assert.equal(s.pan.get()!.to, [12, 12].reduce((to, delta) => to - delta * (DAY / 500), s.now));
      [...s.timers.values()][0]();
    } else assert.equal(s.pan.active(), null);
  }
});
