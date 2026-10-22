import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,drawings,flush,NOW} from './periodRuntimeFixture';
import {PeriodAccounting} from '../lib/periodAccounting';

test('dropping a retained view cannot free accounting still owned by the current view',async t=>{
  t.mock.method(Date,'now',()=>NOW);
  const h=await fixture({personal:true}),drawing=await drawings(h);
  try{
    const period=h.period,quota=period.tapes.get('quota'),view=h.directory.view(h.board);
    assert.ok(quota.accounting.bytes>0);
    assert.equal(period.retained.size,0);
    h.directory.saveView(h.board,{...view,shown:['agents','quota-history','budget-history'],hidden:['activity']},h.alice.id,NOW+1);
    h.events.flush();await flush();
    assert.equal(period.tapes.get('quota').tape,quota.tape);
    assert.equal(period.tapes.get('quota').accounting,quota.accounting);
    assert.equal(period.retained.size,1);
    const [key,entry]=[...period.retained][0];
    const shared=period.estimatedBytes;
    const replacement=new PeriodAccounting(quota.tape,period.work.value,period.index?.curves);
    assert.notEqual(replacement,quota.accounting);
    period.tapes.set('quota',{...quota,accounting:replacement});period.measureBytes();
    assert.equal(period.estimatedBytes-shared,replacement.bytes,
      'a distinct accounting index remains charged while the retained view owns the original');
    period.tapes.set('quota',quota);period.measureBytes();
    assert.equal(period.estimatedBytes,shared);
    const before=period.estimatedBytes,poolBefore=h.pool.estimatedBytes;
    period.retained.delete(key);
    const released=before-period.estimatedBytes;
    assert.ok(released<=entry.bytes-entry.activityBytes-quota.accounting.bytes,
      `dropping another owner freed ${released} bytes including still-current accounting`);
    assert.equal(poolBefore-h.pool.estimatedBytes,released,'the pool releases only the actual marginal storage');
  }finally{drawing.close();await h.close();}
});
