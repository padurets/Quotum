import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionReader} from '../lib/sessionReader';
import type {Session} from '../lib/session';

const session = (available: boolean, person = 'alice'): Session => ({user: {id: person, email: `${person}@example.com`, name: person}, boards: [], signup: {first: false, open: false}, local: false, trustedKeys: {available, reason: available ? null : 'secret_key_missing'}});
function harness() {
  const pending: {resolve(session: Session): void; reject(): void}[] = [];
  const accepted: Session[] = [], failures: boolean[] = [];
  const reader = new SessionReader(() => new Promise<Session>((resolve, reject) => pending.push({resolve, reject: () => reject(new Error('offline'))})), next => accepted.push(next), failed => failures.push(failed));
  return {reader, pending, accepted, failures};
}
test('capability changes in either direction survive an older out-of-order session response', async () => {
  for (const initial of [false, true]) {
    const h = harness(); const old = h.reader.refresh(), next = h.reader.refresh();
    h.pending[1].resolve(session(!initial)); await next;
    h.pending[0].resolve(session(initial)); await old;
    assert.deepEqual(h.accepted, [session(!initial)]);
  }
});
test('a direct authentication answer replaces all private fields and cancels older success and failure callbacks', async () => {
  for (const failure of [false, true]) {
    const h = harness(); const old = h.reader.refresh();
    h.reader.accept(session(true, 'bob'));
    if (failure) h.pending[0].reject(); else h.pending[0].resolve(session(false));
    await old;
    assert.deepEqual(h.accepted, [session(true, 'bob')]);
    assert.deepEqual(h.failures, [false], 'a stale failure cannot start retries');
    const anonymous: Session = {user: null, boards: [], signup: {first: false, open: false}, local: false};
    h.reader.accept(anonymous); assert.equal(h.accepted.at(-1)?.trustedKeys, undefined);
  }
});
test('unmount invalidates pending answers, while a current failure still permits retry', async () => {
  const h = harness(); const cancelled = h.reader.refresh(); h.reader.invalidate(); h.pending[0].reject(); await cancelled;
  assert.deepEqual(h.accepted, []); assert.deepEqual(h.failures, []);
  const failed = h.reader.refresh(); h.pending[1].reject(); await failed; assert.deepEqual(h.failures, [true]);
  const retried = h.reader.refresh(); h.pending[2].resolve(session(true)); await retried; assert.deepEqual(h.failures, [true, false]);
});
