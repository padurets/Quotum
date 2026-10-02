import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {activityScale} from '../lib/activity';
import {plotGroups, type PlotBuffer} from '../lib/historyPlot';
import {StackPaths} from '../lib/stackPaths';
import {stacksHeight} from '../components/Activity';
import {cellStart} from '../../server/domain/history';
import {niceTicks} from '../lib/periods';

test('actual activity preparation reuses both strips through restarted renders with exact paths', () => {
  const H = 3_600_000, length = 30 * 24 * H, barMs = 2 * H;
  const buffer = (start: number): PlotBuffer => {
    const activityCells: PlotBuffer['activityCells'] = new Map();
    for (let i = 0; i < 480; i++) {
      const at = start + i * barMs;
      const parts = new Map(Array.from({length: 30}, (_, j) => [`s${j}`, {ms: (j + 1) * 60_000, name: null}]));
      activityCells.set(at, {at, agentMs: 465 * 60_000, activeMs: 0, refs: new Set(), parts: {source: parts, project: parts, device: parts}});
    }
    return {token: 1, epoch: 1, version: start, from: start, to: start + 480 * barMs, cell: barMs, length, barMs,
      coverage: [[start, start + 480 * barMs]], activityCells, series: [], events: [], knownFrom: start};
  };
  const current = buffer(0), replacing = buffer(barMs);
  let index = 0, aggregates = 0, draws = 0;
  const refs: {current: unknown}[] = [];
  const useRef = (value: unknown) => refs[index++] ?? (refs[index - 1] = {current: value});
  const hook = {exports: {} as {usePlotMemo: <T>(calculate: () => T, deps: readonly unknown[]) => T}, require: () => ({useRef})};
  const options = {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React}};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/plotMemo.ts', import.meta.url), 'utf8'), options).outputText, hook);
  class CountedPaths extends StackPaths {
    override draw(...args: Parameters<StackPaths['draw']>) {draws++; return super.draw(...args);}
  }
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const data = source.match(/  const data = usePlotMemo[^\n]+/)![0];
  const body = `function prepare(strip,by){${data}\nreturn data;}\n` + source.slice(source.indexOf('const Stacks = memo(function Stacks(')) + '\nglobalThis.prepare=prepare;globalThis.Stacks=Stacks;';
  const x = (at: number) => 48 + at / length * 340;
  const context = {React, useRef, usePlotMemo: hook.exports.usePlotMemo, useMemo: (calculate: () => unknown) => calculate(),
    memo: (component: unknown) => component, useState: (value: unknown) => [value, () => {}], useEffect: () => {}, useLayoutEffect: () => {},
    CSS: {escape: (id: string) => id}, StackPaths: CountedPaths, stacksHeight, activityScale, niceTicks, cellStart, MINUTE: 60_000,
    plotGroups: (...args: Parameters<typeof plotGroups>) => {aggregates++; return plotGroups(...args);},
    pan: {active: () => 1}, useLocale: () => 'en',
    useTimeAxis: () => ({box: {current: null}, svg: {current: null}, width: 400, scale: 1, hover: null, drag: null, clip: 'c', handlers: {}, basis: {from: 0, to: length, end: length}, x, drawX: x, active: true}),
    useTip: () => ({tip: {current: null}, style: {}}), PlotLayer: () => null, PlotOverlay: () => null, Tooltip: () => null,
    clock: () => '', shortDay: () => '', workHours: () => '', stamp: () => '', t: (key: string) => key,
    prepare: null as unknown as (strip: PlotBuffer, by: string) => Map<string, {key: string; name: null; cells: [number, number][]}>,
    Stacks: null as unknown as (props: object) => React.ReactNode,
  };
  runInNewContext(ts.transpileModule(body, options).outputText, context);
  const pathsOf = (node: React.ReactNode): string[] => {
    if (Array.isArray(node)) return node.flatMap(pathsOf);
    if (!React.isValidElement<{className?: string; d?: string; children?: React.ReactNode}>(node)) return [];
    return node.props.className === 'activity-stack' && node.props.d !== undefined ? [node.props.d] : pathsOf(node.props.children);
  };
  const render = (strip: PlotBuffer, color: string) => {
    index = 0;
    const groups = [...context.prepare(strip, 'source').values()].map(group => ({group, color, name: group.key}));
    const actual = pathsOf(context.Stacks({activity: {barMs}, origin: 0, groups, from: 0, to: length, unknownTo: null,
      plot: undefined, onBase: () => {}, onSelect: () => {}, strip, by: 'source', allMuted: false, empty: null}));
    const expected = new StackPaths().draw(groups, 0, 340 / length, barMs, stacksHeight(400), activityScale(465 * 60_000).max);
    assert.deepEqual(actual, expected, 'every restarted render has the cold producer outline');
    return actual;
  };
  const first = render(current, 'blue'), next = render(replacing, 'green');
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(render(current, 'red'), first);
    assert.deepEqual(render(replacing, 'orange'), next);
  }
  assert.equal(aggregates, 2, 'the actual parent does not repeat immutable plotGroups extraction');
  assert.equal(draws, 2, 'the actual Stacks does not repeat either retained geometry calculation');
});
