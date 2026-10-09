import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Pan} from '../lib/pan';

/** Executes the complete production hook with observer-delivered box sizes. */
function fixture() {
  const H = 3_600_000, now = 100 * H;
  const frames: (() => void)[] = [], microtasks: (() => void)[] = [], cleanups: (() => void)[] = [];
  const mutations: (() => void)[] = [], rangeListeners: (() => void)[] = [];
  let range: {from: number; to: number} | null = null, reads = 0, folding = false;
  const reports: unknown[] = [];
  const pan = new Pan({now: () => now, commit: value => {range = value; rangeListeners.forEach(run => run());}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const makeLegend = (height: number) => {
    const element = {height, style: {height: '', overflow: '', alignContent: ''}, getBoundingClientRect: () => {reads++; const held = parseFloat(element.style.height); return {height: Number.isFinite(held) ? held : element.height};}};
    return element;
  };
  let legend = makeLegend(130.5);
  const chart = {querySelector: () => ({}), getBoundingClientRect: () => ({height: 300})};
  const root = {querySelector: (selector: string) => selector === ':scope > .legend' ? legend : selector === ':scope > .chart' ? chart : folding ? {} : null, getBoundingClientRect: () => ({height: 500})};
  const observers: {targets: Set<object>; deliver(target: object, height: number, border?: boolean): void}[] = [];
  const effect = (run: () => void | (() => void)) => {const cleanup = run(); if (cleanup) cleanups.push(cleanup);};
  const context = {pan, devicePixelRatio: 1, useSizing: () => ({manual: false, allocated: 0, width: 'full', report: (report: unknown) => reports.push(report)}), useLocale: () => 'en',
    useRef: (current: unknown) => ({current}), useState: (value: unknown) => [value, () => {}], useCallback: (run: unknown) => run, useLayoutEffect: effect,
    queueMicrotask: (run: () => void) => microtasks.push(run), getComputedStyle: () => ({getPropertyValue: () => '0'}),
    onTimeRange: (run: () => void) => {rangeListeners.push(run); return () => {};}, timeRange: () => range, onPrefs: () => () => {}, prefs: () => ({range: '24h', kind: 'weekly', activityBy: 'provider'}), page: {listen: () => () => {}},
    MutationObserver: class {constructor(run: () => void) {mutations.push(run);} observe() {} disconnect() {}},
    ResizeObserver: class {
      targets = new Set<object>();
      constructor(private readonly run: (entries: unknown[]) => void) {observers.push(this);}
      observe(target: object) {this.targets.add(target);}
      unobserve(target: object) {this.targets.delete(target);}
      disconnect() {this.targets.clear();}
      deliver(target: object, height: number, border = true) {if (this.targets.has(target)) this.run([{target, borderBoxSize: border ? [{blockSize: height}] : [], contentRect: {height}}]);}
    },
    usePlot: null as unknown as (panel: {current: typeof root}) => {onBase(height: number): void},
  };
  const source = readFileSync(new URL('../components/sizing.ts', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('export const pixels'), source.indexOf('/**\n * The plot of a chart')).replaceAll('export ', '');
  const hook = source.slice(source.indexOf('export function usePlot')).replace('export function', 'function');
  runInNewContext(ts.transpileModule(`${helpers}\n${hook}\nglobalThis.usePlot=usePlot;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  const result = context.usePlot({current: root}); result.onBase(300);
  const start = () => pan.begin({source: Symbol(), input: 'pointer', selected: range, length: H, now, historyStart: 0, span: H, width: 500})!;
  return {pan, start, reports, observers, get legend() {return legend;}, get reads() {return reads;}, mutate: () => mutations.forEach(run => run()),
    resize: (height: number, border = true) => {legend.height = height; observers.forEach(observer => observer.deliver(legend, height, border));},
    replace: (height: number) => {legend = makeLegend(height); mutations.forEach(run => run());}, fold: (on: boolean) => {folding = on; mutations.forEach(run => run());},
    paint: () => frames.splice(0).forEach(run => run()), flush: () => microtasks.splice(0).forEach(run => run()), cleanup: () => cleanups.reverse().forEach(run => run())};
}

test('a painted legend holds its observed height through a gesture without reading layout', () => {
  const f = fixture(); f.resize(130.5); const reports = f.reports.length;
  const token = f.start();
  assert.equal(f.reads, 0, 'starting a gesture must not flush a legend after the plot styles change');
  assert.equal(f.legend.style.height, '130.5px');
  f.resize(60); f.mutate();
  assert.equal(f.legend.style.height, '130.5px', 'changed entries cannot resize the held viewport');
  assert.equal(f.reports.length, reports, 'held input cannot change plot allocation');
  f.pan.move(token, -12); f.paint(); f.fold(true); f.pan.finish(token); f.flush(); f.fold(false); f.flush();
  assert.equal(f.legend.style.height, '130.5px', 'a changed range retains the legend viewport after completion');
  assert.equal(f.reads, 0); f.cleanup();
  assert.equal(f.legend.style.height, ''); assert.equal(f.legend.style.overflow, ''); assert.equal(f.legend.style.alignContent, '');
  assert.ok(f.observers.every(observer => observer.targets.size === 0));
});

test('Shift uses the latest observed legend size and cancellation restores its styles', () => {
  const f = fixture(); f.resize(130.5); f.resize(171.25);
  f.pan.setShift(true);
  assert.equal(f.legend.style.height, '171.25px'); assert.equal(f.reads, 0);
  f.pan.setShift(false); f.flush();
  assert.equal(f.legend.style.height, '');
  f.resize(99.5); const token = f.start(); f.pan.cancel(token); f.flush();
  assert.equal(f.legend.style.height, ''); assert.equal(f.reads, 0);
  f.cleanup(); f.start(); assert.equal(f.legend.style.height, '', 'the unmounted hook no longer holds a legend');
});

test('a replacement legend receives its own size and an unseen one uses actual geometry', () => {
  const f = fixture(); f.resize(130.5); const old = f.legend;
  f.replace(70.25);
  assert.ok(f.observers.every(observer => !observer.targets.has(old)));
  const token = f.start();
  assert.equal(f.legend.style.height, '70.25px', 'the old element cannot supply a replacement size');
  assert.equal(f.reads, 1, 'input before the first resize delivery still gets correct geometry');
  f.pan.cancel(token); f.flush(); f.resize(70.25); f.start();
  assert.equal(f.reads, 1, 'the observed replacement no longer needs a synchronous read');
  f.cleanup();
});

test('observed zero and the content-box fallback retain their measured sizes', () => {
  for (const height of [0, 44.5]) {
    const f = fixture(); f.resize(height, false); f.start();
    assert.equal(f.legend.style.height, `${height}px`); assert.equal(f.reads, 0); f.cleanup();
  }
});
