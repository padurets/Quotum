import {test} from 'node:test';
import assert from 'node:assert/strict';
import {INITIAL, metaOf, reduce, titlesOf, type HubEvent, type PageEvent, type PageState, type Snapshot} from '../lib/board';
import {createStore, selector, shallowEqual} from '../lib/store';
import type {Card, SeriesForecast} from '../lib/types';

const card = (id: string, used = 50, extra: Partial<Card> = {}): Card => ({
  id,
  provider: 'codex',
  plan: 'pro',
  successAt: 1000,
  error: null,
  stale: false,
  windows: [{id: '5h', kind: 'session', label: null, used, remaining: 100 - used, resetAt: null, minutes: 300}],
  resets: null,
  owners: ['Ana'],
  staleAfterMs: 420_000,
  ...extra,
});

const VIEW = {layout: {columns: 6, places: {}}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};
const session = {device: {id: 'd', name: 'laptop'}, origin: 'terminal' as const, project: 'quotum', folder: null, startedAt: 1, lastWorkedAt: null, working: true};
const ahead = (F: number): SeriesForecast => ({
  state: 'lasts',
  asOf: 3600_000,
  resetAt: 7 * 86_400_000,
  anchor: {at: 3000_000, left: 60},
  F,
  zero: null,
  shownZero: null,
  shownLeft: Math.round(F / 5) * 5,
  comfy: true,
  points: [[0, 60], [100, F]],
  basis: {hours: 72, cold: false, usualPerDay: 10, lastDay: 1, burst: null},
});

function snapshot(change: Partial<Snapshot> = {}): Snapshot {
  return {
    board: {id: 'b1', name: '', personal: true},
    view: VIEW,
    historyStart: 0,
    sources: [card('s1'), card('s2')],
    sessions: {s1: [session], s2: []},
    refresh: {s1: {unavailable: null, availableAt: null, retryAt: null, request: null}},
    cadence: {s1: {next: 5000, why: 'idle'}, s2: null},
    forecast: {s1: {weekly: ahead(20)}, s2: {}},
    mine: ['s1', 's2'],
    boards: [{id: 'b1', name: '', personal: true, role: 'owner'}],
    resets: {
      resets: {codex: {scheduled: null, watch: null, latest: null, policy: null, credit: {name: 'Codex Resets', url: 'https://x'}}},
      trackers: [{name: 'Codex Resets', url: 'https://x', ok: true, detail: 'ok', at: 1}],
      past: {},
    },
    ...change,
  };
}

const hub = (event: HubEvent): PageEvent => ({type: 'hub', event});
const run = (...events: PageEvent[]) => events.reduce(reduce, INITIAL);
/** Every slice of the state, to compare what stayed the same object. */
const slices = (s: PageState) => ({
  meta: s.board!.meta,
  view: s.board!.view,
  lineup: s.board!.lineup,
  s1: s.board!.cards.s1,
  s2: s.board!.cards.s2,
  sessions1: s.board!.sessions.s1,
  sessions2: s.board!.sessions.s2,
  cadence1: s.board!.cadence.s1,
  forecast1: s.board!.forecast.s1,
  forecast2: s.board!.forecast.s2,
  mine: s.board!.mine,
  boards: s.boards,
  resets: s.resets!.resets,
  past: s.resets!.past,
});

function same(before: PageState, after: PageState, but: string[] = []) {
  const [a, b] = [slices(before), slices(after)];
  for (const key of Object.keys(a) as (keyof typeof a)[]) {
    if (but.includes(key)) assert.notEqual(b[key], a[key], `${key} changed`);
    else assert.equal(b[key], a[key], `${key} is the same object`);
  }
}

test('a snapshot is the board; the same snapshot again keeps every slice as it was, when the trackers were asked too', () => {
  const first = run(hub({type: 'snapshot', data: snapshot()}));
  assert.deepEqual(first.board!.lineup, ['s1', 's2']);
  assert.equal(first.board!.cards.s2.id, 's2');
  const again = reduce(
    first,
    hub({type: 'snapshot', data: JSON.parse(JSON.stringify({...snapshot(), resets: {...snapshot().resets, trackers: [{...snapshot().resets.trackers[0], at: 2}]}}))}),
  );
  same(first, again);
  assert.equal(again.board, first.board);
  assert.equal(again.resets!.trackers[0].at, 2, 'when they were asked is taken');
  const changed = reduce(first, hub({type: 'snapshot', data: snapshot({sources: [card('s1'), card('s2', 60)]})}));
  same(first, changed, ['s2']);
});

