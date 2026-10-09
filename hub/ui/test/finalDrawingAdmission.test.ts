import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import {timeRangeKey} from '../lib/timeRange';

test('actual chart consumers reserve final drawing readiness for the complete target while active partial plots still progress', () => {
  for (const [file, consumer] of [['History', 'Chart'], ['Activity', 'Stacks']]) {
    const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), 'utf8');
    const start = source.indexOf(`<${consumer}\n`), element = source.slice(start, source.indexOf('/>', start) + 2);
    const answered = source.split('\n').find(line => line.startsWith('  const answered = ')) ?? '';
    const selected = {from: 3_600_000, to: 7_200_000};
    const context = {React,error:undefined, Chart: () => null, Stacks: () => null, timeRangeKey,
      selected: selected as typeof selected | null, prefs: {range: '24h', kind: 'weekly'}, history: {board: 'b', range: 'old'},
      panning: null as number | null, prepared: {ready: true}, loading: false,
      model: {visible: [], plans: [], forecasts: [], markers: [], cellMs: 60_000, strip: null}, lines: [],
      presentation: {shown: [], identities: [], strip: null}, frame: {live: false}, activity: {}, drawnActivity: {}, drawing: {since: 0}, EMPTY_ACTIVITY: {},
      from: selected.from, to: selected.to, measured: selected.to, now: selected.to, wantedTo: selected.to, strip: null,
      navigation: {}, since: null, plot: 200, onBase: () => {}, setTimeRange: () => {}, by: 'source', emptyFrame: null, empty: null, t: () => '',
      render: null as unknown as () => React.ReactElement<{prepared: boolean; from: number}>,
    };
    runInNewContext(ts.transpileModule(`function render(){${answered}\nreturn (${element});}\nglobalThis.render=render;`, {compilerOptions: {target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React}}).outputText, context);
    assert.equal(context.render().props.prepared, false, `${file}: a ready partial strip cannot start the final fold before the complete target`);
    assert.equal(context.render().props.from, selected.from, 'ordinary navigation keeps its immediate desired projection');
    context.panning = 1; assert.equal(context.render().props.prepared, true, 'active partial data still publishes without waiting for exact totals');
    context.panning = null; context.history.range = timeRangeKey(selected); assert.equal(context.render().props.prepared, true);
    context.prepared.ready = false; assert.equal(context.render().props.prepared, false);
    context.prepared.ready = true; context.selected = null; context.history.range = '24h'; assert.equal(context.render().props.prepared, true);
  }
});
