import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {buildApp} from '../../server/api.js';
import {Duty} from '../../server/duty.js';
import {Ingest} from '../../server/ingest.js';
import {Pairing} from '../../server/pairing.js';
import {ResetFeed} from '../../server/resets.js';
import {Setup} from '../../server/setup.js';
import {Directory} from '../../server/store/directory.js';
import {Store} from '../../server/store/store.js';
import type {ResetEvent, ResetProvider} from '../../server/domain/resets.js';
import {setLocale} from '../../ui/i18n/index.js';
import {agentRows, drawn, folderOf} from '../../ui/lib/agents.js';
import {forecastRow} from '../../ui/lib/forecast.js';
import {chartEvents, chartFrom, chartResets, linesOf} from '../../ui/lib/lines.js';
import {planNote, started} from '../../ui/lib/plan.js';
import {shown as gathered, type Projects} from '../../ui/lib/projects.js';
import {dotOf, level, resetLine, titled, windowName} from '../../ui/lib/quota.js';
import {resetLabel, type Resets, type TrackerHealth} from '../../ui/lib/resets.js';
import {ANALYTICS_KINDS, type History, type Overview} from '../../ui/lib/types.js';
import {AGENTS, boardState, cardId, FORECAST, HISTORY, isHidden, isWindowHidden, planOf} from '../../ui/lib/view.js';
import {SCENES, SETS} from '../catalogue.js';
import {
  awake,
  cards,
  earliest,
  failuresAt,
  HOLDS,
  homeOf,
  HOUR,
  machines,
  MIN,
  people,
  personOf,
  problems,
  SECOND,
  sessionsAt,
  snapshot,
  staleAfter,
  type Agent,
  type Card,
  type CardCheck,
  type DemoSet,
  type Entry,
  type Machine,
  type Span,
} from '../model.js';
import {Live, setUp, type Stand} from '../setup.js';
import {Trackers} from '../trackers.js';

setLocale('en');
const SETUP = 'BCDF-GHJK';
const TICK = 15 * SECOND;
const setOf = (id: string) => SETS.find(set => set.id === id)!;

/** What the trackers of a scene told, as `/api/resets` answers: the status per provider, their health and the resets kept. */
type Told = {resets: Resets; trackers: TrackerHealth[]; past: Partial<Record<ResetProvider, ResetEvent[]>>};

/** A hub in this process on a free port, its trackers read from the stand-in's `scene`. */
async function hubFor(trackers: Trackers, scene: string, start: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'quotum-demo-test-'));
  const store = new Store(path.join(dir, 'db.sqlite'), start);
  const directory = new Directory(store.db);
  const urls = trackers.urls(scene);
  const resets = new ResetFeed((provider, reset) => store.announce(provider, reset), () => {}, {enabled: true, codexApi: urls.codex, claudeApi: urls.claude, timeoutMs: 300});
  const app = await buildApp({store, directory, resets, ingest: new Ingest(store, directory, new Duty()), pairing: new Pairing(directory), setup: new Setup(true, SETUP), local: null});
  await app.listen({host: '127.0.0.1', port: 0});
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    base,
    /** One round of the hub's own trackers, as its timer runs it, and what the page reads then. */
    async told(): Promise<Told> {
      await resets.round();
      return (await fetch(`${base}/api/resets`)).json() as Promise<Told>;
    },
    async close() {
      await app.close();
      store.close();
      rmSync(dir, {recursive: true, force: true});
    },
  };
}

/** How often the test measures: a minute at first and on the sleeping machine, then up to five (eco: its quarter of an hour). */
const cadence = (card: Card, machine: Machine, t: number) => (card.eco ? 15 * MIN : machine.sleeps || t < 30 * MIN ? MIN : 5 * MIN);

const within = (span: Span, t: number) => t >= (span.from ?? 0) && t <= (span.to ?? HOLDS);