test('each event changes its own slice and leaves the others as they were', () => {
  const s = run(hub({type: 'snapshot', data: snapshot()}));
  same(s, reduce(s, hub({type: 'card', data: card('s1', 70)})), ['s1']);
  assert.equal(reduce(s, hub({type: 'card', data: card('s1')})), s, 'a card the same as before changes nothing');
  same(s, reduce(s, hub({type: 'sessions', data: {id: 's2', sessions: [session]}})), ['sessions2']);
  same(s, reduce(s, hub({type: 'cadence', data: {id: 's1', cadence: null}})), ['cadence1']);
  same(s, reduce(s, hub({type: 'forecast', data: {id: 's2', forecast: {weekly: ahead(30)}}})), ['forecast2']);
  assert.equal(reduce(s, hub({type: 'forecast', data: {id: 's1', forecast: {weekly: ahead(20)}}})), s, 'a forecast the same as before changes nothing');
  same(s, reduce(s, hub({type: 'view', data: {view: {...VIEW, order: ['history']}}})), ['view']);
  same(s, reduce(s, hub({type: 'board', data: {board: {id: 'b1', name: 'Mine', personal: true}}})), ['meta']);
  same(s, reduce(s, hub({type: 'mine', data: {sources: ['s1']}})), ['mine']);
  same(s, reduce(s, hub({type: 'boards', data: {boards: [...snapshot().boards, {id: 'b2', name: 'Team', personal: false, role: 'member'}]}})), ['boards']);
  const resets = reduce(s, hub({type: 'resets', data: {...snapshot().resets, trackers: []}}));
  same(s, resets);
  assert.deepEqual(resets.resets!.trackers, []);
  assert.equal(reduce(s, hub({type: 'history', data: {sources: ['s1'], since: 0}})), s);
});

test('a lineup without a source drops what was kept of it; one new to the board comes with its card first', () => {
  const s = run(hub({type: 'snapshot', data: snapshot()}));
  const without = reduce(s, hub({type: 'lineup', data: {sources: ['s1']}}));
  assert.deepEqual(
    [Object.keys(without.board!.cards), Object.keys(without.board!.sessions), Object.keys(without.board!.cadence), Object.keys(without.board!.forecast)],
    [['s1'], ['s1'], ['s1'], ['s1']],
  );
  assert.equal(without.board!.cards.s1, s.board!.cards.s1);
  const back = [
    hub({type: 'card', data: card('s3')}),
    hub({type: 'sessions', data: {id: 's3', sessions: []}}),
    hub({type: 'cadence', data: {id: 's3', cadence: null}}),
    hub({type: 'forecast', data: {id: 's3', forecast: {}}}),
    hub({type: 'lineup', data: {sources: ['s1', 's3']}}),
  ].reduce(reduce, without);
  assert.deepEqual(back.board!.lineup, ['s1', 's3']);
  assert.equal(back.board!.cards.s3.id, 's3');
});

test('the list of boards: every session replaces it, a board made is added, one gone is taken out, the open one with it', () => {
  const b = (id: string, personal = false) => ({id, name: id, personal, role: 'owner' as const});
  let s = run({type: 'board-created', board: b('t')});
  assert.deepEqual(s.boards, [b('t')], 'made before any session: the list is that one');
  s = reduce(s, {type: 'session-boards', boards: [b('p', true), b('t')]});
  assert.deepEqual(
    s.boards?.map(x => x.id),
    ['p', 't'],
  );
  const same = reduce(s, {type: 'session-boards', boards: [b('p', true), b('t')]});
  assert.equal(same, s, 'the same list changes nothing');
  s = reduce(s, {type: 'board-created', board: b('u')});
  assert.equal(reduce(s, {type: 'board-created', board: b('u')}), s, 'made twice is there once');
  s = reduce(s, hub({type: 'snapshot', data: snapshot({board: {id: 't', name: 't', personal: false}, boards: s.boards!})}));
  s = reduce(s, {type: 'board-gone', id: 't'});
  assert.deepEqual([s.boards?.map(x => x.id), s.board], [['p', 'u'], null]);
  s = reduce(s, {type: 'board-open', id: 'p'});
  assert.equal(s.board, null);
});

test("the app's state is taken only when newer than the one there", () => {
  const app = (seq: number) => ({
    agent: {state: 'idle' as const},
    providers: [],
    sessions: true,
    autostart: false,
    configPath: '',
    logPath: '',
    version: '',
    commit: '',
    seq,
  });
  const s = run({type: 'app', state: app(5)}, {type: 'app', state: app(3)}, {type: 'app', state: app(5)});
  assert.equal(s.app?.seq, 5);
  assert.equal(reduce(s, {type: 'app', state: app(6)}).app?.seq, 6);
});

test('a reader of one slice reads the same object when another slice changes; a list of several stays while each does', () => {
  const store = createStore(reduce, INITIAL);
  store.dispatch(hub({type: 'snapshot', data: snapshot()}));
  let notified = 0;
  store.subscribe(() => notified++);
  const ofS1 = selector(store, () => ({select: (s: PageState) => s.board?.cards.s1, equal: Object.is}));
  const sessionsOf = selector(store, () => ({select: (s: PageState) => ['s1', 's2'].map(id => s.board?.sessions[id]), equal: shallowEqual}));
  const [s1, lists] = [ofS1(), sessionsOf()];
  store.dispatch(hub({type: 'card', data: card('s2', 90)}));
  assert.equal(notified, 1);
  assert.equal(ofS1(), s1);
  assert.equal(sessionsOf(), lists, 'agents did not change');
  store.dispatch(hub({type: 'sessions', data: {id: 's2', sessions: [session]}}));
  assert.notEqual(sessionsOf(), lists);
  store.dispatch(hub({type: 'card', data: card('s2', 90)}));
  assert.equal(notified, 2, 'a card the same as before changes nothing, and notifies nobody');
  const heard: string[] = [];
  store.listen(event => heard.push(event.type === 'hub' ? event.event.type : event.type));
  store.dispatch(hub({type: 'history', data: {sources: ['s1'], since: 0}}));
  assert.deepEqual(heard, ['history'], 'services hear events that change no state');
});

