import {test} from 'node:test';
import assert from 'node:assert/strict';
import {refreshChangesAt, refreshPending, refreshText} from '../lib/refresh';
import type {Refresh} from '../lib/types';

const queued: Refresh = {
  unavailable: null,
  availableAt: null,
  retryAt: 70_000,
  request: {
    requestedAt: 10_000,
    notBefore: 300_000,
    dispatchAt: null,
    deadline: 600_000,
    status: 'queued',
    finishedAt: null,
  },
};

test('refresh wording stays identical until its declared next clock boundary', () => {
  for (const state of [
    queued,
    {...queued, request: null},
    {...queued, request: {...queued.request!, status: 'waiting' as const}, unavailable: 'silent' as const},
  ]) {
    let now = 10_000;
    while (now < 700_000) {
      const at = refreshChangesAt(state, now) ?? 700_000;
      assert.ok(at > now);
      for (const sample of [now + 1, Math.floor((now + at) / 2), at - 1]) assert.equal(refreshText(state, sample), refreshText(state, now));
      now = at;
    }
  }
});

test('silence does not replace waiting with a negative result or show its past scheduling time', () => {
  const state: Refresh = {...queued, unavailable: 'silent', request: {...queued.request!, status: 'waiting', dispatchAt: 300_000}};
  assert.equal(refreshPending(state), true);
  assert.match(refreshText(state, 450_000), /Waiting for fresh data/);
  assert.doesNotMatch(refreshText(state, 450_000), /stopped|Next request/);
  assert.equal(refreshChangesAt(state, 450_000), null);
});
