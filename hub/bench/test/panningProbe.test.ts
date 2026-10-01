import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {panningProblems, type PanReading} from '../panningBudget';

// Execute the browser probe itself: a count supplied to the budget cannot prove
// that the producer observes a second moving layer.
const source = readFileSync(new URL('../panning.ts', import.meta.url), 'utf8');
const probe = source.match(/await cdp\.evaluate\(`(\(\(\) => \{\n\s*const root=document\.querySelector\('\.history \.chart>svg'\);[\s\S]+?\}\)\(\))`\);/)![1];

function run(moves: boolean, synchronized: boolean, proportional = true): PanReading {
  let time = 0, nextFrame = () => {};
  const listeners = new Map<string, (event: object) => void>();
  const layer = () => ({style: {transform: 'none'}, getAnimations: () => []});
  const historyLayer = layer(), activityLayer = layer();
  const svg = (slides: ReturnType<typeof layer>) => ({
    isConnected: true, dataset: {} as Record<string, string>, style: {height: '200px'},
    getAttribute: () => '0 0 900 200', querySelector: () => slides, closest: () => null,
    addEventListener: (name: string, fn: (event: object) => void) => listeners.set(name, fn),
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
    historyLayer.style.transform = `translateX(${-12 * (i + 1)}px)`;
    if (moves) activityLayer.style.transform = `translateX(${-(proportional ? 7 : 14) * (i + 1)}px)`;
    nextFrame();
  }
  return {...reading, period: '24h', series: 12, charts: 2, rate: 4, expectedPushes: 0, coldReads: 1};
}

test('the actual probe measures input only after both charts move on the same time frame', () => {
  assert.deepEqual(panningProblems(run(true, true)), []);
  for (const reading of [run(false, true), run(true, false), run(true, true, false)]) {
    assert.ok(panningProblems(reading).some(problem => problem.includes('both charts')));
  }
});
