import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store/store.js';
import {Ingest} from '../ingest.js';
import {parseBatch, windowLabel} from '../domain/ingest.js';
import {bucketize, edge, series, type Sample} from '../domain/quota.js';

const start = Date.parse('2026-09-22T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const TOKEN = 'test-token-0123456789abcdef';

const snapshot = (at: number, used: number, change: Record<string, unknown> = {}) => ({
  provider: 'codex',
  account: 'a1b2c3d4e5f6a1b2c3d4e5f6',
  plan: 'pro',
  observedAt: iso(at),
  via: 'codex/app-server',
  client: '0.154.0',
  staleAfterMs: 204_000,
  windows: [{id: 'weekly', kind: 'weekly', minutes: 10080, usedPercent: used, resetsAt: iso(start + 5 * 86_400_000)}],
  ...change,
});

const batch = (snapshots: unknown[], failures: unknown[] = [], machine = 'machine-one-0123456789') => ({
  version: 1,
  agent: 'agent-limits/0.1.0',
  machine: {id: machine, name: 'workstation', os: 'linux', arch: 'x86_64'},
  sentAt: iso(start),
  snapshots,
  failures,
});

const fresh = () => new Store(path.join(mkdtempSync(path.join(tmpdir(), 'agent-limits-ingest-')), 'db.sqlite'), start);

test('only configured bearer tokens are accepted', () => {
  const ingest = new Ingest(fresh(), [TOKEN], true);
  assert.equal(ingest.authorized(`Bearer ${TOKEN}`), true);
  assert.equal(ingest.authorized(`Bearer ${TOKEN}x`), false);
  assert.equal(ingest.authorized(TOKEN), false);
  assert.equal(ingest.authorized(undefined), false);
});

test('a malformed batch is refused whole', () => {
  assert.throws(() => parseBatch({...batch([snapshot(start, 5)]), version: 2}), /invalid_batch: version/);
  assert.throws(() => parseBatch(batch([snapshot(start, 120)])), /usedPercent/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {provider: 'cursor'})])), /provider/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {staleAfterMs: 0})])), /staleAfterMs/);
  assert.equal(parseBatch(batch([snapshot(start, 5)])).snapshots[0].windows[0].resetsAt, start + 5 * 86_400_000);
});

test('windows get dashboard labels', () => {
  const w = {id: 'x', minutes: 10080, usedPercent: 0, resetsAt: null};
  assert.equal(windowLabel({...w, kind: 'weekly', label: null}), 'Неделя');
  assert.equal(windowLabel({...w, kind: 'weekly', label: 'Fable'}), 'Fable · Неделя');
  assert.equal(windowLabel({...w, kind: 'session', minutes: 300, label: 'Gemini'}), 'Gemini · 5 часов');
  assert.equal(windowLabel({...w, kind: 'other', minutes: 60, label: null}), '60 мин');
});

test('the first account of a provider takes its default source; others get their own', () => {
  const store = fresh();
  const ingest = new Ingest(store, [TOKEN], true);
  assert.deepEqual(ingest.accept(batch([snapshot(start, 5), snapshot(start, 7, {account: 'ffffeeeeddddccccbbbbaaaa'})]), start), {
    accepted: 2,
    duplicates: 0,
    failures: 0,
  });
  const ids = store.states().filter(s => s.provider === 'codex').map(s => [s.id, s.windows[0]?.used]);
  assert.deepEqual(ids, [['codex', 5], ['codex:ffffeeee', 7]]);
  // With a collector writing the default sources, agents never take them.
  const shared = fresh();
  new Ingest(shared, [TOKEN], false).accept(batch([snapshot(start, 5)]), start);
  assert.equal(shared.state('codex:a1b2c3d4').windows[0].used, 5);
});

test('resent and older measurements are duplicates, not errors', () => {
  const store = fresh();
  const ingest = new Ingest(store, [TOKEN], true);
  ingest.accept(batch([snapshot(start + 120_000, 6)]), start + 120_000);
  const again = ingest.accept(batch([snapshot(start, 5), snapshot(start + 120_000, 6)]), start + 130_000);
  assert.deepEqual(again, {accepted: 0, duplicates: 2, failures: 0});
  assert.equal(store.state('codex').error, null);
});

test('a machine failure shows only once its source has gone quiet', () => {
  const store = fresh();
  const ingest = new Ingest(store, [TOKEN], true);
  ingest.accept(batch([snapshot(start, 5)]), start);
  const failure = (at: number) => ({provider: 'codex', observedAt: iso(at), error: 'not_logged_in', detail: 'run codex login'});
  assert.equal(ingest.accept(batch([], [failure(start + 60_000)]), start + 60_000).failures, 0);
  assert.equal(ingest.accept(batch([], [failure(start + 600_000)]), start + 600_000).failures, 1);
  assert.equal(store.state('codex').error, 'agent_not_logged_in');
  // Failures from a machine that never delivered this provider are ignored.
  assert.equal(ingest.accept(batch([], [failure(start + 600_000)], 'machine-two-0123456789'), start + 600_000).failures, 0);
});

test('an agent-declared staleness keeps sparse measurements continuous', () => {
  const sample = (at: number, used: number, staleAfterMs: number | null): Sample => ({
    sourceId: 'codex',
    provider: 'codex',
    scope: 'a',
    id: 'weekly',
    label: 'Неделя',
    used,
    remaining: 100 - used,
    resetAt: start + 5 * 86_400_000,
    minutes: 10080,
    sourceAt: at,
    observedAt: at,
    staleAfterMs,
  });
  // Eco mode: 15 minutes between measurements, announced by the agent.
  const eco = [sample(start, 10, 1_080_000), sample(start + 900_000, 12, 1_080_000)];
  assert.deepEqual(edge(eco[0], eco[1]), {valid: true, delta: 2, reason: 'continuous'});
  assert.equal(series(eco).consumed, 2);
  assert.deepEqual(bucketize(series(eco).points, 300_000).map(p => p.segment), [0, 0]);
  // Without the announcement the default 5.5 minutes apply: a gap.
  const legacy = [sample(start, 10, null), sample(start + 900_000, 12, null)];
  assert.equal(edge(legacy[0], legacy[1]).reason, 'gap');
  assert.deepEqual(bucketize(series(legacy).points, 300_000).map(p => p.segment), [0, 1]);
});

test('stored agent samples carry their staleness into history', () => {
  const store = fresh();
  const ingest = new Ingest(store, [TOKEN], true);
  ingest.accept(batch([snapshot(start, 10, {staleAfterMs: 1_080_000})]), start);
  ingest.accept(batch([snapshot(start + 900_000, 12, {staleAfterMs: 1_080_000})]), start + 900_000);
  const history = store.history(start - 1, 300_000).find(s => s.sourceId === 'codex')!;
  assert.equal(history.consumed, 2);
  assert.deepEqual(history.points.map(p => p[2]), [0, 0]);
});
