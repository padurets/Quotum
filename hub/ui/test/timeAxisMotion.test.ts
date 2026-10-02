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
});
