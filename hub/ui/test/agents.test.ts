import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_COLUMNS, AGENT_WIDTHS, agentRows, agentsLayout, byActivity, machinesOf, nextAgentsSort, readAgentsSort, sortedRows, type AgentColumn, type AgentRow} from '../lib/agents';
import type {LiveSession, SourceState, View} from '../lib/types';
import {setLocale} from '../i18n';

const session = (project: string | null, change: Partial<LiveSession> = {}): LiveSession => ({
  project, folder: null, device: {id: 'laptop', name: 'laptop'}, startedAt: 100, lastWorkedAt: null, working: false, origin: 'terminal', ...change,
});
const row = (project: string | null, change: Partial<LiveSession> = {}, title = 'Codex'): AgentRow => ({
  session: session(project, change), source: {id: title, provider: 'codex', title} as SourceState,
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
  const sources = ['z', 'a'].map(id => ({id, sessions: [session('same')]} as SourceState));
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
