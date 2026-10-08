import {AnalyticsPanel} from '../components/AnalyticsPanel';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {activityEmpty, activityScale} from '../lib/activity';
import {StackPaths} from '../lib/stackPaths';
import {stacksHeight} from '../components/Activity';
import {plotLayerFixture} from './plotLayerFixture';
import {drain} from '../lib/prepare';
import {Pan} from '../lib/pan';
import {navigationKey} from '../lib/axisNavigation';
import {niceTicks} from '../lib/periods';
import {cellStart} from '../../server/domain/history';
import type {History} from '../lib/types';

const {clipPlot, PlotLayer, PlotOverlay} = plotLayerFixture();

test('the actual empty activity result keeps its time axis and legend container at the plotted height', () => {
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const said = activityEmpty(', source.indexOf('export const Activity ='));
  const end = source.indexOf('\n  );', start) + 5;
  const drawing = source.slice(source.indexOf('const Stacks = memo(function Stacks(')) + '\nfunction draw(){' + source.slice(start, end) + '}\nglobalThis.draw=draw;';
  const M = 60_000, H = 60 * M, DAY = 24 * H, NOW = 100 * DAY;
  const range = {from: NOW - 72 * H, to: NOW - 48 * H};
  const history: History = {since: range.from, to: range.to, range: `${range.from}-${range.to}`, live: false, cellMs: 5 * M, historyStart: 0, series: [], events: [], activity: {known: {from: range.from, to: range.to}, since: 0, barMs: H, activeMs: 0, agentMs: 0, agents: 0, cells: [], by: {source: [], project: [], device: []}}};
  const x = (at: number) => 48 + (at - range.from) / DAY * 340;
  const context = {AnalyticsPanel,quotaHistory:{retry:()=>{}},error:undefined as 'history_failed'|undefined,
    navigationKey, navigation: {context: 'test', range: 'range'}, React, ...React, CSS: {escape: (id: string) => id}, StackPaths, stacksHeight, activityScale, niceTicks, cellStart, activityEmpty, MINUTE: M, clipPlot, PlotLayer, PlotOverlay, usePreparationBasis: (basis: unknown) => basis, usePrepared: (work: () => Generator<void, unknown, void>) => ({value: drain(work()), ready: true}), EMPTY_ACTIVITY: history.activity,
    pan: new Pan({now: () => NOW, commit: () => {}, requestFrame: () => null, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}}),
    useLocale: () => 'en', useTimeAxis: () => ({box: {current: null}, svg: {current: null}, width: 400, scale: 1, hover: null, drag: null, clip: 'c', handlers: {}, basis: {...range, end: range.to}, x, drawX: x, screenX: x, commitDrawing: () => {}}),
    clock: () => '', shortDay: () => '', workHours: () => '', stamp: () => '', t: (key: string) => key,
    Tooltip: () => null, useTip: () => ({tip: {current: null}, style: {}}), panel: {current: null}, loading: false,
    history: history as History | null, activity: history.activity, plot: undefined as number | undefined, onBase: () => {}, arrange: {},
    Totals: () => null, ActivitySettings: () => null, LegendItem: () => null,
    shownMs: 0, since: null, from: range.from, to: range.to, setTimeRange: () => {}, by: 'project', selected: range,
    timeRangeKey: (value: typeof range) => `${value.from}-${value.to}`, prefs: {muted: {}, range: '24h'}, groups: [], titles: {}, shownSources: ['s'],
    groupName: (identity: {name: string}) => identity.name, mutedKey: (_by: string, key: string) => key,
    prepared: {ready: true}, presentation: {identities: [], shown: [], strip: null}, strip: null as object | null, panning: null as number | null,
    draw: null as unknown as () => React.ReactNode,
  };
  runInNewContext(ts.transpileModule(drawing, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React}}).outputText, context);
  const markup = () => renderToStaticMarkup(React.createElement(() => context.draw()));
  const complete = markup();
  assert.ok(complete.includes('viewBox="0 0 400 160" style="height:160px"'));
  assert.ok(complete.includes('class="legend"'));
  assert.ok(complete.includes('class="chart-empty">activity.none'));
  assert.ok(!complete.includes('class="chart chart-loading"'));
  context.panning = 1;
  const moving = markup();
  assert.ok(moving.includes('viewBox="0 0 400 160" style="height:160px"'));
  assert.ok(!moving.includes('class="chart-empty">activity.none'), 'the previous empty answer cannot describe a new draft');
  context.panning = null;
  context.history = {...history, range: '24h'};
  assert.ok(!markup().includes('class="chart-empty">activity.none'), 'an old answer cannot describe a pending selected frame');
  context.history = null;
  assert.ok(markup().includes('viewBox="0 0 400 160"'), 'initial loading keeps an input-capable empty axis');
  context.error='history_failed';
  const failed=markup();
  assert.ok(failed.includes('history-error'));assert.ok(!failed.includes('history.loading'));
  assert.ok(failed.includes('viewBox="0 0 400 160"'),'a failed reader retains a usable empty axis');
});
