import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resetLabel, type ResetStatus} from '../lib/resets';
import {countdown} from '../lib/format';
import {setLocale} from '../i18n';

const NOW = Date.UTC(2026, 8, 25, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;
const TRACKER = 'https://codex-resets.example/';

const status = (parts: Partial<ResetStatus>): ResetStatus => ({
  scheduled: null,
  watch: null,
  latest: null,
  policy: null,
  credit: {name: 'Codex Resets', url: TRACKER},
  ...parts,
});
const event = (at: number, url = TRACKER) => ({url, text: 'news', at});
const scheduled = (scheduledFor: number | null, kind: 'regular' | 'banked' | null = 'regular') => ({...event(NOW - HOUR), scheduledFor, kind});
const watch = (expiresAt: number | null, chance: number | null = 40) => ({...event(NOW - HOUR), expiresAt, chance, window: 'next 24 hours'});
const latest = (ago: number, scope = 'Max') => ({...event(NOW - ago), scope});
const policy = (ago: number) => event(NOW - ago);

const key = (parts: Partial<ResetStatus>) => resetLabel(status(parts), NOW)?.key ?? null;

test('no answer from the service, or nothing recent, is no mark', () => {
  assert.equal(resetLabel(undefined, NOW), null);
  assert.equal(key({}), null);
});

test('an announced reset: its time ahead, banked, without a time, or past and waiting', () => {
  assert.deepEqual(resetLabel(status({scheduled: scheduled(NOW + 47 * HOUR)}), NOW), {
    event: scheduled(NOW + 47 * HOUR),
    link: null,
    key: 'in',
    tone: 'accent',
    at: NOW + 47 * HOUR,
  });
  assert.equal(key({scheduled: scheduled(NOW + HOUR, 'banked')}), 'bankedIn');
  assert.equal(key({scheduled: scheduled(NOW + HOUR, null)}), 'in', 'a reset of no kind is a regular one');
  assert.equal(key({scheduled: scheduled(null)}), 'announced');
  assert.equal(key({scheduled: scheduled(NOW)}), 'awaiting', 'its time has come');
  assert.equal(key({scheduled: scheduled(NOW - HOUR, 'banked')}), 'awaiting', 'a banked one waits too');
  for (const at of [NOW + HOUR, null, NOW - HOUR]) assert.equal(resetLabel(status({scheduled: scheduled(at)}), NOW)?.tone, 'accent');
});

test('a possible reset is quiet, with its chance and its end when the tracker gives them', () => {
  assert.deepEqual(resetLabel(status({watch: watch(NOW + 20 * HOUR)}), NOW), {
    event: watch(NOW + 20 * HOUR),
    link: null,
    key: 'possible',
    tone: 'quiet',
    at: NOW + 20 * HOUR,
    chance: 40,
  });
  const open = resetLabel(status({watch: watch(null, null)}), NOW);
  assert.equal(open?.key === 'possible' && open.chance, null);
  assert.equal(open?.key === 'possible' && open.at, null);
});

test('a watch that has run out is no news: the next thing in line is told', () => {
  assert.equal(key({watch: watch(NOW - 1)}), null);
  assert.equal(key({watch: watch(NOW)}), null, 'it ends at its time');
  assert.equal(key({watch: watch(NOW + 1)}), 'possible');
  assert.equal(key({watch: watch(NOW - HOUR), latest: latest(HOUR)}), 'done');
});

test('a reset that just happened names its scope, unless it was for everyone', () => {
  const done = (scope: string) => {
    const label = resetLabel(status({latest: latest(HOUR, scope)}), NOW);
    return label?.key === 'done' ? [label.scope, label.tone] : null;
  };
  assert.deepEqual(done('Max'), ['Max', 'quiet']);
  assert.deepEqual(done('all'), ['', 'quiet']);
  assert.deepEqual(done(''), ['', 'quiet']);
  assert.equal(resetLabel(status({policy: policy(HOUR)}), NOW)?.tone, 'quiet');
});

test('the most pressing news wins: announced, possible, just happened, limits changed', () => {
  assert.equal(key({scheduled: scheduled(NOW + HOUR), watch: watch(NOW + HOUR)}), 'in');
  assert.equal(key({watch: watch(NOW + HOUR), latest: latest(HOUR)}), 'possible');
  assert.equal(key({latest: latest(HOUR), policy: policy(HOUR)}), 'done');
  assert.equal(key({latest: latest(24 * HOUR), policy: policy(HOUR)}), 'policy', 'a reset older than a day gives way');
});

test('a reset is news for a day, a change of limits for three', () => {
  assert.equal(key({latest: latest(24 * HOUR - 1)}), 'done');
  assert.equal(key({latest: latest(24 * HOUR)}), null);
  assert.equal(key({policy: policy(72 * HOUR - 1)}), 'policy');
  assert.equal(key({policy: policy(72 * HOUR)}), null);
});

test('the post is linked apart from the credit only when it is not the tracker’s own page', () => {
  assert.equal(resetLabel(status({policy: policy(HOUR)}), NOW)?.link, null);
  const post = 'https://x.com/tracker/status/1';
  assert.equal(resetLabel(status({policy: {...policy(HOUR), url: post}}), NOW)?.link, post);
  // Codex falls back on Claude Resets, credited as Codex Resets.
  assert.equal(resetLabel(status({policy: {...policy(HOUR), url: 'https://claude-resets.example/'}}), NOW)?.link, 'https://claude-resets.example/');
});

test('a mark counts down in minutes within the hour, hours for two days, then days', () => {
  const cases: [number, string, string][] = [
    [20_000, '1m', '1 мин'],
    [59 * MIN + 59_000, '59m', '59 мин'],
    [60 * MIN, '1h', '1 ч'],
    [47 * HOUR + 59 * MIN, '47h', '47 ч'],
    [48 * HOUR, '2d', '2 д'],
    [3 * 24 * HOUR + 23 * HOUR, '3d', '3 д'],
  ];
  try {
    for (const [ms, en, ru] of cases) {
      setLocale('en');
      assert.equal(countdown(ms), en);
      setLocale('ru');
      assert.equal(countdown(ms), ru);
    }
  } finally {
    setLocale('en');
  }
});
