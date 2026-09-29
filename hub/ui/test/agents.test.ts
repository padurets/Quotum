import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_COLUMNS, AGENT_WIDTHS, agentRows, agentsFit, agentsLayout, byActivity, machinesOf, nextAgentsSort, readAgentsSort, sortedRows, type AgentColumn, type AgentRow, type AgentSource} from '../lib/agents';
import type {LiveSession, View} from '../lib/types';
import {setLocale} from '../i18n';

const session = (project: string | null, change: Partial<LiveSession> = {}): LiveSession => ({
  project, folder: null, device: {id: 'laptop', name: 'laptop'}, startedAt: 100, lastWorkedAt: null, working: false, origin: 'terminal', ...change,
});
const row = (project: string | null, change: Partial<LiveSession> = {}, title = 'Codex'): AgentRow => ({
  session: session(project, change), source: {id: title, provider: 'codex', title, sessions: []},
});
const sort = (rows: AgentRow[], column: AgentColumn, descending = false, shown: readonly AgentColumn[] = AGENT_COLUMNS) => sortedRows(rows, {column, descending}, shown);
const active = [
  session('new working', {working: true, startedAt: 300}),
  session('old working', {working: true, startedAt: 10}),
  session('recent work', {lastWorkedAt: 400, startedAt: 50}),
  session('earlier work', {lastWorkedAt: 200, startedAt: 100}),
  session('new unknown', {startedAt: 500}),
  session('old unknown', {startedAt: 150}),
];

test('activity puts working first, then known work, then new sessions, without changing its input', () => {
  for (let i = 0; i < active.length; i++) {
    assert.equal(byActivity(active[i], active[i]), 0);
    for (let j = i + 1; j < active.length; j++) {
      assert.ok(byActivity(active[i], active[j]) < 0, `${active[i].project} before ${active[j].project}`);
      assert.ok(byActivity(active[j], active[i]) > 0);
    }
  }
  const input = [...active].reverse();
  assert.deepEqual([...input].sort(byActivity), active);
  assert.equal(input[0], active.at(-1));
  const older = active.map(({lastWorkedAt: _, ...s}) => s as LiveSession);
  assert.deepEqual([...older].sort(byActivity).map(s => s.project), ['new working', 'old working', 'new unknown', 'old unknown', 'earlier work', 'recent work']);
});

test('activity ties break by start, machine name, machine id, and project, with no project last', () => {
  assert.equal([session('old', {startedAt: 1, lastWorkedAt: 200}), session('new', {startedAt: 2, lastWorkedAt: 200})].sort(byActivity)[0].project, 'new');
  const tied = [
    session(null, {device: {id: 'a', name: 'a'}}), session('z', {device: {id: 'a', name: 'a'}}),
    session('a', {device: {id: 'a', name: 'a'}}), session('b', {device: {id: 'b', name: 'a'}}), session('c', {device: {id: 'a', name: 'b'}}),
  ];
  assert.deepEqual(tied.sort(byActivity).map(s => s.project), ['a', 'z', null, 'b', 'c']);
});

test('card groups and their tray marks follow each machine’s first session; the table breaks a final tie by source', () => {
  const workstation = {id: 'w', name: 'workstation'};
  const groups = machinesOf([active[3], {...active[1], device: workstation}, active[4], {...active[2], device: workstation}]);
  assert.deepEqual(groups.map(m => m.name), ['workstation', 'laptop']);
  assert.deepEqual(groups.map(m => m.sessions.map(s => s.project)), [['old working', 'recent work'], ['earlier work', 'new unknown']]);
  const sources = ['z', 'a'].map((id): AgentSource => ({id, provider: 'codex', sessions: [session('same')]}));
  assert.deepEqual(agentRows(sources, {hidden: []} as unknown as View).rows.map(r => r.source.id), ['a', 'z']);
});

test('every column sorts in both directions and equal values use activity', () => {
  const pairs: [AgentColumn, AgentRow, AgentRow][] = [
    ['project', row('alpha'), row('zulu')],
    ['state', row('working', {working: true}), row('idle')], ['state', row('idle'), row('window', {origin: 'editor'})],
    ['subscription', row('first', {}, 'Alpha'), row('second', {}, 'Zulu')],
    ['machine', row('first', {device: {id: 'z', name: 'Alpha'}}), row('second', {device: {id: 'a', name: 'Zulu'}})],
    ['origin', row('terminal'), row('editor', {origin: 'editor'})], ['origin', row('editor', {origin: 'editor'}), row('app', {origin: 'app'})],
    ['running', row('shorter', {startedAt: 200}), row('longer', {startedAt: 10})],
  ];
  for (const locale of ['en', 'ru'] as const) {
    setLocale(locale);
    for (const [column, a, b] of pairs) {
      assert.deepEqual(sort([b, a], column), [a, b], `${locale}: ${column} ascending`);
      assert.deepEqual(sort([a, b], column, true), [b, a], `${locale}: ${column} descending`);
    }
  }
  setLocale('en');
  for (const column of ['project', 'subscription', 'machine', 'origin', 'running'] as const) {
    const a = row('same', {working: true}), b = row('same');
    for (const descending of [false, true]) assert.deepEqual(sort([b, a], column, descending), [a, b]);
  }
  const recent = row('recent', {lastWorkedAt: 200}), old = row('old', {lastWorkedAt: 100});
  for (const descending of [false, true]) assert.deepEqual(sort([old, recent], 'state', descending), [recent, old]);
});

