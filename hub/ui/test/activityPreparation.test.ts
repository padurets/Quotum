import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {activityScale} from '../lib/activity';
import {plotGroupsPrepared, type PlotBuffer, type PlotGroup} from '../lib/historyPlot';
import {StackPaths} from '../lib/stackPaths';
import {groupRegistry} from '../lib/plotRegistry';
import {cellStart} from '../../server/domain/history';
import {niceTicks} from '../lib/periods';
import {navigationKey} from '../lib/axisNavigation';
import {preparationFixture} from './preparationFixture';

test('actual Activity generators hold one coherent model and produce exact stacks after interrupted preparation', () => {
  const H = 3_600_000, length = 30 * 24 * H, barMs = 2 * H;
  const buffer = (start: number): PlotBuffer => {
    const activityCells: PlotBuffer['activityCells'] = new Map();
    for (let i = 0; i < 480; i++) {
      const at = start + i * barMs, parts = new Map(Array.from({length: 30}, (_, j) => [`s${j}`, {ms: (j + 1) * 60_000, name: null}]));
      activityCells.set(at, {at, agentMs: 465 * 60_000, activeMs: 0, refs: new Set(), parts: {source: parts, project: parts, device: parts}});
    }
    return {token: 1, epoch: 1, version: start, from: start, to: start + 480 * barMs, cell: barMs, length, barMs, coverage: [[start, start + 480 * barMs]], activityCells, series: [], events: [], knownFrom: start};
  };
  const parent = preparationFixture(), child = preparationFixture(); let aggregates = 0, draws = 0;
  class CountedPaths extends StackPaths {override *drawPrepared(...args: Parameters<StackPaths['drawPrepared']>) {draws++; return yield* super.drawPrepared(...args);}}
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const prepared = usePrepared(');
  const region = source.slice(start, source.indexOf('  const shownMs = ', start));
  type Model = {identities: {key: string; name: string | null}[]; shown: {group: PlotGroup; color: string; name: string}[]; strip: PlotBuffer};
  const navigation = {context: 'test', range: 'range'};
  const context = {navigationKey, React, ...parent, memo: (fn: unknown) => fn, useState: child.useState, useEffect: () => {}, useId: () => 'c',
    EMPTY_CELLS: [], registry: {current: null}, groups: [], colors: [], shown: [], strip: buffer(0), by: 'project', prefs: {muted: {}}, locale: 'en', history: {board: 'b'}, arrange: {view: {}}, titles: {},
    groupRegistry, groupName: (group: {key: string}) => group.key, mutedKey: (_by: string, key: string) => key,
    plotGroupsPrepared: function* (...args: Parameters<typeof plotGroupsPrepared>) {aggregates++; return yield* plotGroupsPrepared(...args);},
    StackPaths: CountedPaths, stacksHeight: () => 160, activityScale, niceTicks, cellStart, MINUTE: 60_000,
    CSS: {escape: (id: string) => id}, pan: {active: () => 1, subscribe: () => () => {}}, useLocale: () => 'en',
    useTimeAxis: () => ({box: {current: null}, svg: {current: null}, width: 400, scale: 1, hover: null, drag: null, clip: 'c', handlers: {}, basis: {from: 0, to: length, end: length}, active: true, commitDrawing: () => {}}),
    useTip: () => ({tip: {current: null}, style: {}}), PlotLayer: () => null, PlotOverlay: () => null, Tooltip: () => null,
    clock: () => '', shortDay: () => '', workHours: () => '', stamp: () => '', t: (key: string) => key,
    prepareParent: null as unknown as () => {value: Model | null; ready: boolean}, Stacks: null as unknown as (props: object) => React.ReactNode,
  };
  runInNewContext(ts.transpileModule(`function prepareParent(){${region}\nreturn prepared;}\n${source.slice(source.indexOf('const Stacks = memo(function Stacks('))}\nglobalThis.prepareParent=prepareParent;globalThis.Stacks=Stacks;`, {compilerOptions: {target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React}}).outputText, context);
  const renderParent = () => {Object.assign(context, parent); parent.begin(); return context.prepareParent();};
  assert.equal(renderParent().value, null); assert.equal(aggregates, 0); parent.commit(); parent.finish();
  const first = renderParent().value!; assert.equal(first.identities.length, 30); assert.equal(aggregates, 1);
  const replacement = buffer(barMs); replacement.coverage = [[replacement.from, replacement.to - barMs]];
  replacement.activityCells.get(replacement.to - barMs)!.parts.project.set('pending', {ms: 60_000, name: 'New group'});
  context.strip = replacement; assert.equal(renderParent().value, first); parent.commit(); parent.tick();
  context.strip = buffer(2 * barMs); renderParent(); parent.commit(); parent.tick();
  context.strip = replacement; renderParent(); parent.commit(); parent.finish();
  const current = renderParent().value!;
  assert.equal(current.identities.find(group => group.key === 'pending')?.name, 'New group');
  assert.equal(current.shown.find(row => row.group.key === 'pending')!.group.cells.length, 0, 'an unread bar contributes no height');
  const pathsOf = (node: React.ReactNode): string[] => {
    if (Array.isArray(node)) return node.flatMap(pathsOf);
    if (!React.isValidElement<{className?: string; d?: string; children?: React.ReactNode}>(node)) return [];
    return node.props.className === 'activity-stack' && node.props.d !== undefined ? [node.props.d] : pathsOf(node.props.children);
  };
  const props = {activity: {barMs}, origin: 0, groups: current.shown, from: 0, to: length, unknownTo: null, plot: undefined, onBase: () => {}, onSelect: () => {}, strip: current.strip, prepared: true, navigation, by: 'project', allMuted: false, empty: null};
  const renderChild = () => {Object.assign(context, child); child.begin(); return pathsOf(context.Stacks(props));};
  assert.deepEqual(renderChild(), []); assert.equal(draws, 0); child.commit(); child.finish();
  const actual = renderChild();
  const expected = new StackPaths().draw(current.shown, 0, 340 / length, barMs, 160, activityScale(465 * 60_000).max);
  assert.deepEqual([...actual], expected); assert.equal(draws, 1);
});
