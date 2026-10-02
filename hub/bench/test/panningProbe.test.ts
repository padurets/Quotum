import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {panningProblems, type PanReading} from '../panningBudget';

// Execute the browser probe itself: a count supplied to the budget cannot prove
// that the producer observes a second moving layer.
const source = readFileSync(new URL('../panning.ts', import.meta.url), 'utf8');
const probe = source.match(/await cdp\.evaluate\(`(\(\(\) => \{\n\s*const root=document\.querySelector\('\.history \.chart>svg'\);[\s\S]+?\}\)\(\))`\);/)![1];

function run(moves: boolean, synchronized: boolean, proportional = true, historyMoves = true, edgeMoves = true): PanReading {
  let time = 0, nextFrame = () => {};
  const listeners = new Map<string, (event: object) => void>();
  const layer = (data = false) => ({style: {transform: 'none'}, querySelector: (selector: string) => selector === '.activity-stack' ? data ? {} : null : {getAnimations: () => []}});
  const historyLayer = layer(), activityLayer = layer(true), activityTicks = layer(), activityEdge = layer(true);
  const hiddenHistory = layer(), hiddenActivity = layer();
  const svg = (slides: ReturnType<typeof layer>) => ({
    isConnected: true, dataset: {} as Record<string, string>, style: {height: '200px'},
    getAttribute: () => '0 0 900 200', closest: () => null,
    querySelector: () => slides === historyLayer ? hiddenHistory : hiddenActivity,
    getBoundingClientRect: () => ({width: 450}), viewBox: {baseVal: {width: 900}},
    parentElement: {
      querySelector: (selector: string) => slides === historyLayer ? historyLayer : selector === '.plot-clip.is-band > .plot-move' ? activityLayer : activityTicks,
      querySelectorAll: () => slides === historyLayer ? [historyLayer] : [activityTicks, activityLayer, activityEdge],
      addEventListener: (name: string, fn: (event: object) => void) => listeners.set(name, fn),
    },
  });
  const historySvg = svg(historyLayer), activitySvg = svg(activityLayer);
  Object.assign(historySvg.dataset, {panOrigin: '0', panScale: '1'});
  Object.assign(activitySvg.dataset, {panOrigin: '0', panScale: String(12 / 7)});
  const context = {
    performance: {now: () => time, timeOrigin: 0}, URL, location: {href: 'https://example.test/'},
    document: {body: {}, querySelector: (selector: string) => selector.startsWith('.history') ? historySvg : activitySvg},
    history: {pushState: () => {}}, getComputedStyle: () => ({opacity: '1', transform: 'none'}),
    requestAnimationFrame: (fn: () => void) => {nextFrame = fn; return 1;},
    MutationObserver: class {observe() {}},
    DOMMatrix: class {a = 1; e: number; constructor(value: string | undefined) {this.e = Number(value?.match(/translateX\(([-.\d]+)px\)/)?.[1] ?? 0);}},
    window: {fetch: async () => ({})},
  };
  runInNewContext(probe, context);
  const reading = (context.window as typeof context.window & {__quotumPan: PanReading}).__quotumPan;
  for (let i = 0; i < 100; i++) {
    time += 16.7;
    historySvg.dataset.panEnd = String(12 * (i + 1));
    activitySvg.dataset.panEnd = String(12 * (synchronized ? i + 1 : i));
    listeners.get('wheel')!({type: 'wheel', cancelable: true, deltaX: 12, shiftKey: false, timeStamp: time});
    if (historyMoves) historyLayer.style.transform = `translateX(${-12 * (i + 1)}px)`;
    if (moves) activityLayer.style.transform = `translateX(${-(proportional ? 7 : 14) * (i + 1)}px)`;
    activityTicks.style.transform = `translateX(${-7 * (i + 1)}px)`;
    if (edgeMoves) activityEdge.style.transform = `translateX(${-(proportional ? 7 : 14) * (i + 1)}px)`;
    hiddenHistory.style.transform = `translateX(${-12 * (i + 1)}px)`;
    hiddenActivity.style.transform = `translateX(${-7 * (i + 1)}px)`;
    nextFrame();
  }
  return {...reading, period: '24h', series: 12, charts: 2, rate: 4, expectedPushes: 0, coldReads: 1};
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
  for (const [reason, reading] of failures) {
    assert.ok(panningProblems(reading).some(problem => problem.includes('both charts')), reason);
  }
});