test('missing projects stay last, and a hidden sort column falls back to activity', () => {
  const missing = row(null, {working: true}), named = row('z');
  for (const descending of [false, true]) assert.deepEqual(sort([missing, named], 'project', descending), [named, missing]);
  assert.deepEqual(sort([named, missing], 'state', true, ['project']), [missing, named]);
  const rows = active.map(session => ({session, source: row('x').source}));
  assert.deepEqual(sortedRows([...rows].reverse(), null, AGENT_COLUMNS), rows);
});

test('headers cycle through both directions and activity; the narrow menu has its own reset', () => {
  const first = nextAgentsSort(null, 'project'), second = nextAgentsSort(first, 'project');
  assert.deepEqual(first, {column: 'project', descending: false});
  assert.deepEqual(second, {column: 'project', descending: true});
  assert.equal(nextAgentsSort(second, 'project'), null);
  assert.deepEqual(nextAgentsSort(second, 'machine'), {column: 'machine', descending: false});
  assert.deepEqual(nextAgentsSort(second, 'project', false), first);
});

test('saved sort choices accept only a known column and a boolean direction', () => {
  for (const column of AGENT_COLUMNS) for (const descending of [false, true]) assert.deepEqual(readAgentsSort({column, descending}), {column, descending});
  for (const value of [null, undefined, 'project', [], {}, {column: 'obsolete', descending: true}, {column: 'project'}, {column: 'project', descending: 1}]) assert.equal(readAgentsSort(value), null);
});

test('layout follows the widget’s width and the owner’s columns at either side of each boundary', () => {
  for (const columns of [AGENT_COLUMNS, ['project', 'origin'] as const, ['project'] as const]) {
    const width = columns.reduce((sum, column) => sum + AGENT_WIDTHS[column], 0);
    assert.equal(agentsLayout(columns, width - 1), 'list');
    assert.equal(agentsLayout(columns, width), 'table');
    assert.equal(agentsLayout(columns, width + 1), 'table');
  }
  assert.equal(agentsLayout(AGENT_COLUMNS, 320), 'list');
  assert.equal(agentsLayout(['project'], 320), 'table');
});

test('a list made shorter than its agents shows the most whole rows that fit, in its order, and says how many more', () => {
  const fit = (budget: number, rows = [40, 60, 50, 30], border = 0) => agentsFit({shell: 30, rows, footer: 20, border, budget});
  assert.deepEqual(fit(180), {shown: 2, hidden: 2, min: 90, natural: 210});
  assert.deepEqual(fit(210), {shown: 4, hidden: 0, min: 90, natural: 210}, 'all fit: no row says more');
  assert.equal(fit(209).shown, 3, 'a pixel short: the last row gives way to the one saying it');
  assert.equal(fit(209.5).shown, 4, 'measured pixels are fractions: half a pixel over still fits');
  assert.equal(fit(209.4).shown, 3);
  // Rows as they stand in the list have a border under each; the last one shown alone has none.
  assert.equal(fit(213, [41, 61, 51, 31], 1).shown, 4, 'exactly as tall as all of them without the last border');
  assert.equal(fit(212, [41, 61, 51, 31], 1).shown, 3);
  // A row does not stand in for a shorter one later on: the rest is said, in order.
  assert.deepEqual(fit(150, [40, 80, 10, 10]), {shown: 1, hidden: 3, min: 90, natural: 170});
  assert.deepEqual(fit(100, [200, 40]), {shown: 1, hidden: 1, min: 250, natural: 270}, 'a first row taller than the room: the widget grows to it');
  assert.deepEqual(agentsFit({shell: 30, rows: [200, 40], footer: 20, border: 0, budget: 100}).min, 250);
  assert.deepEqual(fit(10, [40]), {shown: 1, hidden: 0, min: 70, natural: 70}, 'one row is all there is to show');
  assert.deepEqual(fit(10, []), {shown: 0, hidden: 0, min: 30, natural: 30});
  // Two rows that need less than one and the row saying the rest: their least is all of them.
  assert.deepEqual(fit(0, [10, 10]), {shown: 1, hidden: 1, min: 50, natural: 50});
  assert.deepEqual(fit(50, [10, 10]).shown, 2);
  assert.ok(fit(Infinity, Array(37).fill(64)).natural > fit(Infinity, Array(37).fill(64)).min, 'the least of a long list is not all of it');
});
