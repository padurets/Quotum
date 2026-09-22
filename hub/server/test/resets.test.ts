import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fromClaudeResets, fromCodexResets} from '../domain/resets.js';
import {describeFailure} from '../resets.js';

const now = Date.parse('2026-09-22T15:00:00Z');
const status = (data: object) => ({
  data: {latest_reset: null, scheduled_reset: null, active_watch: null, stats: {total: 0, last_reset_at: null, days_since_last: null, avg_interval_days: null}, ...data},
  meta: {api_version: 'v1', generated_at: '2026-09-22T15:00:00Z'},
});

test('Codex Resets status maps to scheduled / watch / latest, and untrusted links are replaced', () => {
  const parsed = fromCodexResets(
    status({
      latest_reset: {id: '1', reset_type: 'regular', announced_at: '2026-09-12T08:09:39Z', text: 'Reset all propagated. https://t.co/x', source: {type: 'x_post', author: 'codex_team', url: 'https://x.com/i/status/1'}},
      scheduled_reset: {id: '2', status: 'scheduled', reset_type: 'banked', announced_at: '2026-09-22T04:40:11Z', scheduled_for: '2026-09-23T07:00:00Z', text: 'See you soon.', source: {type: 'x_post', author: 'codex_team', url: 'javascript:alert(1)'}},
    }),
    now,
  );
  assert.deepEqual([parsed.scheduled?.kind, parsed.scheduled?.scheduledFor, parsed.scheduled?.url], ['banked', Date.parse('2026-09-23T07:00:00Z'), 'https://codex-resets.com/']);
  assert.deepEqual([parsed.latest?.url, parsed.latest?.text], ['https://x.com/i/status/1', 'Reset all propagated.']);
  assert.equal(parsed.credit.name, 'Codex Resets');
});

test('an expired watch is dropped; anything but the v1 shape is refused', () => {
  const watch = (expires: string) =>
    status({active_watch: {level: 'strong', reset_chance_percent: 70, forecast_window: 'this week', observed_at: '2026-09-20T10:00:00Z', expires_at: expires, text: 'soon', source: {type: 'observed'}}});
  assert.equal(fromCodexResets(watch('2026-09-25T00:00:00Z'), now).watch?.chance, 70);
  assert.equal(fromCodexResets(watch('2026-09-21T00:00:00Z'), now).watch, null);
  assert.throws(() => fromCodexResets({data: {}}, now), /invalid_reset_status/);
  assert.throws(() => fromCodexResets('<html>Just a moment…</html>', now), /invalid_reset_status/);
});

test('the claude-resets catalogue yields the latest reset and policy change per provider', () => {
  const catalogue = {
    providers: {
      claude: {
        events: [
          {id: '1', date: '2026-09-01T18:35:27Z', kind: 'reset', scope: 'all', note: 'Reset for all.', url: 'https://x.com/claude_updates/status/1'},
          {id: '2', date: '2026-09-04T20:08:45Z', kind: 'reset', scope: 'Max', note: 'Max weekly reset.', url: 'https://x.com/claude_team/status/2'},
          {id: '3', date: '2026-08-29T16:47:23Z', kind: 'policy', note: 'Weekly limit +25%.', url: 'https://x.com/claude_updates/status/3'},
        ],
      },
      codex: {events: [{id: '4', date: '2026-09-12T08:09:17Z', kind: 'reset', note: 'Reset all propagated.', url: 'https://x.com/codex_team/status/4'}]},
    },
    meta: {},
  };
  const claude = fromClaudeResets(catalogue, 'claude');
  assert.deepEqual([claude.latest?.at, claude.latest?.scope, claude.policy?.text], [Date.parse('2026-09-04T20:08:45Z'), 'Max', 'Weekly limit +25%.']);
  assert.equal(claude.scheduled, null);
  assert.equal(claude.credit.name, 'claude-resets.com');
  assert.equal(fromClaudeResets(catalogue, 'codex').credit.name, 'Codex Resets', 'the Codex catalogue originates from Codex Resets');
  assert.throws(() => fromClaudeResets({}, 'claude'), /invalid_reset_catalogue/);
});

test('tracker failures are described in terms the owner can act on', () => {
  assert.equal(describeFailure(new Error('challenge')), 'challenge');
  assert.equal(describeFailure(new Error('HTTP 503')), 'HTTP 503');
  assert.equal(describeFailure(new Error('invalid_reset_status')), 'format');
});
