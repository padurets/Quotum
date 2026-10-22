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
    select: (value: {from: number; to: number} | null) => {range = value; rangeListeners.forEach(run => run());},
    paint: () => frames.splice(0).forEach(run => run()), flush: () => microtasks.splice(0).forEach(run => run()), flushOne: () => microtasks.shift()?.(), cleanup: () => cleanups.reverse().forEach(run => run())};
}

test('the structural legend shell keeps plot allocation through a gesture without reading layout', () => {
  const f = fixture(); f.resize(130.5); const reports = f.reports.length, geometry = f.reports.at(-1);
  const token = f.start();
  assert.equal(f.reads, 0, 'starting a gesture never measures legend content');
  assert.equal(f.legend.style.height, '', 'data cannot own the structural legend height');
  f.resize(60); f.mutate();
  assert.equal(f.reports.length, reports, 'changed entries cannot reallocate the plot');
  f.pan.move(token, -12); f.paint(); f.fold(true); f.pan.finish(token); f.flush(); f.fold(false); f.flush();
  assert.deepEqual(f.reports.at(-1), geometry, 'the selected range keeps the same plot allocation');
  assert.equal(f.reports.length, reports); assert.equal(f.reads, 0); f.cleanup();
  assert.equal(f.legend.style.height, ''); assert.equal(f.legend.style.overflow, ''); assert.equal(f.legend.style.alignContent, '');
  assert.ok(f.observers.every(observer => observer.targets.size === 0));
});

test('Shift and cancellation preserve the structural shell without content measurements', () => {
  const f = fixture(); f.resize(130.5); f.resize(171.25); const before=f.reports.length,geometry=f.reports.at(-1);
  f.pan.setShift(true);
  assert.equal(f.legend.style.height, ''); assert.equal(f.reads, 0);
  f.pan.setShift(false); f.flush();
  f.resize(99.5); const token = f.start(); f.pan.cancel(token); f.flush();
  assert.deepEqual(f.reports.at(-1),geometry);assert.equal(f.reports.length,before);assert.equal(f.reads,0);
  f.cleanup(); f.start(); assert.equal(f.legend.style.height, '', 'the unmounted hook cannot change a later legend');
});

test('a replacement legend inherits the CSS shell without a synchronous content read', () => {
  const f=fixture();f.resize(130.5);const old=f.legend,before=f.reports.length,geometry=f.reports.at(-1);
  f.replace(70.25);
  assert.ok(f.observers.every(observer=>!observer.targets.has(old)));
  const token=f.start();f.pan.cancel(token);f.flush();f.resize(70.25);f.start();
  assert.equal(f.legend.style.height,'');assert.equal(f.reads,0);
  assert.equal(f.reports.length,before);assert.deepEqual(f.reports.at(-1),geometry);f.cleanup();
});

test('zero and partial legend observations cannot replace useful widget geometry', () => {
  for(const height of [0,44.5]){
    const f=fixture(),before=f.reports.length,geometry=f.reports.at(-1);f.resize(height,false);f.start();
    assert.equal(f.legend.style.height,'');assert.equal(f.reads,0);
    assert.equal(f.reports.length,before);assert.deepEqual(f.reports.at(-1),geometry);f.cleanup();
  }
});

test('repeated completion deliveries never remeasure a structural legend shell', () => {
  const f=fixture();f.resize(130.5);const before=f.reports.length,geometry=f.reports.at(-1);
  const token=f.start();f.pan.cancel(token);f.mutate();f.flush();
  assert.equal(f.reports.length,before,'completion carries no widget-sizing work');
  assert.deepEqual(f.reports.at(-1),geometry);assert.equal(f.reads,0);f.cleanup();
});

test('a completion cannot reallocate a shell used by a newer gesture', () => {
  const f=fixture();f.resize(130.5);const first=f.start();f.pan.cancel(first);
  const second=f.start(),before=f.reports.length,geometry=f.reports.at(-1);f.flush();
  assert.equal(f.legend.style.height,'');assert.equal(f.reports.length,before);
  f.pan.cancel(second);f.flush();
  assert.equal(f.reports.length,before);assert.deepEqual(f.reports.at(-1),geometry);f.cleanup();
});

test('a completion before unmount performs no later measurement', () => {
  const f=fixture();f.resize(130.5);const token=f.start();f.pan.cancel(token);f.mutate();
  f.cleanup();const before=f.reports.length;f.flush();
  assert.equal(f.reports.length,before);assert.equal(f.legend.style.height,'');assert.equal(f.reads,0);
});

test('navigation and later completion preserve the CSS shell and plot allocation', () => {
  const f=fixture();f.resize(130.5);const first=f.start();f.pan.cancel(first);
  f.select({from:90*3_600_000,to:91*3_600_000});
  const second=f.start();f.pan.cancel(second);const before=f.reports.length,geometry=f.reports.at(-1);
  f.flushOne();f.flush();
  assert.equal(f.legend.style.height,'');assert.equal(f.reports.length,before);assert.deepEqual(f.reports.at(-1),geometry);
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.panel > \.legend\s*\{[^}]*height:\s*96px/,'the structural legend shell exists before any gesture');
  f.cleanup();
});