test('the names of the cards stay the same object while no name changes', () => {
  const s = run(hub({type: 'snapshot', data: snapshot()}));
  const titles = titlesOf(s.board);
  assert.deepEqual(titles.s1, {title: 'Codex', provider: 'codex'});
  assert.equal(titles.s2.title, 'Codex 2');
  assert.equal(titlesOf(reduce(s, hub({type: 'card', data: card('s1', 10)})).board), titles, 'numbers changed, not names');
  const named = reduce(s, hub({type: 'view', data: {view: {...VIEW, names: {s2: 'Work'}}}}));
  assert.equal(titlesOf(named.board).s2.title, 'Work');
  assert.equal(titlesOf(s.board, {s1: 'Home'}).s1.title, 'Home', 'as the owner names it on screen, before the hub saved it');
  // Read side by side by the saved view and by the owner's changes: each stays the same object.
  const saved = titlesOf(s.board);
  const drafted = titlesOf(s.board, {s1: 'Home'});
  for (let i = 0; i < 3; i++) assert.deepEqual([titlesOf(s.board) === saved, titlesOf(s.board, {s1: 'Home'}) === drafted], [true, true]);
  // Another card on the board, or another owner of one: named anew.
  const more = run(hub({type: 'snapshot', data: snapshot()}), hub({type: 'card', data: card('s3')}), hub({type: 'lineup', data: {sources: ['s1', 's2', 's3']}}));
  assert.deepEqual(
    Object.values(titlesOf(more.board)).map(t => t.title),
    ['Codex', 'Codex 2', 'Codex 3'],
  );
  const shared = reduce(s, hub({type: 'card', data: card('s2', 50, {owners: ['Bob']})}));
  assert.deepEqual(
    Object.values(titlesOf(shared.board)).map(t => t.title),
    ['Codex · Ana', 'Codex · Bob'],
  );
});

test('a board is shown only as the one opened: another still in the store is nothing, and closing keeps nothing of it', () => {
  const s = run(hub({type: 'snapshot', data: snapshot()}), {type: 'connection', status: 'retrying', lostAt: 5});
  assert.equal(metaOf(s, 'b1')?.id, 'b1');
  assert.equal(metaOf(s, 'b2'), null, 'the next board opens: the last one is not drawn under its name');
  const closed = reduce(s, {type: 'board-close'});
  assert.deepEqual([closed.board, closed.connection], [null, INITIAL.connection]);
  assert.equal(closed.boards, s.boards, 'the list of boards is the session’s');
});

test("the trackers' news keeps each provider's the same object while it says the same", () => {
  const claude = {scheduled: null, watch: null, latest: null, policy: null, credit: {name: 'Claude Resets', url: 'https://y'}};
  const both = {...snapshot().resets, resets: {...snapshot().resets.resets, claude}};
  const s = run(hub({type: 'snapshot', data: snapshot({resets: both})}));
  const news = {...both, resets: {...both.resets, codex: {...both.resets.codex!, latest: {at: 5, url: 'https://x/1', text: 'reset'}}}};
  const next = reduce(s, hub({type: 'resets', data: JSON.parse(JSON.stringify(news))}));
  assert.notEqual(next.resets!.resets.codex, s.resets!.resets.codex);
  assert.equal(next.resets!.resets.claude, s.resets!.resets.claude, 'the cards of the other provider read the same');
});

test('refresh is an independent slice, restored by snapshots and removed with its card', () => {
  const before = run(hub({type: 'snapshot', data: snapshot()}));
  const refresh = {unavailable: null, availableAt: null, retryAt: 70_000, request: {
    requestedAt: 10_000, notBefore: 60_000, dispatchAt: null, deadline: 360_000, status: 'queued' as const, finishedAt: null,
  }};
  const after = reduce(before, hub({type: 'refresh', data: {id: 's1', refresh}}));
  same(before, after);
  assert.notEqual(before.board!.refresh.s1, after.board!.refresh.s1);
  assert.equal(reduce(after, hub({type: 'refresh', data: {id: 's1', refresh}})), after);
  const reconnected = reduce(after, hub({type: 'snapshot', data: snapshot({refresh: {s1: refresh}})}));
  assert.equal(reconnected.board, after.board);
  const gone = reduce(after, hub({type: 'lineup', data: {sources: ['s2']}}));
  assert.equal(gone.board!.refresh.s1, undefined);
  assert.equal(reduce(after, {type: 'board-open', id: 'another'}).board, null);
});
