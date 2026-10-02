import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {Pan} from '../lib/pan';

test('the actual axis publishes committed HTML owners and applies the captured CSS scale', () => {
  const H = 3_600_000, now = 100 * H, selected = {from: now - 2 * H, to: now - H};
  const frames: (() => void)[] = [];
  const pan = new Pan({now: () => now, commit: () => {}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const source = {current: Symbol('chart')};
  const token = pan.begin({source: source.current, input: 'pointer', selected, length: H, now, historyStart: 0, span: H, width: 270})!;
  pan.move(token, -27); frames.shift()!();
  const makeLayer = () => ({style: {transform: ''}});
  const old = makeLayer(), next = makeLayer();
  let owners = [old], released = 0;
  const box = {current: {
    querySelectorAll: (selector: string) => selector === '.plot-move' ? owners : [{getAnimations: () => []}],
    hasPointerCapture: () => true, releasePointerCapture: () => {released++;},
  }};
  const svg = {current: {dataset: {} as Record<string, string>, classList: {contains: () => false, add: () => {}, remove: () => {}, toggle: () => {}}}};
  const commits: (() => void)[] = [];
  const panLayers = {current: [] as ReturnType<typeof makeLayer>[]};
  const captured = {current: null};
  const paintPan = {current: () => {}};
  const context = {pan, source, svg, box, panLayers, captured, paintPan, finished: {current: null}, foldTicket: {current: 0},
    visualGeometry: () => ({...selected, end: selected.to}), setFolding: () => {},
    width: 600, left: 40, right: 20, scale: .5, panPointer: {current: null as {id: number} | null}, wheelBounds: {current: null},
    useLayoutEffect: (commit: () => void) => commits.push(commit),
  };
  const code = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = code.indexOf('  const paint = () => {');
  const region = code.slice(start, code.indexOf('\n  useLayoutEffect(() => {\n    const unsubscribe', start));
  const publish = () => runInNewContext(ts.transpileModule(`{${region}}`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  publish();
  assert.equal(old.style.transform, '', 'preparing a render cannot publish or mutate its surface');
  commits.shift()!();
  assert.equal(old.style.transform, 'translateX(27px)');
  assert.equal(Number(svg.current.dataset.panScale), H / 270);
  const committed = paintPan.current;
  publish();
  assert.equal(paintPan.current, committed, 'input before commit retains the displayed callback');
  committed();
  assert.equal(next.style.transform, '');
  owners = [next];
  commits.shift()!();
  assert.equal(next.style.transform, 'translateX(27px)', 'a replacement surface starts at the same displayed time');
  context.panPointer.current = {id: 7};
  pan.cancel(); paintPan.current();
  assert.equal(released, 1, 'capture is released by the chart box, which owns the input');
  assert.equal(next.style.transform, '');
  assert.equal(svg.current.dataset.panEnd, undefined);
  const continued = pan.begin({source: source.current, input: 'pointer', selected, length: H, now, historyStart: 0, span: H, width: 270})!;
  pan.move(continued, -54); frames.shift()!(); paintPan.current();
  assert.equal(next.style.transform, 'translateX(54px)', 'a new gesture can move the committed artwork before another render commits');
  pan.cancel(); paintPan.current();
});

test('the actual cursor follows shared Shift state after visibility-only cancellation', () => {
  const pan = new Pan({now: () => 0, commit: () => {}, requestFrame: () => null, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const classes = new Set<string>(), events = new Map<string, ((event?: {key: string; shiftKey: boolean}) => void)[]>();
  const listen = (type: string, callback: (event?: {key: string; shiftKey: boolean}) => void) => events.set(type, [...events.get(type) ?? [], callback]);
  const dispatch = (type: string, event?: {key: string; shiftKey: boolean}) => events.get(type)?.forEach(callback => callback(event));
  let mounted = false;
  const context = {pan, window: {}, document: {hidden: false, addEventListener: listen}, addEventListener: listen,
    removeEventListener: () => {}, onTimeRange: () => {}, onPrefs: () => {}, prefs: () => ({}),
    svg: {current: {classList: {toggle: (name: string, on: boolean) => {if (on) classes.add(name); else classes.delete(name);}, remove: (name: string) => classes.delete(name)}}},
    shifting: false, panning: null, folding: false,
    useLayoutEffect: (effect: () => void) => effect(),
    useEffect: (effect: () => void) => {if (!mounted) effect();},
  };
  const panSource = readFileSync(new URL('../lib/pan.ts', import.meta.url), 'utf8');
  const options = {compilerOptions: {target: ts.ScriptTarget.ES2022}};
  runInNewContext(ts.transpileModule(panSource.slice(panSource.indexOf("if (typeof window !== 'undefined')")), options).outputText, context);
  const axis = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const cursor = axis.slice(axis.indexOf("  useLayoutEffect(() => {svg.current?.classList.toggle('is-panning'"), axis.indexOf('  const measured ='));
  const render = () => {context.shifting = pan.shifting(); runInNewContext(ts.transpileModule(cursor, options).outputText, context); mounted = true;};
  render(); pan.onPhase(render);
  dispatch('keydown', {key: 'Shift', shiftKey: true});
  assert.ok(classes.has('is-grabbable'));
  context.document.hidden = true; dispatch('visibilitychange');
  assert.equal(pan.shifting(), false);
  assert.equal(classes.has('is-grabbable'), false, 'visibility-only cancellation clears the grab cursor without a blur or keyup');
  context.document.hidden = false; dispatch('visibilitychange');
  assert.equal(classes.has('is-grabbable'), false);
});

test('starting from a settled axis avoids a style flush but samples an interrupted fold', () => {
  const source = readFileSync(new URL('../components/timeAxis.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const visualGeometry = () => {');
  const body = source.slice(start, source.indexOf('  const geometry = ', start)) + '\nglobalThis.read=visualGeometry;';
  let animated = false, reads = 0;
  const context = {box: {current: {querySelector: () => ({getAnimations: () => animated ? [{}] : []})}},
    from: 0, to: 1000, end: 800, left: 40, right: 12, width: 900,
    getComputedStyle: () => {reads++; return {transform: 'matrix'};},
    DOMMatrix: class {a = .5; e = 20;}, read: null as unknown as () => {from: number; to: number; end: number}};
  runInNewContext(ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
  assert.equal(context.read().to, 1000);
  assert.equal(reads, 0, 'the ordinary start must not flush styles for an unanimated SVG');
  animated = true;
  const sampled = context.read();
  assert.equal(reads, 1);
  assert.equal(sampled.to - sampled.from, 2000, 'an interrupted fold retains its actual displayed scale');
  assert.equal(sampled.end, 800);
});
