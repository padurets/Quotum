import {test} from 'node:test';
import assert from 'node:assert/strict';
import {arranged, planOf, reordered, withHidden, withPlan, withWindowHidden} from '../lib/view';
import {DEFAULT_PLAN} from '../lib/plan';
import type {View} from '../lib/types';

const EMPTY: View = {order: [], hidden: [], windows: [], plans: {}};
const board = ['source:a', 'source:b', 'source:c', 'history'];

test('widgets follow the board’s order, and new ones come after the arranged ones', () => {
  assert.deepEqual(arranged(EMPTY, board), board, 'nothing arranged: the board’s own order');
  const view = {...EMPTY, order: ['history', 'source:c']};
  assert.deepEqual(arranged(view, board), ['history', 'source:c', 'source:a', 'source:b']);
  assert.deepEqual(arranged(view, [...board, 'source:d']).at(-1), 'source:d');
  assert.deepEqual(arranged({...EMPTY, order: ['source:gone', 'source:b']}, board), ['source:b', 'source:a', 'source:c', 'history']);
});

test('moving the shown widgets keeps the hidden ones behind them', () => {
  const view = withHidden({...EMPTY, order: ['source:a', 'source:b', 'history']}, 'source:b', true);
  assert.deepEqual(reordered(view, ['history', 'source:a']).order, ['history', 'source:a', 'source:b']);
  assert.deepEqual(withHidden(withHidden(view, 'source:b', true), 'source:b', false).hidden, []);
});

test('hidden windows and plans belong to the view; the default plan is not stored', () => {
  const view = withWindowHidden(EMPTY, 'a/weekly', true);
  assert.deepEqual(view.windows, ['a/weekly']);
  assert.deepEqual(withWindowHidden(view, 'a/weekly', false).windows, []);
  const planned = withPlan(EMPTY, 'a', [40, 0, 30, 0, 30, 0, 0]);
  assert.deepEqual(planOf(planned, 'a'), [40, 0, 30, 0, 30, 0, 0]);
  assert.deepEqual(planOf(planned, 'b'), DEFAULT_PLAN);
  assert.deepEqual(withPlan(planned, 'a', [...DEFAULT_PLAN]).plans, {});
  assert.deepEqual(planOf({...EMPTY, plans: {a: [50, 60, 0, 0, 0, 0, 0]}}, 'a'), DEFAULT_PLAN, 'a broken plan is not used');
});
