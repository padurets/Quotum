import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {panningProblems, type PanReading} from '../panningBudget';

// Run the production browser probe with the browser's ordered RAF queue.
const source = readFileSync(new URL('../panning.ts', import.meta.url), 'utf8');
const probe = source.match(/await cdp\.evaluate\(`(\(\(\) => \{\n\s*const root=document\.querySelector\('\.history \.chart>svg'\);[\s\S]+?\}\)\(\))`\);/)![1];

function fixture() {
  let time = 0;
  const callbacks: ((stamp: number) => void)[] = [], listeners = new Map<string, (event: object) => void>();
  const schedule = (callback: (stamp: number) => void) => {callbacks.push(callback); return callbacks.length;};
  const layer = (data = false) => ({style: {transform: 'none'}, querySelector: (selector: string) => selector === '.activity-stack' ? data ? {} : null : {getAnimations: () => []}});
  const historyLayer = layer(), activityLayer = layer(true), activityTicks = layer(), activityEdge = layer(true);
  const hiddenHistory = layer(), hiddenActivity = layer();
  const svg = (slides: ReturnType<typeof layer>) => ({
    isConnected: true, dataset: {} as Record<string, string>, style: {height: '200px'},
    classList: {contains: () => false}, getAttribute: () => '0 0 900 200', closest: () => null,
    querySelector: () => slides === historyLayer ? hiddenHistory : hiddenActivity,
    getBoundingClientRect: () => ({width: 450}), viewBox: {baseVal: {width: 900}},
    parentElement: {
      dataset: {axisEnd: '0'},
      querySelector: (selector: string) => slides === historyLayer ? historyLayer : selector === '.plot-clip.is-band > .plot-move' ? activityLayer : activityTicks,
      querySelectorAll: () => slides === historyLayer ? [historyLayer] : [activityTicks, activityLayer, activityEdge],
      addEventListener: (name: string, fn: (event: object) => void) => listeners.set(name, fn), removeEventListener: () => {},
    },
  });
  const historySvg = svg(historyLayer), activitySvg = svg(activityLayer);
  Object.assign(historySvg.dataset, {panOrigin: '0', panScale: '1', panEnd: '0'});
  Object.assign(activitySvg.dataset, {panOrigin: '0', panScale: String(12 / 7), panEnd: '0'});
  const context = {
    performance: {now: () => time, timeOrigin: 0}, URL, URLSearchParams, location: {href: 'https://example.test/', search: ''},
    document: {body: {}, querySelector: (selector: string) => selector.startsWith('.history') ? historySvg : activitySvg},
    history: {pushState: () => {}}, getComputedStyle: () => ({opacity: '1', transform: 'none'}),
    requestAnimationFrame: schedule, cancelAnimationFrame: () => {},
    MutationObserver: class {observe() {} disconnect() {}},
    DOMMatrix: class {a = 1; e: number; constructor(value: string | undefined) {this.e = Number(value?.match(/translateX\(([-.\d]+)px\)/)?.[1] ?? 0);}},
    window: {fetch: async () => ({}), requestAnimationFrame: schedule},
  };
  runInNewContext(probe, context);
  const reading = (context.window as typeof context.window & {__quotumPan: PanReading & {pending: object[]}}).__quotumPan;
  const wheel = (stamp: number, delivered: number, deltaMode = 0) => {time = delivered; listeners.get('wheel')!({type: 'wheel', cancelable: true, deltaX: 12, deltaMode, shiftKey: false, timeStamp: stamp});};
  const update = (i: number, at: number, moves = true, synchronized = true, proportional = true, historyMoves = true, edgeMoves = true) => {
    time = at;
    historySvg.dataset.panEnd = String(12 * i); activitySvg.dataset.panEnd = String(12 * (synchronized ? i : i - 1));
    if (historyMoves) historyLayer.style.transform = `translateX(${-12 * i}px)`;
    if (moves) activityLayer.style.transform = `translateX(${-(proportional ? 7 : 14) * i}px)`;
    activityTicks.style.transform = `translateX(${-7 * i}px)`;
    if (edgeMoves) activityEdge.style.transform = `translateX(${-(proportional ? 7 : 14) * i}px)`;
    hiddenHistory.style.transform = `translateX(${-12 * i}px)`; hiddenActivity.style.transform = `translateX(${-7 * i}px)`;
  };
  const frame = (at: number) => {time = at; return callbacks.splice(0);};
  const runFrame = (at: number) => frame(at).forEach(callback => callback(at));
  return {reading, wheel, update, frame, runFrame, requestFrame: context.window.requestAnimationFrame, context, historySvg, activitySvg};
}