/** Where the test looks: every hour, and where every code's span begins, is halfway and ends. */
function points(set: DemoSet): number[] {
  const found = Array.from({length: HOLDS / 3_600_000 + 1}, (_, hour) => hour * 3_600_000);
  for (const entry of [...set.entries, ...SCENES]) {
    for (const check of entry.expect as Span[]) {
      const [from, to] = [check.from ?? 0, check.to ?? HOLDS];
      found.push(from, (from + to) / 2, to);
    }
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

/** What the hub shows at one moment, read once per board as the page would. */
class Reading {
  private readonly overviews = new Map<string, Promise<Overview>>();
  private readonly histories = new Map<string, Promise<History>>();
  private readonly devices = new Map<string, Promise<{reported: string; name: string; os: string; via: string; failures: {provider: string; error: string}[]}[]>>();
  private readonly projectLists = new Map<string, Promise<Projects>>();

  constructor(
    private readonly stand: Stand,
    readonly now: number,
    readonly scenes: Map<string, Told>,
  ) {}

  private reader(board: string) {
    const entry = this.stand.set.entries.find(e => e.kind === 'board' && e.id === board);
    return this.stand.people.get(entry?.kind === 'board' ? entry.owner : board)!;
  }

  overview(board: string): Promise<Overview> {
    if (!this.overviews.has(board)) {
      const id = this.stand.boards.get(board)!;
      this.overviews.set(
        board,
        this.reader(board)
          .get<Overview>(`/api/overview?board=${encodeURIComponent(id)}`)
          .then(data => ({...data, sources: titled(data.sources, data.view.names)})),
      );
    }
    return this.overviews.get(board)!;
  }

  /** The board's history over `range`: the last 24 hours, as the chart opens, unless another is asked for. */
  history(board: string, range = '24h'): Promise<History> {
    const key = `${board} ${range}`;
    if (!this.histories.has(key)) {
      const id = this.stand.boards.get(board)!;
      this.histories.set(key, this.reader(board).get<History>(`/api/history?range=${range}&board=${encodeURIComponent(id)}`));
    }
    return this.histories.get(key)!;
  }

  machines(person: string) {
    if (!this.devices.has(person)) this.devices.set(person, this.stand.people.get(person)!.get('/api/devices'));
    return this.devices.get(person)!;
  }

  projects(person: string) {
    if (!this.projectLists.has(person)) this.projectLists.set(person, this.stand.people.get(person)!.get<Projects>('/api/projects'));
    return this.projectLists.get(person)!;
  }
}

/**
 * What the hub shows now for a code, computed with the dashboard's own rules: a value for
 * each thing a code of that kind can claim (a string when there is nothing to look at).
 */
async function shown(stand: Stand, entry: Entry, check: object, reading: Reading): Promise<Record<string, unknown> | string> {
  const {set} = stand;
  const now = reading.now;
  if (entry.kind === 'scene') {
    const told = reading.scenes.get(entry.id)!;
    if ('tracker' in check) return {tracker: check.tracker, health: told.trackers.find(t => t.name === check.tracker)?.detail};
    if ('marked' in check) {
      // On the chart of the first person's board, as it is when the demo runs with this scene:
      // every reset the scene reports is marked once, however many rounds the hub made.
      const {marked: provider, range} = check as {marked: ResetProvider; range?: string};
      const board = people(set)[0].id;
      const [overview, history] = await Promise.all([reading.overview(board), reading.history(board, range)]);
      if (isHidden(overview.view, HISTORY)) return `the chart is hidden on the board ${board}`;
      const marks = chartResets(told.past, linesOf(history, overview, overview.view, 'weekly'), chartFrom(history, now), history.to).filter(m => m.provider === provider);
      return {marked: provider, resets: marks.length, range};
    }
    const {reset} = check as {reset: 'claude' | 'codex'};
    const label = resetLabel(told.resets[reset], now);
    return {reset, label: label?.key ?? null, chance: label?.key === 'possible' ? label.chance : undefined, scope: label?.key === 'done' ? label.scope : undefined};
  }
  if (entry.kind === 'machine') {
    const device = (await reading.machines(personOf(set, entry))).find(d => d.reported === entry.id);
    if (!device) return 'no such machine';
    const failure = 'failure' in check ? (check.failure as {provider: string; error: string}) : null;
    const failed = failure && device.failures.some(f => f.provider === failure.provider && f.error === failure.error);
    return {os: device.os, name: device.name, via: device.via, failure: failed ? failure : device.failures};
  }
  if (entry.kind === 'person' && 'project' in check) {
    // As the tab lists it: its machines in the hub's order, what it gathers as ui/lib names it.
    const {project} = check as {project: string | null};
    const group = (await reading.projects(entry.id)).projects.find(g => g.name === project);
    if ('absent' in check) return {project, absent: !group};
    if (!group) return `no project ${project}`;
    return {project, machines: group.machines.map(m => m.name), reported: gathered(group)};
  }
  if (entry.kind === 'person' || entry.kind === 'board') {
    const overview = await reading.overview(entry.id);
    // A widget hidden on the board shows none of its codes.
    if (('rows' in check || 'agentsOf' in check) && isHidden(overview.view, AGENTS)) return `the table of running agents is hidden on the board ${entry.id}`;
    if ('weeklySeries' in check && isHidden(overview.view, HISTORY)) return `the chart is hidden on the board ${entry.id}`;
    const {rows, empty} = agentRows(overview.sources, overview.view);
    if ('agentsOf' in check) {
      const {agentsOf} = check as {agentsOf: string};
      const folders = rows.filter(row => row.session.project === agentsOf).map(row => folderOf(row.session));
      return {agentsOf, folders: folders.sort((a, b) => (a ?? '').localeCompare(b ?? ''))};
    }
    const series = 'weeklySeries' in check ? linesOf(await reading.history(entry.id), overview, overview.view, 'weekly').length : 0;
    return {
      state: boardState(overview.sources, overview.view),
      rows: empty ?? rows.length,
      // At least as many as claimed.
      weeklySeries: 'weeklySeries' in check ? Math.min(check.weeklySeries as number, series) : undefined,
    };
  }

  const card = check as CardCheck;
  const board = card.board ?? homeOf(set, entry);
  const overview = await reading.overview(board);
  const source = overview.sources.find(s => s.id === stand.sources.get(entry.id));
  if (!source) return `not on the board ${board}`;
  if (isHidden(overview.view, cardId(source.id))) return `hidden on the board ${board}`;
  const dot = dotOf(source, now);
  const values: Record<string, unknown> = {
    error: source.error,
    stale: source.stale,
    title: source.title,
    fresh: dot.warn ? 'warn' : dot.pulsing ? 'pulse' : dot.fresh === 0 ? 'grey' : `fading, ${dot.fresh}`,
    agents: source.sessions.length,
    drawn: drawn(source.sessions),
  };
  const id = 'window' in card ? card.window : 'forecast' in card ? card.forecast : null;
  const live = id === null ? undefined : source.windows.find(w => w.id === id);
  if (id !== null && !live) return `no window ${id}`;
  const weekly = planOf(overview.view, source.id);
  if ('window' in card && live) {
    const note = planNote(live, source.successAt, now, weekly);
    const hidden = isWindowHidden(overview.view, source.id, live.id);
    // A hidden window keeps its name (the card's settings list it) and draws nothing else.
    const onCard = (value: unknown) => (hidden ? 'not drawn: the window is hidden' : value);
    Object.assign(values, {
      window: id,
      level: onCard(level(live.remaining)),
      note: onCard(note?.key ?? null),
      hint: onCard(note ? (note.weekly ? 'weekly' : 'reset') : undefined),
      name: windowName(live),
      reset: onCard(resetLine(live, now).key),
      hidden,
      started: onCard(started(live, source.successAt)),
    });
  }
  if ('forecast' in card && live) {
    if (isHidden(overview.view, FORECAST)) return `the table is hidden on the board ${board}`;
    if (!ANALYTICS_KINDS.includes(live.kind)) return `window ${id} is of the kind ${live.kind}: the table shows only weekly and five-hour windows`;
    const line = linesOf(await reading.history(board), overview, overview.view, live.kind).find(l => l.sourceId === source.id && l.windowId === id);
    if (!line) return `no line of ${id} in the table`;
    const row = forecastRow(line, live, source.successAt, now, weekly);
    Object.assign(values, {
      forecast: id,
      outlook: row.outlook.key,
      tone: row.outlook.tone,
      spent: row.spent.key,
      plan: !row.plan ? 'none' : !row.plan.notable ? 'even' : row.plan.delta >= 0 ? 'behind' : 'ahead',
    });
  }
  if ('event' in card) {
    // Marked on the chart as it opens: the weekly windows of the last 24 hours.
    if (isHidden(overview.view, HISTORY)) return `the chart is hidden on the board ${board}`;
    const history = await reading.history(board);
    const marks = chartEvents(history.events, linesOf(history, overview, overview.view, 'weekly'), chartFrom(history, now));
    const events = marks.filter(m => m.event.sourceId === source.id).map(m => m.event.kind);
    values.event = events.includes(card.event) ? card.event : events;
  }
  return values;
}

const clock = (t: number) => `start + ${Math.floor(t / 3_600_000)}h ${Math.floor((t % 3_600_000) / MIN)}m ${(t % MIN) / 1000}s`;

/** Checks every code of `entries` whose span holds `t` (or all of them); returns what was wrong, and marks what was checked. */
async function checkAll(stand: Stand, entries: Entry[], reading: Reading, t: number | null, checked: Set<string>): Promise<string[]> {
  const wrong: string[] = [];
  for (const entry of entries) {
    for (const [i, check] of (entry.expect as Span[]).entries()) {
      if (t !== null && !within(check, t)) continue;
      checked.add(`${entry.kind} ${entry.id} #${i}`);
      const values = await shown(stand, entry, check, reading);
      const claimed = Object.entries(check).filter(([key]) => key !== 'from' && key !== 'to' && key !== 'board');
      const seen = typeof values === 'string' ? values : Object.fromEntries(claimed.map(([key]) => [key, values[key]]));
      try {
        assert.deepEqual(seen, Object.fromEntries(claimed));
      } catch {
        wrong.push(`${entry.kind} ${entry.id} at ${t === null ? 'start' : clock(t)}: claims ${JSON.stringify(check)}, shows ${JSON.stringify(seen)}`);
      }
    }
  }
  return wrong;
}

/**
 * A hub for every other scene, nobody on it: each keeps what its trackers report and
 * answers `/api/resets` as the set's hub does for the set's own scene.
 */
async function sceneHubs(t: TestContext, trackers: Trackers, except: string, start: number) {
  const hubs = new Map(await Promise.all(SCENES.filter(scene => scene.id !== except).map(async scene => [scene.id, await hubFor(trackers, scene.id, start)] as const)));
  t.after(() => Promise.all([...hubs.values()].map(hub => hub.close())));
  return hubs;
}

/** One round of every scene's trackers, now, as a hub does every ten minutes, and what each hub then answers. */
async function told(hubs: Map<string, {told(): Promise<Told>}>) {
  return new Map(await Promise.all([...hubs].map(async ([scene, hub]) => [scene, await hub.told()] as const)));
}

async function bringUp(t: TestContext, set: DemoSet, start: number) {
  t.mock.timers.enable({apis: ['Date'], now: start - MIN});
  const trackers = await Trackers.start(SCENES, start);
  const hub = await hubFor(trackers, set.scene, start - MIN);
  t.after(async () => {
    await hub.close();
    await trackers.close();
  });
  const stand = await setUp(hub.base, set, start, SETUP, () => Date.now());
  return {stand, trackers, hub};
}

test('the catalogue is consistent', () => {
  for (const set of SETS) assert.deepEqual(problems(set), [], set.id);
  const scenes = SCENES.map(s => s.id);
  assert.equal(new Set(scenes).size, scenes.length, 'scenes are named once');
  for (const set of SETS) assert.ok(scenes.includes(set.scene), `${set.id} starts with a scene that exists`);
  for (const scene of SCENES) assert.ok(scene.expect.length, `scene ${scene.id} expects something`);
});

test('the check of a set names a correction the hub keeps none of, and a project no working agent of the person has', () => {
  const all = setOf('all');
  const ana = (change: object): DemoSet => ({...all, entries: all.entries.map(e => (e.kind === 'person' && e.id === 'ana' ? {...e, ...change} : e))});
  const anas = all.entries.find(e => e.kind === 'person' && e.id === 'ana') as Extract<Entry, {kind: 'person'}>;
  assert.match(problems(ana({projects: {billing: 'billing'}})).join('\n'), /person ana: a name for billing the hub keeps no correction for/);
  assert.match(problems(ana({projects: {billing: ' x'}})).join('\n'), /person ana: a name for billing/);
  assert.match(problems(ana({projects: {billing: ''}})).join('\n'), /person ana: a name for billing/, 'no name');
  assert.match(problems(ana({expect: [...anas.expect, {project: 'infra'}]})).join('\n'), /person ana expects the project infra, which no working agent of theirs has/);
  assert.deepEqual(problems(ana({expect: [...anas.expect, {project: 'infra', absent: true}]})), [], 'absent needs none');
  assert.deepEqual(problems(ana({expect: [...anas.expect, {project: 'docs'}]})), [], 'a corrected name, by what is reported under it');
});

test('the check of a set names a subscription without an account the hub would file elsewhere', () => {
  const all = setOf('all');
  // Ana's Antigravity without an account, on her laptop; her mac-mini delivers another one, Ben's machine none.
  const changed = (change: Partial<Card>): DemoSet => ({...all, entries: all.entries.map(e => (e.kind === 'card' && e.id === 'antigravity' ? {...e, ...change} : e))});
  const agent: Agent = {machine: 'mac-mini', origin: 'terminal', project: null, since: -HOUR};
  assert.match(problems(changed({agents: [agent]})).join('\n'), /card antigravity: an agent on mac-mini, which the hub files under what that machine delivers/);
  assert.deepEqual(problems(changed({agents: [{...agent, machine: 'laptop'}]})), []);
  assert.match(problems(changed({machines: ['laptop', 'ben-mac']})).join('\n'), /card antigravity: machines of different people measure it/);
  // The laptop delivering her Work subscription too: which of the two its agents belong to is the machine's last delivery.
  const both: DemoSet = {...all, entries: all.entries.map(e => (e.kind === 'card' && e.id === 'antigravity-2' ? {...e, machines: [...e.machines, 'laptop']} : e))};
  const onLaptop = {...both, entries: both.entries.map(e => (e.kind === 'card' && e.id === 'antigravity' ? {...e, agents: [{...agent, machine: 'laptop'}]} : e))};
  assert.match(problems(onLaptop).join('\n'), /card antigravity: an agent on laptop, which the hub files under what that machine delivers/);
});

test('machines say how long a measurement holds as the agent does: until the next one, a fifth more and a minute', () => {
  assert.equal(staleAfter(MIN), 132_000);
  assert.equal(staleAfter(5 * MIN), 7 * MIN);
  assert.equal(staleAfter(15 * MIN), 19 * MIN);
});

test('a card with agents spends its five hours as its weeks go, before its agents started too', () => {
  for (const set of SETS) {
    for (const card of cards(set).filter(c => c.agents?.length)) {
      const sessions = (t: number) => snapshot(card, 0, t, MIN).windows.filter(w => w.kind === 'session');
      if (!sessions(0).length) continue;
      const hours = Array.from({length: Math.floor(card.history / 3_600_000) - 6}, (_, i) => -card.history + i * 3_600_000);
      const unused = hours.filter(t => sessions(t).every(w => w.usedPercent === 0)).length;
      assert.ok(unused < hours.length / 2, `${set.id} ${card.id}: five hours unused in ${unused} of ${hours.length} hours of its history`);
    }
  }
});

test('the demo is the same whenever it starts: everything is timed from the start, not by the clock or the calendar', () => {
  for (const file of ['model.ts', 'catalogue.ts', 'setup.ts', 'trackers.ts']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Math\.random|Date\.now|new Date\(\)/, file);
  }
  // Times as offsets from the start: two starts a day and a bit apart must tell the same.
  const fromStart = (start: number, value: unknown) =>
    JSON.stringify(value, (_key, field) => (typeof field === 'string' && /^\d{4}-\d\d-\d\dT/.test(field) ? Date.parse(field) - start : field));
  const everything = (set: DemoSet, start: number) => {
    const at = (t: number) => new Date(start + t).toISOString();
    return fromStart(start, {
      cards: cards(set).map(card => [-9 * 86_400_000, -3_600_000, 0, 3_600_000, 30 * 3_600_000].map(t => snapshot(card, start, t, MIN))),
      agents: machines(set).map(machine => [-3 * MIN, 0, 5 * MIN + 30 * SECOND, 3_600_000].map(t => sessionsAt(set, machine, start, t))),
      failures: machines(set).map(machine => [-MIN, 0, 3_600_000].map(t => failuresAt(set, machine, start, t))),
      scenes: SCENES.map(scene => [scene.codex(at), scene.claude(at)]),
    });
  };
  const start = Date.parse('2026-09-21T09:17:00Z');
  for (const set of SETS) assert.equal(everything(set, start + 1.37 * 86_400_000), everything(set, start), set.id);
});

test('every entry of the whole catalogue shows what it claims for twelve hours', {timeout: 180_000}, async t => {
  const set = setOf('all');
  const start = Math.floor(Date.now() / MIN) * MIN;
  const {stand, trackers, hub} = await bringUp(t, set, start);
  const live = new Live(stand, cadence);
  const hubs = new Map([[set.scene, hub], ...(await sceneHubs(t, trackers, set.scene, start - MIN))]);
  const entries = [...set.entries, ...SCENES];
  const checked = new Set<string>();
  const wrong: string[] = [];

  let previous: number | null = null;
  for (const at of points(set)) {
    // The lists of running agents the live loop sent last: every machine's, 15 seconds
    // ago (Live leaves out those asleep); before that, the last one of a machine that fell
    // asleep since the last point, at its last tick awake.
    const tick = Math.floor((at - TICK) / TICK) * TICK;
    const since = previous === null ? tick : Math.floor((previous - TICK) / TICK) * TICK;
    for (const machine of machines(set).filter(m => !awake(m, tick))) {
      for (let last = tick - TICK; last > since; last -= TICK) {
        if (!awake(machine, last)) continue;
        t.mock.timers.setTime(start + last);
        await live.reportOne(machine, last, start + last);
        break;
      }
    }
    t.mock.timers.setTime(start + tick);
    await live.report(tick, start + tick);
    t.mock.timers.setTime(start + at);
    await live.measure(at, start + at);
    const reading = new Reading(stand, start + at, await told(hubs));
    wrong.push(...(await checkAll(stand, entries, reading, at, checked)));
    previous = at;
  }

  assert.deepEqual(wrong, [], `start ${new Date(start).toISOString()}`);
  const codes = entries.flatMap(entry => entry.expect.map((_, i) => `${entry.kind} ${entry.id} #${i}`));
  assert.deepEqual(
    codes.filter(code => !checked.has(code)),
    [],
    'every code is checked somewhere',
  );
});

test('the showcase comes up clean', {timeout: 60_000}, async t => {
  const set = setOf('showcase');
  const start = Math.floor(Date.now() / MIN) * MIN;
  const {stand, hub} = await bringUp(t, set, start);
  const live = new Live(stand, cadence);
  t.mock.timers.setTime(start - TICK);
  await live.report(-TICK, start - TICK);
  t.mock.timers.setTime(start);
  await live.measure(0, start);
  const reading = new Reading(stand, start, new Map([[set.scene, await hub.told()]]));
  const scene = SCENES.find(s => s.id === set.scene)!;
  assert.deepEqual(await checkAll(stand, [...set.entries, scene], reading, null, new Set()), []);
  const board = people(set)[0].id;
  const first = start + earliest(set);
  assert.deepEqual([(await reading.overview(board)).historyStart, (await reading.history(board)).historyStart], [first, first], 'history starts at the first seeded measurement');
});
