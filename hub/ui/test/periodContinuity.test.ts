import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Projection} from '../../server/projection';
import {workedSessions} from '../../server/domain/periodWork';
import {fixture,drawings,consumer,quotaCells,flush,NOW,M} from './periodRuntimeFixture';

for(const failure of [false,true])test(`a reconnect retires revoked work through the final SVG, legend and quota text while its baseline ${failure?'fails':'waits'}`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture(),d=await drawings(h);
  try {
    const c=consumer({...h,...d}),before=c.settle(),presentation=d.loader.get().presentation;
    assert.ok(before.paths.length);assert.deepEqual(before.names,['Work project']);assert.equal(quotaCells(h,d).work.content,'1m');
    h.disconnect();h.remove();const gate=h.hold();h.reconnect();await flush();
    assert.deepEqual(h.frames.map(f=>f.type),['hello','snapshot'],'a new stream does not replay the missing cutoff');
    if(failure){gate.reject(new Error('unavailable'));await flush();}
    const fresh=h.fresh();assert.equal(workedSessions((fresh.sessions as any).value,fresh.basis.range,NOW).length,0);
    assert.equal(h.period.get().rows.length,0);assert.ok(d.loader.get().presentation>presentation);
    const current=c.settle();assert.deepEqual(current.names,[]);assert.deepEqual(current.paths,[]);
    assert.equal(quotaCells(h,d).work.content,'—');assert.equal(quotaCells(h,d).agenthours.content,'—');
    if(!failure){gate.release();await flush();}
  } finally {d.close();await h.close();}
});

for(const failure of [false,true])test(`an unchanged work identity preserves all complete presentations through a ${failure?'failed':'pending'} reconnect`,async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture(),d=await drawings(h);
  try {
    const c=consumer({...h,...d}),before=c.settle(),quota=quotaCells(h,d),presentation=d.loader.get().presentation;
    h.disconnect();const gate=h.hold();h.reconnect();await flush();
    if(failure){gate.reject(new Error('unavailable'));await flush();}
    assert.deepEqual(c.settle(),before);assert.deepEqual(quotaCells(h,d),quota);
    assert.equal(h.period.get().rows.length,1);assert.equal(d.loader.get().presentation,presentation);
    if(!failure){gate.release();await flush();}
  } finally {d.close();await h.close();}
});

test('an unknown legacy snapshot cannot prove continuity, and a late old reply cannot restore revoked work',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture(),d=await drawings(h);
  try {
    const c=consumer({...h,...d});assert.ok(c.settle().paths.length);
    const old=h.hold();h.event({type:'history',data:{sources:[h.source],since:NOW-3*M,changes:[{source:h.source,scope:'quota',since:NOW-3*M,workSince:NOW-3*M}]}});await flush();
    h.disconnect();h.remove();const next=h.hold();h.reconnect();await flush();
    old.release();await flush();assert.equal(h.period.get().rows.length,0);assert.deepEqual(c.settle().paths,[]);
    next.release();await flush();assert.equal(h.period.get().rows.length,0);
    const snapshot=new Projection(h.hub).snapshot(h.alice.id,h.board,NOW)!;
    const {workAuthority:_authority,...legacy}=snapshot;
    const presentation=d.loader.get().presentation,gate=h.hold();h.event({type:'snapshot',data:legacy});await flush();
    assert.ok(d.loader.get().presentation>presentation);assert.equal(d.render().history,null);
    gate.release();await flush();
  } finally {d.close();await h.close();}
});

test('overview, stream, new and lost leases and financial replacement snapshots share the existing opaque work identity',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try {
    const expected=()=>h.store.workKey(h.board,h.store.shown(h.board,h.directory.view(h.board).hidden));
    assert.equal(new Projection(h.hub).snapshot(h.alice.id,h.board,NOW)!.workAuthority,expected());
    assert.equal(h.page.get().board!.workAuthority,expected());
    const reader={user:h.alice.id,secret:'fixture-session',board:h.board};
    for(const lease of [undefined,'lost-lease']){
      const reply=await h.events.poll(reader,lease);assert.ok(reply&&reply!=='limit');
      assert.equal(JSON.parse(reply.frames.find(f=>f.type==='snapshot')!.data).workAuthority,expected());
    }
    const lease=await h.events.poll(reader,undefined);assert.ok(lease&&lease!=='limit');
    const revision=h.store.sources(h.board)[0].budget!.revision;
    h.store.setBudget(h.board,h.source,h.alice.id,true,revision,NOW);h.events.flush();await flush();
    const delivered=await h.events.poll(reader,lease.lease);assert.ok(delivered&&delivered!=='limit');
    const replacement=delivered.frames.find(f=>f.type==='snapshot');assert.ok(replacement);
    assert.equal(JSON.parse(replacement.data).workAuthority,expected());
  } finally {await h.close();}
});

test('a known lease retains the authority cutoff instead of replacing it with a snapshot',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture();
  try {
    const reader={user:h.alice.id,secret:'fixture-session',board:h.board};
    const first=await h.events.poll(reader,undefined);assert.ok(first&&first!=='limit');
    h.disconnect();h.remove();const gate=h.hold(),next=await h.events.poll(reader,first.lease);assert.ok(next&&next!=='limit');
    const changes=next.frames.filter(f=>f.type==='history').map(f=>JSON.parse(f.data));
    assert.ok(changes.some(c=>c.changes.some((x:any)=>x.workSince===0)));
    for(const f of next.frames)h.event({type:f.type,data:JSON.parse(f.data)} as any);
    await flush();assert.equal(h.period.get().rows.length,0);assert.equal(h.page.get().board!.workAuthority,changes[0].workAuthority);
    gate.release();await flush();
  } finally {await h.close();}
});