function run(moves: boolean, synchronized: boolean, proportional = true, historyMoves = true, edgeMoves = true): PanReading {
  const f = fixture();
  for (let i = 1; i <= 100; i++) {
    f.wheel(i * 16.7, i * 16.7);
    f.requestFrame(() => f.update(i, i * 16.7, moves, synchronized, proportional, historyMoves, edgeMoves));
    f.runFrame(i * 16.7);
  }
  return {...f.reading, period: '24h', series: 12, charts: 2, rate: 4, expectedPushes: 0, coldReads: 1};
}

test('the actual probe measures input only after both charts move on the same time frame', () => {
  assert.deepEqual(panningProblems(run(true, true)), []);
  const failures: [string, PanReading][] = [
    ['stationary Activity data must fail even while its ticks move', run(false, true)],
    ['different chart times must fail', run(true, false)],
    ['incorrect CSS scale must fail', run(true, true, false)],
    ['stationary History data must fail', run(true, true, true, false)],
    ['stationary Activity edges must fail while the band moves', run(true, true, true, true, false)],
  ];
  for (const [reason, reading] of failures) assert.ok(panningProblems(reading).some(problem => problem.includes('both charts')), reason);
});

test('the probe observes the production update in its own RAF and credits only reached input', () => {
  const f = fixture();
  f.wheel(10, 30); f.wheel(20, 31);
  f.requestFrame(() => f.update(1, 32));
  const callbacks = f.frame(31);
  callbacks[0](31);
  assert.equal(f.reading.latency.length, 0, 'the earlier observer cannot credit input before production updates');
  callbacks[1](31);
  assert.equal(f.reading.latency.length, 1, 'new input cannot be credited by earlier artwork');
  assert.equal(f.reading.latency[0], 22, 'the updated RAF is observed now, without adding another frame');
  assert.equal(f.reading.pending.length, 1);
  f.requestFrame(() => f.update(2, 49)); f.runFrame(48);
  assert.equal(f.reading.latency[1], 29);
  assert.equal(f.reading.pending.length, 0);
});

test('input-free gaps are excluded but pending input keeps delayed frames measurable', () => {
  const f = fixture();
  f.wheel(0, 0); f.requestFrame(() => f.update(1, 16.7)); f.runFrame(16.7);
  for (const at of [33.4, 50.1, 66.8, 83.5]) f.runFrame(at);
  f.wheel(100, 100); f.requestFrame(() => f.update(2, 116.7)); f.runFrame(116.7);
  assert.equal(f.reading.frames.length, 0, 'an input-free stationary pause is not a missed moving frame');
  f.wheel(120, 120);
  for (const at of [133.4, 150.1, 166.8, 183.5]) f.runFrame(at);
  f.requestFrame(() => f.update(3, 200)); f.runFrame(200);
  assert.ok(f.reading.frames[0] > 80, 'pending input cannot erase a delayed movement interval');
  assert.equal(f.reading.latency[2], 80, 'native delivery and processing delays remain in the budget');
});

test('unpainted final input is credited only after its geometry commits', () => {
  const f = fixture();
  f.wheel(0, 0);
  delete f.historySvg.dataset.panEnd; delete f.activitySvg.dataset.panEnd;
  f.context.location.search = '?from=0&to=12';
  f.runFrame(16.7);
  assert.equal(f.reading.latency.length, 0, 'the address alone cannot prove the final chart updated');
  f.historySvg.parentElement.dataset.axisEnd = '12';
  f.runFrame(33.4);
  assert.equal(f.reading.latency.length, 0, 'both charts must publish the final geometry');
  f.activitySvg.parentElement.dataset.axisEnd = '12'; f.runFrame(50.1);
  assert.equal(f.reading.latency[0], 50.1);
  assert.equal(f.reading.updated, 0, 'final metadata cannot manufacture moving frames');
});

test('causal input positions preserve the line and page wheel units', () => {
  for (const [mode, units] of [1, 16, 400].entries()) {
    const f = fixture();
    f.wheel(0, 0, mode); f.requestFrame(() => f.update(units, 16.7)); f.runFrame(16.7);
    assert.equal(f.reading.latency.length, 1);
    assert.equal(f.reading.pending.length, 0);
  }
});
