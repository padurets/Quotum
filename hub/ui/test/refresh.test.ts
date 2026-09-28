import {test} from 'node:test';
import assert from 'node:assert/strict';
import {refreshChangesAt, refreshPending, refreshText, refreshErrorText, refreshErrorChangesAt, requestRefreshAll, startRefreshRows, observeRefreshRows, answerRefreshRow} from '../lib/refresh';
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

test('the full receipt includes pending cards and never calls an old result a new success', () => {
  const old = {...queued, request: {...queued.request!, status: 'updated' as const, finishedAt: 20_000}};
  const rows = startRefreshRows(['old', 'pending', 'new', 'old'], {old, pending: queued});
  assert.deepEqual(rows.map(row => [row.id, row.status]), [['old', 'sending'], ['pending', 'queued'], ['new', 'sending']]);
  const answered = answerRefreshRow(rows[0], old);
  assert.equal(answered.status, 'waiting');
  assert.equal(observeRefreshRows([answered], {old})[0].status, 'waiting');
  const fresh = {...old, request: {...old.request, requestedAt: 80_000, finishedAt: 90_000}};
  assert.equal(observeRefreshRows([answered], {old: fresh})[0].status, 'updated');
});

test('each completed outcome stays in the receipt after retirement or a different request', () => {
  const rows = startRefreshRows(['a', 'b'], {a: queued, b: queued});
  const updated = {...queued, request: {...queued.request!, status: 'updated' as const, finishedAt: 20_000}};
  const failed = {...queued, request: {...queued.request!, status: 'failed' as const, finishedAt: 21_000}};
  const finished = observeRefreshRows(rows, {a: updated, b: failed});
  assert.deepEqual(finished.map(row => row.status), ['updated', 'failed']);
  assert.equal(observeRefreshRows(finished, {a: {...queued, request: null}, b: queued}, true), finished);
});

test('a late HTTP error cannot replace an event proving that the data arrived', () => {
  const row = startRefreshRows(['a'], {})[0];
  const updated = {...queued, request: {...queued.request!, status: 'updated' as const, finishedAt: 20_000}};
  const observed = observeRefreshRows([row], {a: updated})[0];
  assert.equal(answerRefreshRow(observed, updated, new Error('lost response')), observed);
});

test('refusals stay separate from accepted requests and a lost reply can be resolved by events', () => {
  const rows = startRefreshRows(['a', 'b'], {});
  const error = new ApiError(409, 'refresh_unavailable');
  const refused = answerRefreshRow(rows[0], {...queued, request: null, unavailable: 'unsupported'}, error);
  const uncertain = answerRefreshRow(rows[1], undefined, new Error('lost response'));
  assert.equal(refused.status, 'refused');
  assert.equal(refused.error, error);
  assert.equal(uncertain.status, 'unknown');
  const received = observeRefreshRows([refused, uncertain], {b: queued});
  assert.equal(received[0], refused);
  assert.equal(received[1].status, 'queued');
  assert.equal(received[1].error, null);
});

test('reconnecting after a missed outcome does not invent success or leave a loader forever', () => {
  const rows = startRefreshRows(['a'], {a: queued});
  assert.equal(observeRefreshRows(rows, {a: {...queued, request: null}}, true)[0].status, 'unknown');
  assert.equal(observeRefreshRows(rows, {}, true)[0].status, 'unknown');
});

test('refreshing a board deduplicates subscriptions, limits concurrency and continues after refusals', async () => {
  const called: string[] = [];
  let running = 0;
  let peak = 0;
  const rejected = new ApiError(429, 'refresh_too_soon');
  const result = await requestRefreshAll('board', ['a', 'b', 'a', 'c', 'd', 'e', 'f'], async (board, id) => {
    assert.equal(board, 'board');
    called.push(id);
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setImmediate(resolve));
    running--;
    if (id === 'b') throw rejected;
  });
  assert.equal(peak, 4);
  assert.deepEqual(called.sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(result, {total: 6, accepted: 5, failures: [{id: 'b', error: rejected}]});
});

test('leaving the board stops requests that have not started', async () => {
  let current = true;
  const called: string[] = [];
  await requestRefreshAll('board', ['a', 'b', 'c', 'd', 'e', 'f'], async (_board, id) => {
    called.push(id);
    await new Promise(resolve => setImmediate(resolve));
    current = false;
  }, () => current);
  assert.deepEqual(called, ['a', 'b', 'c', 'd']);
  const empty = await requestRefreshAll('board', [], async () => assert.fail('no request for an empty board'));
  assert.deepEqual(empty, {total: 0, accepted: 0, failures: []});
});

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
