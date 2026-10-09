import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_COLUMNS,
  AGENT_WIDTHS,
  NAME_WIDTH,
  agentRows,
  agentsFit,
  agentsLayout,
  byActivity,
  columnsOf,
  groupsOf,
  machinesOf,
  nextAgentsSort,
  readAgentsBy,
  readAgentsSort,
  runningFrom,
  runningChangesAt,
  sessionPresent,
  sessionPresenceChangesAt,
  since,
  sortedGroups,
  type AgentColumn,
  type AgentGroup,
  type AgentRow,
  type AgentSource,
} from '../lib/agents';
import type {LiveSession, View} from '../lib/types';
import {setLocale} from '../i18n';

const session = (project: string | null, change: Partial<LiveSession> = {}): LiveSession => ({
  project, folder: null, device: {id: 'laptop', name: 'laptop'}, startedAt: 100, lastWorkedAt: null, working: false, origin: 'terminal', workedMs: 0, ...change,
});
const row = (project: string | null, change: Partial<LiveSession> = {}, title = 'Codex'): AgentRow => ({
  session: session(project, change), source: {id: title, provider: 'codex', title, sessions: []},
});
/** Rows as single agents, in the order given (taken as activity order). */
const each = (...rows: AgentRow[]) => groupsOf(rows, 'none');
const projects = (groups: AgentGroup[]) => groups.map(g => g.rows[0].session.project);
const sort = (groups: AgentGroup[], column: AgentColumn, descending = false, shown: readonly AgentColumn[] = AGENT_COLUMNS) => sortedGroups(groups, {column, descending}, shown);
const active = [
  session('new working', {working: true, startedAt: 300}),
  session('old working', {working: true, startedAt: 10}),
  session('recent work', {lastWorkedAt: 400, startedAt: 50}),
  session('earlier work', {lastWorkedAt: 200, startedAt: 100}),
  session('new unknown', {startedAt: 500}),
  session('old unknown', {startedAt: 150}),
];

test('retained presence and running labels stay equal until their own clock boundary',()=>{
  const a=row('A',{ref:'a',currentPresence:{working:false,startedAt:0,through:75_000}});
  const b=row('B',{ref:'b',currentPresence:{working:false,startedAt:10_000,through:100_000}});
  assert.equal(sessionPresenceChangesAt(a.session,70_000),75_000);
  assert.equal(sessionPresent(a.session,74_999),true);assert.equal(sessionPresent(a.session,75_000),false);
  const rows=[a,b];
  for(let now=0;now<120_000;){
    const next=runningChangesAt(rows,now),from=runningFrom(rows,now);
    const read=(at:number)=>{const start=runningFrom(rows,at);return Number.isFinite(start)?since(at-start):null;};
    if(next===null){assert.equal(from,Infinity);break;}
    assert.ok(next>now);assert.equal(read(next-1),read(now));
    now=next;
  }
  assert.equal(runningFrom(rows,75_000),10_000);
  assert.equal(runningFrom(rows,100_000),Infinity);
  assert.equal(runningChangesAt(rows,100_000),null);
});

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

test('agents gather by project, machine or subscription in the order of their most active agent, with what they share added up', () => {
  const server = {id: 's', name: 'server'};
  const rows = [
    row('quotum', {working: true, workedMs: 30, device: server}, 'Claude'),
    row('billing', {lastWorkedAt: 500, workedMs: 20}),
    row('quotum', {lastWorkedAt: 400, workedMs: 10, folder: 'quotum.feat', startedAt: 50}),
    row(null, {origin: 'editor'}),
    row('quotum', {lastWorkedAt: 450, workedMs: 5}, 'Claude'),
  ];
  const [quotum, billing, none] = groupsOf(rows, 'project');
  assert.deepEqual([quotum.name, billing.name, none.name], ['quotum', 'billing', null]);
  assert.deepEqual(
    {working: quotum.working, workedMs: quotum.workedMs, lastWorkedAt: quotum.lastWorkedAt, startedAt: quotum.startedAt, agents: quotum.rows.length},
    {working: 1, workedMs: 45, lastWorkedAt: 450, startedAt: 50, agents: 3},
    'the working one aside, the latest seen working',
  );
  assert.equal(none.lastWorkedAt, null);
  assert.deepEqual(groupsOf(rows, 'machine').map(g => [g.name, g.rows.length]), [['server', 1], ['laptop', 4]]);
  assert.deepEqual(groupsOf(rows, 'subscription').map(g => [g.name, g.rows.length]), [['Claude', 2], ['Codex', 3]]);
  assert.deepEqual(groupsOf(rows, 'none').map(g => g.rows.length), [1, 1, 1, 1, 1], 'nothing to gather by: a row per agent');
  assert.deepEqual(groupsOf([row('null'), row(null)], 'project').map(g => g.name), ['null', null], 'a project named null is not none');
});

