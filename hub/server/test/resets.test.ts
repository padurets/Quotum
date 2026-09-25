import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {fromClaudeResets, fromCodexResets} from '../domain/resets.js';
import {describeFailure, ResetFeed} from '../resets.js';
import {config, trackerUrl} from '../config.js';

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

test('the Claude Resets catalogue yields the latest reset and policy change per provider', () => {
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
  assert.equal(claude.credit.name, 'Claude Resets');
  assert.equal(fromClaudeResets(catalogue, 'codex').credit.name, 'Codex Resets', 'the Codex catalogue originates from Codex Resets');
  assert.throws(() => fromClaudeResets({}, 'claude'), /invalid_reset_catalogue/);
});

test('tracker failures are described in terms the owner can act on', () => {
  assert.equal(describeFailure(new Error('challenge')), 'challenge');
  assert.equal(describeFailure(new Error('HTTP 503')), 'HTTP 503');
  assert.equal(describeFailure(new Error('invalid_reset_status')), 'format');
});

test('the trackers are read where the owner says, their own APIs by default', () => {
  assert.equal(config.resets.codexApi, 'https://codex-resets.com/api/v1/status');
  assert.equal(config.resets.claudeApi, 'https://claude-resets.com/api/resets');
  assert.equal(trackerUrl('QUOTUM_RESETS_CODEX_URL', undefined, 'https://codex-resets.com/api/v1/status'), 'https://codex-resets.com/api/v1/status');
  assert.equal(trackerUrl('QUOTUM_RESETS_CODEX_URL', 'http://mirror.lan:8090/codex/status?v=1', 'x'), 'http://mirror.lan:8090/codex/status?v=1');
  // The value may carry a secret: no error repeats it.
  const refused = (variable: string) => (error: Error) => error.message.includes(variable) && !error.message.includes('s3cret');
  assert.throws(() => trackerUrl('QUOTUM_RESETS_CODEX_URL', 'mirror.lan/codex?key=s3cret', 'x'), refused('QUOTUM_RESETS_CODEX_URL'));
  assert.throws(() => trackerUrl('QUOTUM_RESETS_CLAUDE_URL', 'ftp://mirror.lan/claude?key=s3cret', 'x'), refused('QUOTUM_RESETS_CLAUDE_URL'));
  assert.throws(
    () => trackerUrl('QUOTUM_RESETS_CLAUDE_URL', 'https://reader:s3cret@mirror.lan/claude', 'x'),
    (error: Error) => /QUOTUM_RESETS_CLAUDE_URL must not contain a user name or password/.test(error.message) && !error.message.includes('s3cret'),
    'an address with credentials would never be read, and the error does not repeat it',
  );
});

test('a round reads the addresses it is given and reports how each tracker did', async () => {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url!);
    if (request.url === '/codex') {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify(status({latest_reset: {announced_at: '2026-09-22T10:00:00Z', text: 'Reset for all.', source: {url: 'https://x.com/i/status/9'}}})));
    } else {
      response.writeHead(503).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const remembered: string[] = [];
  const logged: object[] = [];
  const feed = new ResetFeed((provider, reset) => remembered.push(`${provider} ${reset.at}`), event => logged.push(event), {
    enabled: true,
    codexApi: `${base}/codex`,
    claudeApi: `${base}/claude?key=s3cret`,
    timeoutMs: 2_000,
  });
  await feed.round();
  server.close();

  const {resets, trackers} = feed.snapshot();
  assert.deepEqual(asked.sort(), ['/claude?key=s3cret', '/codex']);
  assert.equal(resets.codex?.latest?.text, 'Reset for all.');
  assert.equal(resets.claude, undefined);
  assert.deepEqual(remembered, [`codex ${Date.parse('2026-09-22T10:00:00Z')}`]);
  assert.deepEqual(
    trackers.map(t => [t.name, t.url, t.ok, t.detail]),
    [
      ['Codex Resets', 'https://codex-resets.com/', true, 'ok'],
      ['Claude Resets', 'https://claude-resets.com/', false, 'HTTP 503'],
    ],
    'credited as always, wherever they are read',
  );
  assert.deepEqual((logged[0] as {failures: object[]}).failures, [{url: `${base}/claude`, detail: 'HTTP 503'}], 'the log names the address that failed, without its query');
});
