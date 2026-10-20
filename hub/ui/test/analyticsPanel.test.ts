import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as timeRange from '../lib/timeRange';
import * as i18n from '../i18n';
import {HistoryFailure} from '../components/HistoryFailure';
import {AnalyticsTable} from '../components/AnalyticsTable';
import type {History} from '../lib/types';

test('an oversized selected predicate names its recovery without offering an ineffective retry',()=>{
  for(const locale of ['en','ru'] as const){
    i18n.setLocale(locale,false);
    const html=renderToStaticMarkup(React.createElement(HistoryFailure,{error:'filters_limit',retry:()=>{throw new Error('not retryable');}}));
    assert.ok(html.includes(i18n.t('api.filters_limit')));assert.ok(!html.includes('<button'));
  }
  i18n.setLocale('en',false);
});

test('every analytics panel names a retained answer only while a different range is selected', () => {
  let selected: timeRange.TimeRange | null = null;
  const modules: Record<string, unknown> = {'react/jsx-runtime': jsx, '../i18n': i18n, '../lib/prefs': {usePref: () => '24h'}, '../lib/timeRange': {...timeRange, useTimeRange: () => selected}, './HistoryFailure': {HistoryFailure}};
  const context = {exports: {} as {AnalyticsPanel: React.ComponentType<any>}, require: (name: string) => modules[name]};
  runInNewContext(ts.transpileModule(readFileSync(new URL('../components/AnalyticsPanel.tsx', import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, context);
  const history = {range: '24h', since: Date.parse('2026-10-06T12:00Z'), to: Date.parse('2026-10-07T12:00Z')} as History;
  const table = React.createElement(AnalyticsTable, {columns: [{id: 'value', title: 'Amount', width: 120}], rows: [{key: 'one', name: 'Wallet', cells: {value: {content: '$37'}}}], name: 'Balance', layout: 'table', lead: 'value'});
  const render = (className: string, loading: boolean, error?: 'history_failed') => renderToStaticMarkup(React.createElement(context.exports.AnalyticsPanel, {className, title: 'Metrics', history, loading, error, retry: () => {}, children: table}));
  for (const className of ['history', 'forecast', 'activity', 'budget-history', 'budget-table']) {
    selected = null;
    assert.ok(!render(className, false).includes('history-retained'), 'normal headings never repeat the common filter');
    selected = {from: history.since - 86400000, to: history.to - 86400000};
    for (const loading of [true, false]) {
      const markup = render(className, loading, loading ? undefined : 'history_failed');
      assert.ok(markup.includes('history-retained'));
      assert.ok(markup.includes(timeRange.timeRangeLabel({from: history.since, to: history.to})), 'the caption names the actual complete answer');
      assert.ok(markup.includes('$37'), 'retained totals stay available');
      assert.ok(markup.includes('table-wrap'));
    }
    const oldKey = history.range; history.range = timeRange.timeRangeKey(selected);
    assert.ok(!render(className, false).includes('history-retained'), 'the status disappears when the selected answer arrives');
    history.range = oldKey;
  }
  const style = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(style, /\.panel\.is-loading \.analytics-compact\s*\{ opacity: \.5/);
});