test('groups show counts and work; machines and subscriptions belong to individual agents', () => {
  assert.deepEqual(columnsOf('project'), {name: 'project', rest: ['agents', 'worked', 'activity']});
  assert.deepEqual(columnsOf('machine'), {name: 'machine', rest: ['agents', 'worked', 'activity']});
  assert.deepEqual(columnsOf('subscription'), {name: 'subscription', rest: ['agents', 'worked', 'activity']});
  assert.deepEqual(columnsOf('none'), {name: 'project', rest: ['worked', 'activity', 'machine', 'subscription', 'running']});
  assert.deepEqual(columnsOf('project', true), columnsOf('none'));
  assert.deepEqual(columnsOf('machine', true).rest, ['worked', 'activity', 'subscription', 'running']);
  assert.deepEqual(columnsOf('subscription', true).rest, ['worked', 'activity', 'machine', 'running']);
});

test('every column sorts in both directions and equal values keep activity order', () => {
  const pairs: [AgentColumn, AgentRow, AgentRow][] = [
    ['project', row('alpha'), row('zulu')],
    ['subscription', row('first', {}, 'Alpha'), row('second', {}, 'Zulu')],
    ['machine', row('first', {device: {id: 'z', name: 'Alpha'}}), row('second', {device: {id: 'a', name: 'Zulu'}})],
    ['worked', row('less', {workedMs: 10}), row('more', {workedMs: 20})],
    ['activity', row('recent', {lastWorkedAt: 300}), row('working', {working: true})], ['activity', row('earlier', {lastWorkedAt: 200}), row('recent', {lastWorkedAt: 300})],
    ['activity', row('never'), row('earlier', {lastWorkedAt: 200})],
    ['running', row('shorter', {startedAt: 200}), row('longer', {startedAt: 10})],
  ];
  for (const locale of ['en', 'ru'] as const) {
    setLocale(locale);
    for (const [column, a, b] of pairs) {
      assert.deepEqual(projects(sort(each(b, a), column)), projects(each(a, b)), `${locale}: ${column} ascending`);
      assert.deepEqual(projects(sort(each(a, b), column, true)), projects(each(b, a)), `${locale}: ${column} descending`);
    }
  }
  setLocale('en');
  const two = groupsOf([row('a', {working: true}), row('a'), row('b', {working: true})], 'project');
  assert.deepEqual(sort(two, 'agents').map(g => g.name), ['b', 'a'], 'fewer agents first');
  const busy = groupsOf([row('a'), row('a'), row('b', {working: true}), row('b')], 'project');
  assert.deepEqual(sort(busy, 'agents').map(g => g.name), ['a', 'b'], 'as many: fewer working first');
  for (const column of ['project', 'subscription', 'machine', 'worked', 'running'] as const) {
    const groups = each(row('same', {working: true}), row('same'));
    for (const descending of [false, true]) assert.deepEqual(sort(groups, column, descending), groups, `${column} keeps activity order`);
  }
});

test('no project stays last, a hidden sort column keeps activity order, and nothing sorted is the order given', () => {
  const groups = each(row(null, {working: true}), row('z'));
  for (const descending of [false, true]) assert.deepEqual(projects(sort(groups, 'project', descending)), ['z', null]);
  assert.deepEqual(sort(groups, 'worked', true, ['project']), groups);
  assert.equal(sortedGroups(groups, null, AGENT_COLUMNS), groups);
  const grouped = groupsOf([row('z'), row('a')], 'project');
  const {name, rest} = columnsOf('project');
  assert.deepEqual(sort(grouped, 'machine', true, [name, ...rest]), grouped, 'a detail-only column never sorts the overview');
});

