import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Ingest, type Credential} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {newSecret} from '../domain/auth.js';
import {parseSessions} from '../domain/ingest.js';
import {CREDIT_MS, KEEP_MS} from '../sessions.js';

// Generated through Activity.observe, Runner.running and HubSink's local HTTP transport.
// The Rust acceptance test compares its current output with this same fixture.
const fixture = JSON.parse(readFileSync(new URL('../../../agent/crates/core/tests/fixtures/shared-runtime-report.json', import.meta.url), 'utf8')) as {
  version: number; agent: string; machine: {id: string; name: string; os: string; arch: string};
  sentAt: string; sessions: Record<string, unknown>[];
};
const start = Date.parse(fixture.sentAt);
const iso = (at: number) => new Date(at).toISOString();

for (const stable of [false, true]) {
  test(`collector full reports stop future false project credit (${stable ? 'stable' : 'legacy'} identity)`, () => {
    const store = new Store(':memory:', start);
    try {
      const directory = new Directory(store.db);
      const ingest = new Ingest(store, directory, new Duty(), new Cadence());
      const user = directory.createUser('fixture@example.com', 'Fixture', 'x', start);
      const secret = newSecret('qt_m');
      directory.createToken(secret, '…', user.id, 'fixture', start);
      const token = ingest.authenticate(`Bearer ${secret}`) as Credential;
      const header = {...fixture, sessions: undefined};
      ingest.accept(token, {...header, snapshots: [{provider: 'codex', account: fixture.sessions[0].account,
        observedAt: iso(start), via: 'codex/app-server', staleAfterMs: 204_000, windows: [{id: 'weekly', kind: 'weekly',
          minutes: 10080, usedPercent: 5, resetsAt: iso(start + 86_400_000)}]}], failures: []}, start);
      const sessions: Record<string, unknown>[] = fixture.sessions.map((s, i) => stable ? {...s, sessionId: (i + 1).toString().repeat(32)} : {...s});
      const parsed = parseSessions({...fixture, sessions});
      assert.equal(parsed.sessions.filter(s => s.working).length, 1);
      assert.equal(parsed.sessions.find(s => s.working)?.project, null);
      const report = (at: number, list = sessions) => ingest.sessions(token, {...fixture, sentAt: iso(at), sessions: list}, at);
      // A previous bad producer is allowed its last credit up to the first corrected list.
      const old = sessions.filter(s => s.project === 'project-a').map(s => ({...s, working: true}));
      assert.equal(report(start - 15_000, old).accepted, 1);
      assert.equal(report(start).accepted, 3);
      const before = store.agentWork(start - 15_000, start);
      assert.ok(before.some(s => s.project === 'project-a' && s.to === start));
      report(start + 15_000);
      report(start + 15_000);
      report(start + 120_000);
      ingest.live.sweep(start + 120_000 + CREDIT_MS + KEEP_MS + 1);
      const after = store.agentWork(start, start + 1_000_000);
      assert.ok(after.some(s => s.project === null), 'unplaced runtime work remains visible');
      assert.ok(after.every(s => s.project !== 'project-a' && s.project !== 'project-b'), 'no guessed project credit');
      assert.deepEqual(store.agentWork(start - 15_000, start), before, 'earlier history is preserved');
      report(start + 1_000_000, []);
      ingest.live.sweep(start + 2_000_000);
      assert.deepEqual(store.agentWork(start + 1_000_000, start + 2_000_000), [], 'empty full list stops credit');
      report(start + 2_000_000, old);
      report(start + 2_015_000, []);
      assert.ok(store.agentWork(start + 2_000_000, start + 2_015_000).some(s => s.project === 'project-a'));
    } finally { store.close(); }
  });
}
