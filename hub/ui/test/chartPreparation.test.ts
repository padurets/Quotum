import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {plotPath} from '../lib/plotPath';

test('actual quota paths retain committed geometry until the matching strip is prepared', () => {
  const cellMs = 60_000, end = 720 * cellMs;
  const lines = Array.from({length: 50}, (_, i) => ({points: [
    ...Array.from({length: 720}, (_, j) => [j * cellMs, (i + j) % 100, 1]),
    [end + 4500, 5, 1], [end + 15_000, 0, 1],
  ]}));
  let index = 0, calculations = 0;
  const refs: {current: unknown}[] = [];
  const commits: (() => void)[] = [];
  const useRef = (value: unknown) => refs[index++] ?? (refs[index - 1] = {current: value});
  const useLayoutEffect = (effect: () => void) => commits.push(effect);
  const options = {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React}};
  const hook = {exports: {} as {usePlotMemo: unknown}, require: () => ({useRef, useLayoutEffect})};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/plotMemo.ts', import.meta.url), 'utf8'), options).outputText, hook);
  const source = readFileSync(new URL('../components/Chart.tsx', import.meta.url), 'utf8');
  const region = source.slice(source.indexOf('  const drawFrom = '), source.indexOf('  const none = '));
  type Paths = {line: string; last: [number, number] | null; parts: null}[];
  const context = {React, useRef, usePlotMemo: hook.exports.usePlotMemo, axis: {active: false}, strip: null as object | null,
    from: 0, to: end, now: end, basis: {from: 0, to: end, end}, lines, cellMs,
    width: 900, height: 220, left: 40, right: 12, top: 12, bottom: 28,
    niceTicks: () => ({ticks: [], daily: false}),
    plotPath: (...args: Parameters<typeof plotPath>) => {calculations++; return plotPath(...args);},
    x: (at: number) => 40 + Math.max(0, Math.min(end, at)) / end * 848,
    prepare: null as unknown as () => Paths,
  };
  runInNewContext(ts.transpileModule(`function prepare(){${region}\nreturn paths;}\nglobalThis.prepare=prepare;`, options).outputText, context);
  const render = () => {index = 0; commits.length = 0; return context.prepare();};
  const current = render();
  commits.splice(0).forEach(commit => commit());
  context.axis.active = true;
  context.from += 9000; context.to += 9000; context.now += 9000;
  assert.equal(render(), current, 'fresh Pan N0 does not invalidate the already drawn current paths');
  assert.equal(calculations, 50);
  const strip = {from: 0};
  context.strip = strip;
  context.x = at => 40 + at / end * 848;
  const replacing = render();
  assert.notEqual(replacing, current);
  assert.ok(replacing.every(path => path.last![0] > 888), 'the matching strip admits the fresh tail on the captured scale');
  for (let i = 0; i < 20; i++) {
    context.strip = null;
    assert.equal(render(), current);
    context.strip = strip;
    assert.equal(render(), replacing);
  }
  assert.equal(calculations, 100, 'interrupted renders retain both pure path calculations');
  context.axis.active = false;
  context.strip = null;
  context.basis = {from: context.from, to: context.to, end: context.now};
  context.x = at => 40 + (Math.max(context.from, Math.min(context.to, at)) - context.from) / end * 848;
  const final = render();
  assert.notEqual(final, current, 'ordinary completed geometry is no longer held at the old end');
  assert.ok(final.every(path => path.last![0] === 888 && path.last![1] === 183), 'the completed frame draws the new tail at its own right edge');
});