test('headers cycle through both directions and activity; the narrow menu has its own reset', () => {
  const first = nextAgentsSort(null, 'project'), second = nextAgentsSort(first, 'project');
  assert.deepEqual(first, {column: 'project', descending: false});
  assert.deepEqual(second, {column: 'project', descending: true});
  assert.equal(nextAgentsSort(second, 'project'), null);
  assert.deepEqual(nextAgentsSort(second, 'machine'), {column: 'machine', descending: false});
  assert.deepEqual(nextAgentsSort(second, 'project', false), first);
});

test('saved choices accept only a known column and a boolean direction, and a known way to gather', () => {
  for (const column of AGENT_COLUMNS) for (const descending of [false, true]) assert.deepEqual(readAgentsSort({column, descending}), {column, descending});
  for (const value of [null, undefined, 'project', [], {}, {column: 'state', descending: true}, {column: 'lastwork', descending: true}, {column: 'project'}, {column: 'project', descending: 1}]) assert.equal(readAgentsSort(value), null);
  for (const by of ['project', 'machine', 'subscription', 'none'] as const) assert.equal(readAgentsBy(by), by);
  for (const value of [null, undefined, 'device', 1, {}]) assert.equal(readAgentsBy(value), 'project');
});

test('layout follows the widget’s width and the owner’s columns at either side of each boundary', () => {
  for (const columns of [columnsOf('project').rest, columnsOf('none').rest, ['worked'] as AgentColumn[], [] as AgentColumn[]]) {
    const width = columns.reduce((sum, column) => sum + AGENT_WIDTHS[column], NAME_WIDTH);
    assert.equal(agentsLayout(columns, width - 1), 'list');
    assert.equal(agentsLayout(columns, width), 'table');
    assert.equal(agentsLayout(columns, width + 1), 'table');
  }
  assert.equal(agentsLayout(columnsOf('project').rest, 320), 'list');
  assert.equal(agentsLayout([], 320), 'table');
  assert.equal(agentsLayout(columnsOf('project').rest, 700), 'table', 'the grouped overview reserves room for all ten tally marks');
  const details = columnsOf('project', true).rest.filter(column => column !== 'running');
  assert.equal(agentsLayout(details, 758), 'table', 'default details fit the wide dialog, without an inset list fallback');
});

test('a list made shorter than its agents shows the most whole rows that fit, in its order, and says how many more', () => {
  const fit = (budget: number, rows = [40, 60, 50, 30], border = 0) => agentsFit({shell: 30, rows, footer: 20, border, budget});
  assert.deepEqual(fit(180), {shown: 2, hidden: 2, min: 90, natural: 210});
  assert.deepEqual(fit(210), {shown: 4, hidden: 0, min: 90, natural: 210}, 'all fit: no row says more');
  assert.equal(fit(209).shown, 3, 'a pixel short: the last row gives way to the one saying it');
  assert.equal(fit(209.5).shown, 4, 'measured pixels are fractions: half a pixel over still fits');
  assert.equal(fit(209.4).shown, 3);
  assert.equal(fit(149.5).shown, 2, 'so it does for the rows over the one saying the rest');
  assert.equal(fit(149.4).shown, 1);
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


test('unknown agent-hours propagate to groups and sort last in both directions', () => {
  const groups = groupsOf([row('mixed', {workedMs: 50}), row('mixed', {workedMs: null}), row('known', {workedMs: 10}), row('zero', {workedMs: 0}), row('unknown', {workedMs: null})], 'project');
  assert.equal(groups[0].workedMs, null);
  assert.deepEqual(projects(sort(groups, 'worked')), ['zero', 'known', 'mixed', 'unknown']);
  assert.deepEqual(projects(sort(groups, 'worked', true)), ['known', 'zero', 'mixed', 'unknown']);
});
