import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isSending, refreshAllStarts, refreshRowPending, refreshChangesAt, refreshPending, refreshText, refreshErrorText, refreshErrorChangesAt, requestRefresh, requestRefreshAll, startRefreshRows, observeRefreshRows, answerRefreshRow} from '../lib/refresh';
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
  const another = {...queued, request: {...queued.request!, requestedAt: 80_000}};
  assert.equal(observeRefreshRows(finished, {a: {...queued, request: null}, b: another}, true), finished);
  assert.equal(observeRefreshRows(finished, {a: another, b: another}), finished, 'a later request is not this outcome');
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
  await requestRefreshAll('board', ['a', 'b', 'a', 'c', 'd', 'e', 'f'], async (board, id) => {
    assert.equal(board, 'board');
    called.push(id);
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setImmediate(resolve));
    running--;
    if (id === 'b') throw rejected;
  });
  assert.equal(peak, 4);
  assert.deepEqual(called.sort(), ['a', 'b', 'c', 'd', 'e', 'f'], 'the refusal of b stops no other card');
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
  await requestRefreshAll('board', [], async () => assert.fail('no request for an empty board'));
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

test('a request followed to its end unseen settles as unknown, and nobody else\'s request takes its place', () => {
  const [row] = startRefreshRows(['a'], {a: queued});
  const waiting = observeRefreshRows([row], {a: {...queued, request: {...queued.request!, status: 'waiting', dispatchAt: 300_000}}});
  assert.equal(waiting[0].status, 'waiting');
  // A laptop asleep past the deadline and the minute after it: the hub says only that nothing is pending.
  const gone = observeRefreshRows(waiting, {a: {...queued, request: null}});
  assert.equal(gone[0].status, 'unknown');
  const later = {...queued, request: {...queued.request!, requestedAt: 900_000}};
  assert.equal(observeRefreshRows(gone, {a: later}), gone);
  const replaced = observeRefreshRows(waiting, {a: later});
  assert.equal(replaced[0].status, 'unknown', 'a newer request is not the one this row followed');
});

test('an accepted row whose request no event has shown yet still takes it after a lineup', () => {
  const [row] = startRefreshRows(['a'], {a: {...queued, request: null}});
  const accepted = answerRefreshRow(row, {...queued, request: null});
  assert.equal(accepted.status, 'waiting');
  // A lineup sent before the request was accepted may come after its reply.
  const early = observeRefreshRows([accepted], {a: {...queued, request: null}}, true);
  assert.equal(early[0].status, 'unknown');
  assert.equal(observeRefreshRows(early, {a: queued})[0].status, 'queued');
});

test('an accepted row that missed its request settles as unknown when a reconnect shows only a later one', () => {
  const [row] = startRefreshRows(['a'], {a: {...queued, request: null}});
  const accepted = answerRefreshRow(row, {...queued, request: null}, null, 20_000);
  const later = {...queued, request: {...queued.request!, requestedAt: 80_000}};
  const reconnected = observeRefreshRows([accepted], {a: later}, true);
  assert.deepEqual([reconnected[0].status, refreshRowPending(reconnected[0])], ['unknown', false]);
});

test('a refusal is the outcome of its row, whatever is requested after it', () => {
  const [row] = startRefreshRows(['a'], {});
  const refused = answerRefreshRow(row, {...queued, request: null}, new ApiError(429, 'refresh_too_soon'));
  assert.equal(refused.status, 'refused');
  assert.equal(observeRefreshRows([refused], {a: {...queued, request: {...queued.request!, requestedAt: 80_000}}})[0], refused);
});

test('the header list opens on its last attempt; only a first open starts one', () => {
  assert.equal(refreshAllStarts([]), true);
  const finished = observeRefreshRows(startRefreshRows(['a'], {a: queued}), {a: {...queued, request: {...queued.request!, status: 'updated', finishedAt: 20_000}}});
  assert.equal(refreshAllStarts(finished), false);
  assert.equal(refreshAllStarts(startRefreshRows(['a'], {})), false);
});

test('a card waits out whichever ends later, its cooldown or its pause', () => {
  const state: Refresh = {unavailable: 'paused', availableAt: 600_000, retryAt: 60_000, request: {...queued.request!, status: 'failed', finishedAt: 20_000}};
  assert.match(refreshText(state, 30_000), /try again in 9m\n/);
  assert.ok(refreshChangesAt(state, 30_000)! > 60_000, 'the end of the cooldown changes nothing shown');
  assert.match(refreshErrorText(new ApiError(429, 'refresh_too_soon'), state, 30_000), /try again in 9m\n/);
});

test('a queued request past its earliest moment shows no time already gone', () => {
  const text = refreshText(queued, 300_000);
  assert.match(text, /Waiting for new limits/);
  assert.equal(text.split('\n').length, 1);
});

test('asking again for a card before the hub answers sends nothing more and gets the same answer', async t => {
  const answers: ((response: Response) => void)[] = [];
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => answers.push(resolve)));
  assert.equal(isSending('board', 'a'), false);
  const first = requestRefresh('board', 'a');
  const second = requestRefresh('board', 'a');
  const other = requestRefresh('board', 'b');
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual([isSending('board', 'a'), isSending('board', 'b'), isSending('elsewhere', 'a')], [true, true, false], 'the card\'s menu waits too');
  for (const answer of answers) answer(new Response(JSON.stringify({error: 'refresh_too_soon'}), {status: 429}));
  await assert.rejects(first, ApiError);
  await assert.rejects(second, ApiError);
  await assert.rejects(other, ApiError);
  assert.deepEqual([isSending('board', 'a'), isSending('board', 'b')], [false, false], 'a refusal frees the card');
  const again = requestRefresh('board', 'a');
  assert.equal(fetch.mock.callCount(), 3, 'once answered, a new request goes');
  answers.at(-1)!(new Response(JSON.stringify({ok: true}), {status: 202}));
  await again;
  assert.equal(isSending('board', 'a'), false);
});

test('a row that has not seen its request takes only one made before its reply', () => {
  const [row] = startRefreshRows(['a'], {a: {...queued, request: null}});
  const later = {...queued, request: {...queued.request!, requestedAt: 80_000}};
  const own = {...queued, request: {...queued.request!, requestedAt: 19_500}};
  // The reply was lost on the way: the request may or may not have been made.
  const lost = answerRefreshRow(row, {...queued, request: null}, new Error('lost response'), 20_000);
  assert.equal(observeRefreshRows([lost], {a: later})[0].status, 'unknown', 'made a minute after the reply: someone else\'s');
  assert.equal(observeRefreshRows([lost], {a: own})[0].status, 'queued');
  // The page reads the hub's clock a little off: a request up to half a minute past the reply is still its own.
  assert.equal(observeRefreshRows([lost], {a: {...queued, request: {...queued.request!, requestedAt: 49_999}}})[0].status, 'queued');
  // Accepted, then a lineup before its event: the event may still come, a later request is not it.
  const early = observeRefreshRows([answerRefreshRow(row, {...queued, request: null}, null, 20_000)], {a: {...queued, request: null}}, true);
  assert.equal(early[0].status, 'unknown');
  assert.equal(observeRefreshRows(early, {a: later})[0].status, 'unknown');
  assert.equal(observeRefreshRows(early, {a: own})[0].status, 'queued');
});
