import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SETS} from '../../demo/catalogue.js';
import {cards, MIN, snapshot, sourceOf, staleAfter} from '../../demo/model.js';
import {STILL_FOR} from '../../demo/setup.js';
import {Cadence} from '../../server/cadence.js';
import {config} from '../../server/config.js';
import {Duty} from '../../server/duty.js';
import {Events, type Clock, type Frame} from '../../server/events.js';
import {Ingest} from '../../server/ingest.js';
import {Projection} from '../../server/projection.js';
import {ResetFeed} from '../../server/resets.js';
import {Directory} from '../../server/store/directory.js';
import {Store} from '../../server/store/store.js';
import {INITIAL, reduce, type PageEvent} from '../../ui/lib/board.js';
import {createStore, selector} from '../../ui/lib/store.js';
import {stillProblems, stillSnapshot} from '../still.js';

/** Runs the production event deadlines without sleeping or depending on a browser. */
class ManualClock implements Clock {
  private timers: {at: number; run: () => void}[] = [];
  constructor(public t: number) {}
  now() {return this.t;}
  after(ms: number, run: () => void) {
    const timer = {at: this.t + ms, run};
    this.timers.push(timer);
    return () => void (this.timers = this.timers.filter(t => t !== timer));
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter(t => t !== next);
      this.t = Math.max(this.t, next.at);
      next.run();
    }
    this.t = end;
  }
}

test('benchmark quota measurements stay fresh in later phases through the old seven-minute deadline', () => {
  const start = Date.parse('2026-10-09T00:26:19Z'), observedAt = start + 9 * MIN;
  const card = cards(SETS[0]).find(card => card.id === 'antigravity')!;
  const old = snapshot(card, start, observedAt - start, 5 * MIN);
  const current = stillSnapshot(card, start, observedAt);
  assert.deepEqual({...current, staleAfterMs: old.staleAfterMs}, old, 'only freshness changes: timestamps, resets and windows retain their facts');
  assert.equal(observedAt + current.staleAfterMs, start + STILL_FOR, 'the seeded stand and later samples share the same deadline');

  for (const [wire, shouldExpire] of [[old, true], [current, false]] as const) {
    const clock = new ManualClock(observedAt), store = new Store(':memory:', start), directory = new Directory(store.db);
    const user = directory.createUser('bench@example.com', 'Bench', 'fixture', start), board = directory.boards(user.id)[0].id;
    const token = directory.createToken('qt_m_bench', 'bench', user.id, 'Bench machine', start);
    const ingest = new Ingest(store, directory, new Duty(), new Cadence());
    const parts = {store, directory, ingest, resets: new ResetFeed(undefined, () => {}, {...config.resets, enabled: false})};
    const events = new Events(parts, {...config.events, recheckMs: 0, heartbeatMs: 0}, clock, null);
    events.attach();
    try {
      const accepted = ingest.accept({kind: 'token', token}, {
        version: 1, agent: 'quotum-demo/1', machine: {id: 'bench-machine-0123456789', name: 'Bench', os: 'linux', arch: 'x86_64'},
        sentAt: new Date(observedAt).toISOString(), snapshots: [wire], failures: [],
      }, observedAt);
      assert.equal(accepted.accepted, 1);
      const source = sourceOf(card, user.id), recorded = store.state(source);
      assert.equal(recorded.successAt, observedAt);
      assert.equal(recorded.staleAfterMs, wire.staleAfterMs);
      // Native/history phases can take this long after the last quota write. No quota is written here.
      clock.advance(staleAfter(5 * MIN) - 10_000);
      directory.createSession('bench-reader', user.id, clock.now(), STILL_FOR);
      const projection = new Projection(parts), overview = projection.snapshot(user.id, board, clock.now())!;
      const page = createStore(reduce, reduce(INITIAL, {type: 'hub', event: {type: 'snapshot', data: overview}}));
      const read = selector(page, () => ({select: state => state.board!.cards[source], equal: Object.is}));
      const before = read(), frames: Frame[] = [];
      assert.equal(before.stale, false);
      events.open({user: user.id, secret: 'bench-reader', board, kind: 'stream', end: () => {}, send: batch => {
        frames.push(...batch);
        for (const frame of batch) if (frame.type === 'card') page.dispatch({type: 'hub', event: {type: 'card', data: JSON.parse(frame.data)}} as PageEvent);
      }});
      frames.length = 0;
      const from = clock.now(), to = from + 20_000;
      const problems = stillProblems(overview.sources.map(card => ({...card, forecast: overview.forecast[card.id]})), from, to);
      assert.deepEqual(problems, shouldExpire ? [source + ' goes stale'] : [], 'no forecast or reset contaminates this window');
      clock.advance(to - from);
      const updates = frames.filter(frame => frame.type === 'card');
      assert.equal(updates.length, shouldExpire ? 1 : 0, 'only the old fixture emits an unrelated card update in the later phase');
      assert.equal(read() === before, !shouldExpire, 'the real card selector remains stable only for the still fixture');
      assert.equal(read().stale, shouldExpire);
      assert.deepEqual(store.state(source), recorded, 'the time boundary has no source writes');
    } finally {
      events.close();
      store.close();
    }
  }
});
