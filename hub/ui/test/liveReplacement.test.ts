import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,M} from './periodRuntimeFixture';

test('replacement snapshots cross actual SSE and Live to retire work, presence and update the owner’s connections revision',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({ownerDevice:true,current:true,transportLive:true});
  try{
    assert.equal(h.page.get().connection.status,'live');assert.ok(h.period.get().rows[0].currentPresence);
    const before=h.page.get().board!,policy=h.store.sessionDevices(h.board,h.owner)[0],gate=h.hold();
    h.store.setDeviceSessions(h.board,h.device,h.owner,false,policy.revision,NOW);h.events.flush();await flush();
    const after=h.page.get().board!;
    assert.notEqual(after.workAuthority,before.workAuthority);assert.ok(after.connectionsRevision!>before.connectionsRevision!);
    assert.deepEqual(after.sessions[h.source],[]);assert.deepEqual(after.unattributedSessions,[]);
    assert.equal(h.period.get().rows.length,0,'the transport retires the old analytical cohort before a held replacement completes');assert.equal(h.period.getSource(h.source).length,0);assert.equal(h.period.get().value,null);
    assert.equal(h.page.get().connection.status,'live');gate.release();await flush();assert.equal(h.period.get().rows.length,0);
  }finally{await h.close();}
});

test('Live accepts new financial cards and funding/resource withdrawal from actual replacement snapshots',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({ownerDevice:true,current:true,transportLive:true,tableOnly:true});
  try{
    const gate=h.hold();h.store.unshare(h.board,h.source);h.events.flush();await flush();
    assert.equal(h.page.get().board!.cards[h.source],undefined);assert.equal(h.period.get().rows.length,0,'source withdrawal retires the old disclosed basis');
    gate.release();await flush();const row=h.period.get().rows[0];assert.equal(row.source,null);assert.equal(row.sourceStatus,'notProvided');assert.ok(row.currentPresence,'immutable presence binding survives public funding redaction');
    const wallet=h.store.source('openrouter','e'.repeat(24),NOW-M);h.store.hold(wallet,h.owner,NOW-M);h.store.share(h.board,wallet,h.owner,NOW-M,true);
    h.store.record(wallet,{type:'meters',observedAt:NOW,staleAfterMs:M,meters:[{id:'balance:USD',kind:'balance',unit:'USD',amount:'37000000',at:NOW,staleAfterMs:M,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null}],keys:[],inventoryComplete:true,inventoryError:null});h.events.flush();await flush();
    assert.equal(h.page.get().board!.cards[wallet].meters![0].amount,'37000000','a new money card reaches an already live page');
    h.store.unshare(h.board,wallet);h.events.flush();await flush();assert.equal(h.page.get().board!.cards[wallet],undefined,'revoked financial-only cards retire at the transport boundary');
    h.store.share(h.board,h.source,h.owner,NOW-M,true);h.store.record(h.source,{type:'meters',observedAt:NOW,staleAfterMs:M,meters:[{id:'balance:USD',kind:'balance',unit:'USD',amount:'12000000',at:NOW,staleAfterMs:M,stale:false,limit:null,resetAt:null,minutes:null,scope:null,label:null}],keys:[],inventoryComplete:true,inventoryError:null});h.events.flush();await flush();
    assert.equal(h.page.get().board!.cards[h.source].meters![0].amount,'12000000');
    const grant=h.store.sources(h.board).find(source=>source.id===h.source)!.budget!;h.store.setBudget(h.board,h.source,h.owner,false,grant.revision,NOW);h.events.flush();await flush();
    assert.deepEqual(h.page.get().board!.cards[h.source].meters??[],[],'optional funds withdraw without losing independent quota');assert.equal(h.page.get().board!.cards[h.source].windows.length,1);assert.equal(h.page.get().connection.status,'live');
  }finally{await h.close();}
});
