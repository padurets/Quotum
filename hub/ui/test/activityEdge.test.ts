import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {compose, targetOf, cellStart, type Chunk} from '../../server/domain/history';
import {plotBar, plotGroups, plotOf} from '../lib/historyPlot';
import {Pan} from '../lib/pan';

test('the actual activity edge painter retains full and partial bars when a selected range moves forward', () => {
  const M = 60_000, H = 60 * M, DAY = 24 * H, NOW = 100 * DAY;
  const frames: (() => void)[] = [];
  const pan = new Pan({now: () => NOW, commit: () => {}, requestFrame: run => {frames.push(run); return run;}, cancelFrame: () => {}, setTimeout: () => null, clearTimeout: () => {}});
  const selected = {from: NOW - 72 * H, to: NOW - 48 * H};
  const token = pan.begin({source: Symbol('activity'), input: 'pointer', selected, length: DAY, now: NOW, historyStart: 0, span: DAY, width: 1000})!;
  pan.move(token, (36 * H + 5 * M) / DAY * 1000); frames.shift()!();
  const range = pan.get()!, target = targetOf(DAY, NOW, 'edge', range);
  const cell = target.cell, from = target.k0 * cell, to = (target.k1 + 1) * cell;
  const chunk: Chunk = {from, to, series: [], resets: [], grants: [], activity: {
    sessions: [['r1', 's', 'P', 'd'], ['r2', 's', 'Q', 'd']], devices: {},
    cells: Array.from({length: (to - from) / cell}, (_, i) => [i, .5 * cell, [[0, .5 * cell], [1, .2 * cell]], []]),
  }};
  const meta = {now: NOW, historyStart: 0, known: {work: 0, sources: {s: 0}}};
  const strip = plotOf([chunk], meta, target, [[from, to]], new Set(), 1, 1, 1);
  const expected = compose([chunk], meta, target, new Set()).activity;
  const groups = plotGroups(strip, target, 'project').map(group => ({group}));
  const element = () => {
    const attributes = new Map<string, string>();
    return {getAttribute: (name: string) => attributes.get(name) ?? null, setAttribute: (name: string, value: string) => attributes.set(name, value)};
  };
  const mask = {current: element()}, paths = groups.map(() => element());
  const edges = {current: {querySelectorAll: () => paths}}, edgePaint = {current: () => {}};
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('edgePaint.current = () => {');
  const body = source.slice(start, source.indexOf('\n  };', start) + 5);
  const y = (ms: number) => 100 - ms / (.7 * H) * 100;
  runInNewContext(body, {edgePaint, strip, mask, edges, pan, from: selected.from, to: selected.to, targetOf, cellStart, plotBar, groups, by: 'project', painted: {current: ''}, barMs: strip.barMs, vertical: {max: .7 * H}, height: 100, perMs: 1 / H, x: (at: number) => (at - selected.from) / H, y});
  edgePaint.current();
  assert.ok(Number(mask.current.getAttribute('width')) > 0, 'the inner mask retains complete bars');
  assert.equal(expected.agentMs, DAY * 7 / 10);
  for (const bar of [expected.cells[0], expected.cells.at(-1)!]) {
    assert.ok(paths.some(path => path.getAttribute('d')?.includes(`,${y(bar[2]).toFixed(1)}H`)), 'partial edges have the complete answer’s whole-cell quantities');
  }
  pan.cancel();
});
