import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AGENTS, FORECAST, chosenPlanOf, colorOf, columnShown, isHidden, planOf, withColumn, weeklyPlanOf, withColor, withHidden, withPlan, withPlanned, withWindowHidden} from '../lib/view';
import {CARD_COLORS, PROVIDERS} from '../lib/providers';
import {DEFAULT_PLAN} from '../lib/plan';
import type {View} from '../lib/types';

const EMPTY: View = {version: 2 as const, layout: {columns: 6, places: {}}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};
test('the list of running agents is off until the owner turns it on', () => {
  assert.equal(isHidden(EMPTY, AGENTS), true);
  const on = withHidden(EMPTY, AGENTS, false);
  assert.deepEqual([on.shown, on.hidden, isHidden(on, AGENTS)], [[AGENTS], [], false]);
  assert.equal(isHidden(withHidden(on, AGENTS, true), AGENTS), true);
  assert.equal(isHidden(EMPTY, 'history'), false, 'the rest are on until hidden');
});

test('a table column hidden is kept per widget; showing every column again stores nothing', () => {
  const view = withColumn(withColumn(EMPTY, AGENTS, 'machine', false), AGENTS, 'worked', false);
  assert.deepEqual(view.columns, {agents: ['machine', 'worked']});
  assert.deepEqual([columnShown(view, AGENTS, 'machine'), columnShown(view, AGENTS, 'running')], [false, false]);
  assert.deepEqual(withColumn(withColumn(view, AGENTS, 'machine', true), AGENTS, 'worked', true).columns, {});
});

test("the plan its owner chose for a source, for the forecast's line of it: none by default, not the default chosen as it is, nor one switched off", () => {
  const planned = withPlan(EMPTY, 'a', [40, 0, 30, 0, 30, 0, 0]);
  assert.deepEqual(chosenPlanOf(planned, 'a'), [40, 0, 30, 0, 30, 0, 0]);
  assert.equal(chosenPlanOf(planned, 'b'), null, 'the default plan');
  assert.equal(chosenPlanOf(withPlan(EMPTY, 'a', [...DEFAULT_PLAN]), 'a'), null, 'the default chosen as it is, which is not kept');
  assert.equal(chosenPlanOf(withPlanned(planned, 'a', false), 'a'), null, 'switched off');
  assert.equal(chosenPlanOf({...EMPTY, plans: {a: [50, 60, 0, 0, 0, 0, 0]}}, 'a'), null, 'a broken plan');
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



test("the table's columns are on until the owner turns one off, but the share during work, and off in a range and a period alike", () => {
  assert.ok(['now', 'spent', 'work', 'perwork', 'workleft'].every(column => columnShown(EMPTY, FORECAST, column)), 'a view saved before them');
  assert.equal(columnShown(EMPTY, FORECAST, 'during'), false);
  assert.equal(columnShown(EMPTY, FORECAST, 'agenthours'), false);
  const agentHours = withColumn(EMPTY, FORECAST, 'agenthours', true);
  assert.equal(columnShown(agentHours, FORECAST, 'agenthours'), true);
  assert.equal(columnShown(withColumn(agentHours, FORECAST, 'agenthours', false), FORECAST, 'agenthours'), false);
  const off = withColumn(EMPTY, FORECAST, 'work', false);
  assert.deepEqual(off.columns, {forecast: ['work']});
  assert.deepEqual([columnShown(off, FORECAST, 'work'), columnShown(off, FORECAST, 'spent')], [false, true]);
  const during = withColumn(EMPTY, FORECAST, 'during', true);
  assert.deepEqual(during.shownColumns, {forecast: ['during']});
  assert.equal(columnShown(during, FORECAST, 'during'), true);
});

test('running time is off by default; the owner explicitly shows it without reviving an old hidden column', () => {
  assert.equal(columnShown(EMPTY, AGENTS, 'running'), false);
  const old = {...EMPTY, columns: {agents: ['running']}};
  assert.equal(columnShown(old, AGENTS, 'running'), false);
  const shown = withColumn(old, AGENTS, 'running', true);
  assert.equal(columnShown(shown, AGENTS, 'running'), true);
  assert.deepEqual(shown.shownColumns, {agents: ['running']});
  assert.deepEqual(withColumn(shown, AGENTS, 'running', false), old);
  assert.deepEqual(withColumn(withColumn(EMPTY, AGENTS, 'running', true), AGENTS, 'running', true).shownColumns, {agents: ['running']});
});
