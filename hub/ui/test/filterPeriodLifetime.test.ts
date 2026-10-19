import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW} from './periodRuntimeFixture';
import {defaultFilters,workFilter} from '../../server/domain/dataFilters';
import {publishDataFilters} from '../lib/filterSelection';

test('changing filters while the selected baseline waits retires each generation and retains supplier evidence',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try{
    const a=defaultFilters();a.projects={mode:'include',values:['Work project']};
    const first=h.hold();publishDataFilters(a);h.period.changed();await flush();
    assert.equal(h.period.get().loading,true);
    const b=defaultFilters();b.projects={mode:'include',values:[]};
    publishDataFilters(b);h.period.changed();await flush();
    first.release();await flush();
    assert.equal(h.period.get().rows.length,0);assert.equal(h.period.get().error,null);
    assert.deepEqual(h.requests.at(-1)?.workFilter,workFilter(b));
    assert.ok(h.requests.filter(request=>request.quota?.evidence!=='skip'&&request.quota).length<=1,'a work-filter edit reuses its supplier baseline');
    publishDataFilters(a);h.period.changed();await flush();
    assert.equal(h.period.get().rows.length,1);assert.equal(h.pool.activeFlights,0);
  }finally{publishDataFilters(null,false);await h.close();}
});

test('an inherited oversized work selection keeps unfiltered recovery facets and never sends an oversized predicate',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try{
    const large=defaultFilters();large.projects={mode:'include',values:Array.from({length:1600},(_,i)=>String(i).padStart(4,'0')+'x'.repeat(60))};
    publishDataFilters(large);h.period.changed();const stop=h.period.demandFacets();await flush();
    assert.equal(h.period.get().error,'filters_limit');
    assert.ok(h.requests.every(request=>new TextEncoder().encode(JSON.stringify(request)).byteLength<=76*1024));
    assert.ok(h.requests.every(request=>!request.sessions&&!request.workFilter));
    assert.ok(h.period.getFacets().value?.projects.includes('Work project'),'recovery choices use the unfiltered authorized universe');
    stop();publishDataFilters(defaultFilters());h.period.changed();await flush();
    assert.equal(h.period.get().error,null);assert.equal(h.period.get().rows.length,1);
  }finally{publishDataFilters(null,false);await h.close();}
});
