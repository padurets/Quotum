import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {compose, targetOf, cellStart, type Chunk} from '../../server/domain/history';
import {plotBar, plotGroups, plotOf} from '../lib/historyPlot';
import {Pan} from '../lib/pan';
import {clipPlot} from '../components/PlotLayer';

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
  const moving = {style: {left: '0px', width: '24px'}};
  const counter = {style: {transform: ''}, firstElementChild: moving};
  const endClip = {style: {transform: ''}, firstElementChild: counter};
  const startClip = {style: {transform: ''}, firstElementChild: endClip};
  const bandClip = {current: {style: {left: '0px', right: '0px', visibility: ''}, firstElementChild: startClip}};
  let committedPaints = 0;
  const committed = () => {committedPaints++;};
  const edges = {current: {querySelectorAll: () => paths}}, edgePaint = {current: committed};
  const commits: (() => void)[] = [];
  const source = readFileSync(new URL('../components/Activity.tsx', import.meta.url), 'utf8');
  const start = source.search(/(?:const paintEdges|edgePaint.current) = \(\) => \{/);
  const body = source.slice(start, source.indexOf('useLayoutEffect(() => pan.subscribe', start));
  const y = (ms: number) => 100 - ms / (.7 * H) * 100;
  runInNewContext(body, {axis: {held: false, visualGeometry: () => ({from: pan.get()!.from, to: pan.get()!.to}), screenX: (at: number) => (at - selected.from) / H - (pan.get()!.to - pan.get()!.originEnd) / H}, edgePaint, strip, mask, bandClip, clipPlot, edges, pan, from: selected.from, to: selected.to, targetOf, cellStart, plotBar, groups, by: 'project', painted: {current: ''}, barMs: strip.barMs, vertical: {max: .7 * H}, height: 100, width: 24, scale: 1, left: 0, right: 0, perMs: 1 / H, x: (at: number) => (at - selected.from) / H, y, useLayoutEffect: (commit: () => void) => commits.push(commit)});
  assert.equal(edgePaint.current, committed, 'a preparing render cannot replace the painter of the old DOM');
  edgePaint.current();
  assert.equal(committedPaints, 1);
  assert.equal(mask.current.getAttribute('width'), null);
  commits[0]();
  assert.equal(bandClip.current.style.visibility, '', 'the HTML band clip retains complete bars');
  assert.equal(mask.current.getAttribute('width'), null, 'continuous motion does not change the SVG mask');
  assert.equal(moving.style.width, '24px', 'narrowing the clip cannot resize its artwork');
  assert.equal(expected.agentMs, DAY * 7 / 10);
  for (const bar of [expected.cells[0], expected.cells.at(-1)!]) {
    assert.ok(paths.some(path => path.getAttribute('d')?.includes(`,${y(bar[2]).toFixed(1)}H`)), 'partial edges have the complete answer’s whole-cell quantities');
  }
  pan.move(token, M / DAY * 1000); frames.shift()!(); edgePaint.current();
  const beforeClip = startClip.style.transform, beforePaths = paths.map(path => path.getAttribute('d'));
  pan.move(token, M / DAY * 1000); frames.shift()!(); edgePaint.current();
  assert.notEqual(startClip.style.transform, beforeClip, 'the full-bar boundary follows movement within the same cell geometry');
  assert.deepEqual(paths.map(path => path.getAttribute('d')), beforePaths, 'moving within the same cells does not rebuild edge quantities');
  pan.cancel();
});
