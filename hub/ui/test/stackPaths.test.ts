import {drain} from '../lib/prepare';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {StackPaths} from '../lib/stackPaths';

const groups = [{group: {key: 'p', name: 'P', cells: [[0, 2], [10, 3], [30, 1]] as [number, number][]}}, {group: {key: 'q', name: 'Q', cells: [[0, 1], [10, 2]] as [number, number][]}}];

test('narrow stacks join adjacent bars, preserve holes and follow muted lower groups', () => {
  const cache = new StackPaths();
  const both = cache.draw(groups, 0, .1, 10, 140, 10);
  assert.equal(both[0], 'M0.0,92.0L1.0,92.0L1.0,82.0L2.0,82.0L2.0,112.0L0.0,112.0ZM3.0,102.0L4.0,102.0L4.0,112.0L3.0,112.0Z');
  assert.equal((both[1].match(/M/g) ?? []).length, 1);
  const muted = cache.draw([groups[1]], 0, .1, 10, 140, 10);
  assert.ok(muted[0].startsWith('M0.0,102.0L1.0,102.0'));
  assert.deepEqual(cache.draw(groups, 0, .1, 10, 140, 10), both);
});

test('a constant band keeps its exact outline with only four corners', () => {
  const group = {key: 'p', name: null, cells: Array.from({length: 720}, (_, i): [number, number] => [i * 10, 2])};
  assert.equal(new StackPaths().draw([{group}], 0, .1, 10, 140, 10)[0], 'M0.0,92.0L720.0,92.0L720.0,112.0L0.0,112.0Z');
});

test('wide bars keep their gaps when the plot scale and data change', () => {
  const cache = new StackPaths();
  const wide = cache.draw(groups, 0, 1, 10, 140, 10);
  assert.equal((wide[0].match(/M/g) ?? []).length, 3);
  assert.ok(wide[0].startsWith('M0.5,92.0L9.5,92.0'));
  const moved = cache.draw([{group: {...groups[0].group, cells: [[10, 4]]}}], 10, 1, 10, 140, 10);
  assert.equal(moved[0], 'M0.5,72.0L9.5,72.0L9.5,112.0L0.5,112.0Z');
});

test('retained group paths match a cold draw after edits, holes, muting and reordering', () => {
  const cache = new StackPaths();
  const updates = [groups, groups.map(({group}) => ({group: {...group, cells: group.cells.map(([at, ms]) => [at, ms] as [number, number])}})),
    [groups[1], groups[0]], [groups[1]], [{group: {...groups[0].group, cells: [[0, 4], [30, 1]] as [number, number][]}}, groups[1]],
    [{group: {...groups[0].group, cells: [[30, 1], [0, 4]] as [number, number][]}}, groups[1]], [], groups];
  for (const perMs of [.1, 1]) for (const input of updates) {
    assert.deepEqual(cache.draw(input, 0, perMs, 10, 140, 10), new StackPaths().draw(input, 0, perMs, 10, 140, 10));
  }
  const retained = cache as unknown as {groups: Map<string, {bars: Map<number, unknown>; order: number[]; path: string}>};
  cache.draw([groups[1]], 0, .1, 10, 140, 10);
  assert.equal(retained.groups.size, 1, 'muted groups release their strings and corners');
  assert.deepEqual(retained.groups.get('q')!.order, [0, 10]);
  cache.draw([], 0, .1, 10, 140, 10);
  assert.equal(retained.groups.size, 0, 'a replaced empty strip leaves no retained paths');
});

test('dense whole-cell stacks format shared coordinates once and retain their exact outline', () => {
  const source = readFileSync(new URL('../lib/stackPaths.ts', import.meta.url), 'utf8');
  const counted = source.replace('value.toFixed(1)', '(globalThis.formatCalls++, value.toFixed(1))');
  assert.notEqual(counted, source, 'the counter instruments the actual coordinate formatter');
  const context = {require: () => ({drain}), formatCalls: 0, exports: {} as {StackPaths: typeof StackPaths}};
  runInNewContext(ts.transpileModule(counted, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText, context);
  const H = 3_600_000;
  const dense = Array.from({length: 24}, (_, g) => ({group: {key: String(g), name: null,
    cells: Array.from({length: 720}, (_, i): [number, number] => [i * 2 * H, ((i + g) % 3 + 1) * H]),
  }}));
  const cache = new context.exports.StackPaths();
  const actual = cache.draw(dense, 30 * H, 1294 / (30 * 24 * H), 2 * H, 200, 72 * H);
  assert.deepEqual([...actual], new StackPaths().draw(dense, 30 * H, 1294 / (30 * 24 * H), 2 * H, 200, 72 * H));
  assert.ok(context.formatCalls < 3 * 720, 'dense whole-cell geometry must not format coordinates per group');
  context.formatCalls = 0;
  assert.deepEqual([...cache.draw(dense, 30 * H, 1294 / (30 * 24 * H), 2 * H, 200, 72 * H)], [...actual]);
  assert.equal(context.formatCalls, 0, 'an unchanged strip needs no coordinate formatting');
});

test('cancelling inside changed corners leaves the group dirty until its outline completes', () => {
  const cache = new StackPaths();
  const input = [{group: {key: 'a', name: null, cells: Array.from({length: 180}, (_, i): [number, number] => [i * 10, i % 3 + 1])}}];
  cache.draw(input, 0, .01, 10, 140, 10);
  const changed = [{group: {...input[0].group, cells: input[0].group.cells.map(([at, value]): [number, number] => [at, value + 1])}}];
  const partial = cache.drawPrepared(changed, 0, .01, 10, 140, 10);
  for (let i = 0; i < 90; i++) assert.equal(partial.next().done, false);
  partial.return([]);
  assert.deepEqual(cache.draw(changed, 0, .01, 10, 140, 10), new StackPaths().draw(changed, 0, .01, 10, 140, 10));
});
