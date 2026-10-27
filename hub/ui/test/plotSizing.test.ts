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
  const chart = {querySelector: () => ({}), getBoundingClientRect: () => {reads++;return {height:300};}};
  const root = {querySelector: (selector: string) => selector === ':scope > .legend' ? legend : selector === ':scope > .chart' ? chart : folding ? {} : null, getBoundingClientRect: () => {reads++;return {height:500+legend.height-130.5};}};
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

test('natural legends grow and shrink the automatic panel without a fixed viewport',()=>{
  const f=fixture();assert.equal((f.reports.at(-1) as any).natural,500);
  f.resize(60);assert.equal((f.reports.at(-1) as any).natural,429.5);
  f.resize(200);assert.equal((f.reports.at(-1) as any).natural,569.5);
  assert.equal(f.legend.style.height,'');assert.equal(f.legend.style.overflow,'');
  const before=f.reads;f.mutate();assert.equal(f.reads,before,'ordinary data mutations do not measure layout');f.cleanup();
});

test('actual legend growth updates the slot during a gesture without measuring on input',()=>{
  const f=fixture(),before=f.reads,reports=f.reports.length,token=f.start();
  assert.equal(f.reads,before,'starting input performs no geometry read');
  f.pan.move(token,-20);f.paint();assert.equal(f.reads,before);assert.equal(f.reports.length,reports);
  f.resize(260);assert.equal((f.reports.at(-1) as any).natural,629.5,'the slot includes every new legend row before gesture completion');
  const resized=f.reads;f.mutate();f.pan.move(token,-20);f.paint();assert.equal(f.reads,resized,'subsequent input does not measure unchanged content');
  f.pan.cancel(token);f.flush();assert.equal(f.reads,resized);f.cleanup();
});

test('replaced legends are observed and old legends release their subscription',()=>{
  const f=fixture(),old=f.legend;f.replace(70.25);
  assert.ok(f.observers.every(observer=>!observer.targets.has(old)));
  assert.equal((f.reports.at(-1) as any).natural,439.75);
  f.resize(90);assert.equal((f.reports.at(-1) as any).natural,459.5);f.cleanup();
  assert.ok(f.observers.every(observer=>observer.targets.size===0));
});

test('gesture completion cannot measure an unmounted panel',()=>{
  const f=fixture(),token=f.start();f.pan.cancel(token);f.cleanup();const before=f.reads;
  f.flush();assert.equal(f.reads,before);assert.equal(f.reports.at(-1),null);
});
