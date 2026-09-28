import {test} from 'node:test';
import assert from 'node:assert/strict';
import {refreshChangesAt, refreshPending, refreshText, refreshErrorText, refreshErrorChangesAt} from '../lib/refresh';
import {ApiError} from '../lib/http';
import {setLocale} from '../i18n';
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
  assert.match(refreshText(state, 450_000), /Waiting for new limits/);
  assert.doesNotMatch(refreshText(state, 450_000), /stopped|Next request/);
  assert.equal(refreshChangesAt(state, 450_000), null);
});

test('a refused refresh explains the next step, without implying an old result answered this click', () => {
  const unavailable = new ApiError(409, 'refresh_unavailable');
  setLocale('ru');
  try {
    const state: Refresh = {...queued, unavailable: 'unsupported', request: {...queued.request!, status: 'updated', finishedAt: 11_000}};
    const message = refreshErrorText(unavailable, state, 12_000);
    assert.match(message, /не принимает запросы на обновление/);
    assert.match(message, /Обновите Quotum/);
    assert.doesNotMatch(message, /темп|хаб|Лимиты обновлены/);
    const cooldown = refreshErrorText(new ApiError(429, 'refresh_too_soon'), state, 12_000);
    assert.match(cooldown, /раз в минуту/);
    assert.doesNotMatch(cooldown, /Лимиты обновлены/);
    assert.match(refreshErrorText(new ApiError(502, '502'), state, 12_000), /Попробуйте позже/);
  } finally {
    setLocale('en');
  }
});

test('a refusal countdown changes only at its declared clock boundary', () => {
  const error = new ApiError(429, 'refresh_too_soon');
  const state = {...queued, retryAt: 300_000};
  for (let now = 10_000; now < 400_000;) {
    const next = refreshErrorChangesAt(error, state, now) ?? 400_000;
    assert.ok(next > now);
    for (const at of [now + 1, Math.floor((now + next) / 2), next - 1])
      assert.equal(refreshErrorText(error, state, at), refreshErrorText(error, state, now));
    now = next;
  }
});
