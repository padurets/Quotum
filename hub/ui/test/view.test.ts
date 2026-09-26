import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AGENTS, arranged, colorOf, columnShown, isHidden, planOf, withColumn, reordered, spanOf, weeklyPlanOf, withColor, withHidden, withPlan, withPlanned, withSpan, withWindowHidden} from '../lib/view';
import {CARD_COLORS, PROVIDERS} from '../lib/providers';
import {DEFAULT_PLAN} from '../lib/plan';
import type {View} from '../lib/types';

const EMPTY: View = {order: [], sizes: {}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};
const board = ['source:a', 'source:b', 'source:c', 'history'];

test('widgets follow the board’s order; a new one comes next to its natural neighbour', () => {
  assert.deepEqual(arranged(EMPTY, board), board, 'nothing arranged: the board’s own order');
  const view = {...EMPTY, order: ['history', 'source:c', 'source:a', 'source:b']};
  assert.deepEqual(arranged(view, board), view.order);
  assert.deepEqual(arranged(view, [...board, 'forecast']), ['history', 'forecast', 'source:c', 'source:a', 'source:b'], 'the table after the chart');
  const card = ['source:a', 'source:b', 'source:c', 'source:d', 'history'];
  assert.deepEqual(arranged(view, card), ['history', 'source:c', 'source:d', 'source:a', 'source:b'], 'a new card after the one before it');
  assert.deepEqual(arranged({...EMPTY, order: ['source:gone', 'source:b']}, board), ['source:a', 'source:b', 'source:c', 'history']);
});

test('moving the shown widgets keeps the hidden ones behind them', () => {
  const view = withHidden({...EMPTY, order: ['source:a', 'source:b', 'history']}, 'source:b', true);
  assert.deepEqual(reordered(view, ['history', 'source:a']).order, ['history', 'source:a', 'source:b']);
  assert.deepEqual(withHidden(withHidden(view, 'source:b', true), 'source:b', false).hidden, []);
});

test('the list of running agents is off until the owner turns it on', () => {
  assert.equal(isHidden(EMPTY, AGENTS), true);
  const on = withHidden(EMPTY, AGENTS, false);
  assert.deepEqual([on.shown, on.hidden, isHidden(on, AGENTS)], [[AGENTS], [], false]);
  assert.equal(isHidden(withHidden(on, AGENTS, true), AGENTS), true);
  assert.equal(isHidden(EMPTY, 'history'), false, 'the rest are on until hidden');
});

test('a table column hidden is kept per widget; showing every column again stores nothing', () => {
  const view = withColumn(withColumn(EMPTY, AGENTS, 'machine', false), AGENTS, 'origin', false);
  assert.deepEqual(view.columns, {agents: ['machine', 'origin']});
  assert.deepEqual([columnShown(view, AGENTS, 'machine'), columnShown(view, AGENTS, 'state')], [false, false]);
  assert.deepEqual(withColumn(withColumn(view, AGENTS, 'machine', true), AGENTS, 'origin', true).columns, {});
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

test('a plan switched off is kept for when it is switched on again', () => {
  const planned = withPlan(EMPTY, 'a', [40, 0, 30, 0, 30, 0, 0]);
  const off = withPlanned(planned, 'a', false);
  assert.equal(planOf(off, 'a'), null);
  assert.deepEqual(weeklyPlanOf(off, 'a'), [40, 0, 30, 0, 30, 0, 0], 'the editor still has it');
  assert.deepEqual(planOf(off, 'b'), DEFAULT_PLAN, 'other sources keep theirs');
  assert.deepEqual(withPlanned(withPlanned(off, 'a', false), 'a', true), planned);
});

test('a card has its provider’s colour until the board gives it another', () => {
  assert.equal(colorOf(EMPTY, 'a', 'codex'), PROVIDERS.codex.color);
  const teal = withColor(EMPTY, 'a', '#1fa89c');
  assert.equal(colorOf(teal, 'a', 'codex'), '#1fa89c');
  assert.equal(colorOf(teal, 'b', 'codex'), PROVIDERS.codex.color);
  assert.deepEqual(withColor(teal, 'a', null).colors, {});
});

test('the colour grid is five hues in five steps, each a colour the hub takes', () => {
  assert.deepEqual(CARD_COLORS.map(hue => hue.length), [5, 5, 5, 5, 5]);
  const all = CARD_COLORS.flat();
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.every(color => /^#[0-9a-f]{6}$/.test(color)));
  assert.equal(CARD_COLORS[0][2], PROVIDERS.codex.color, 'the middle step is the hue itself');
});

test('a card is half the grid wide by default, a third at least and the whole grid at most', () => {
  const view = {...EMPTY, sizes: {'source:old': 3, 'source:wide': 12}};
  assert.deepEqual([spanOf(view, 'source:new'), spanOf(view, 'history'), spanOf(view, 'source:old'), spanOf(view, 'source:wide')], [6, 12, 4, 12]);
  assert.deepEqual(withSpan(view, 'source:wide', 6).sizes, {'source:old': 3}, 'the default is not stored');
  assert.deepEqual(withSpan(EMPTY, 'source:new', 2).sizes, {'source:new': 4});
});


test('state is off by default; the owner explicitly shows it without reviving an old hidden column', () => {
  assert.equal(columnShown(EMPTY, AGENTS, 'state'), false);
  const old = {...EMPTY, columns: {agents: ['state']}};
  assert.equal(columnShown(old, AGENTS, 'state'), false);
  const shown = withColumn(old, AGENTS, 'state', true);
  assert.equal(columnShown(shown, AGENTS, 'state'), true);
  assert.deepEqual(shown.shownColumns, {agents: ['state']});
  assert.deepEqual(withColumn(shown, AGENTS, 'state', false), old);
  assert.deepEqual(withColumn(withColumn(EMPTY, AGENTS, 'state', true), AGENTS, 'state', true).shownColumns, {agents: ['state']});
});
