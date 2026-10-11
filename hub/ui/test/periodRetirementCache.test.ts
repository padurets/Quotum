import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,H} from './periodRuntimeFixture';
import {expandPeriod} from '../../server/domain/periodWire';
import {workedSessions} from '../../server/domain/periodWork';

test('retiring a monthly work prefix preserves already cached history within the shared budget',async t=>{
  const periodMs=30*24*H;
  let now=NOW;t.mock.method(Date,'now',()=>now);
  const h=await fixture({periodName:'30d',clocked:true,creditFrom:NOW-periodMs,creditTo:NOW,sessionMs:2*periodMs});
  // Another resource family's cold tiles can use the rest of the shared pool.
  // They remain evictable, so a full work-index rebuild would discard them.
  let cachedBytes=h.pool.budget-h.pool.estimatedBytes-96*1024,dropped=0,peak=h.pool.estimatedBytes;
  const cache={get estimatedBytes(){return cachedBytes;},evictionCandidates:()=>cachedBytes?[{bytes:cachedBytes,shownAt:0,drop(){cachedBytes=0;dropped++;}}]:[]};
  h.pool.register(cache);
  const reserve=h.pool.reserve.bind(h.pool);
  h.pool.reserve=(owner,bytes)=>{const result=reserve(owner,bytes);if(result)peak=Math.max(peak,h.pool.estimatedBytes);return result;};
  try{
    assert.ok(cachedBytes>0);
    const before=h.period.get().value,blocks=before.packed.blocks.length;
    assert.equal(h.period.get().rows[0].workedMs,periodMs);
    now=h.period.retirementAt;assert.equal(now,NOW+H);
    h.jump(now);await flush();
    assert.equal(h.period.get().error,null);
    assert.equal(h.period.get().value.packed.blocks.length,blocks-3,'the first expired hour leaves the retained ledger');
    assert.equal(dropped,0,'prefix cleanup must not evict already loaded history to rebuild unchanged work');
    assert.ok(peak<=h.pool.budget);
    assert.equal(h.requests.length,0,'clock-only cleanup does not reload evidence');
    const fresh=expandPeriod(JSON.parse(h.reader.read(h.board,h.alice.id,{version:1,selection:{mode:'live',periodMs},evaluatedAt:now,sessions:{}})));
    assert.ok(fresh.sessions&&fresh.sessions.state!=='error');
    const expected=workedSessions(fresh.sessions.value,fresh.basis.range,now);
    assert.equal(h.period.get().rows.length,expected.length);
    assert.equal(h.period.get().rows[0].workedMs,expected[0].workedMs);
    assert.equal(h.period.get().rows[0].lastWorkedAt,expected[0].lastWorkedAt);
    assert.equal(h.pool.estimatedBytes,h.period.estimatedBytes+cachedBytes,'all temporary reservations have been released');
  }finally{cachedBytes=0;h.pool.reserve=reserve;await h.close();}
});
