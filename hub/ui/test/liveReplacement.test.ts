import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,flush,NOW,M} from './periodRuntimeFixture';
import {Projection} from '../../server/projection';
import {sse} from '../../server/events';
import {SUBSCRIPTION_FUNDS} from '../../server/domain/widgets';
import {reduce,type HubEvent} from '../lib/board';

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

test('coalesced financial grants retire old resource evidence through ordinary actual SSE without replacing unrelated work',async t=>{
  t.mock.method(Date,'now',()=>NOW);const h=await fixture({ownerDevice:true,transportLive:true});
  try{
    const grant=(enabled:boolean,at:number)=>h.store.setBudget(h.board,h.source,h.owner,enabled,h.store.sources(h.board).find(s=>s.id===h.source)!.budget!.revision,at);
    const balance=(amount:string,at:number)=>h.store.record(h.source,{observedAt:at,staleAfterMs:M,plan:'pro',windows:[],resets:null,resourceStatus:{windows:'missing',resets:'missing'},balances:[{id:'balance:credits',unit:'credits:codex',status:'finite',amount,hasCredits:true}]});
    grant(true,NOW-200);balance('2500',NOW-100);
    h.store.currencies.setRate(h.alice.id,'credits:codex','USD','30000',0,NOW-M,'basePerUnit');
    const view=h.directory.view(h.board);h.directory.saveView(h.board,{...view,shown:[...view.shown,SUBSCRIPTION_FUNDS]},h.owner,NOW);
    h.events.flush();await flush();assert.equal(h.period.projectionState({range:'1h'},'funds').ready,true);
    const before=h.page.get().board!,work=h.period.get().value,oldTape=h.period.tapes.get('funds'),oldRevision=before.cards[h.source].budget!.revision;
    const gate=h.hold();h.events.history(h.source,NOW-100,['budget']);h.events.flush();await flush();assert.ok(h.period.transport.flights.size,'the old resource reply is held');
    h.frames.length=0;h.requests.length=0;let retired=false;
    const stop=h.page.listen(event=>{
      if(event.type==='hub'&&event.event.type==='card'&&event.event.data.id===h.source&&event.event.data.budget?.revision!==oldRevision){
        assert.equal(h.period.tapes.has('funds'),false,'the current grant card retires its prior tape before another reply');
        assert.equal([...h.period.transport.evidence().keys()].some((key:any)=>JSON.parse(key)[1]==='funds'),false);
        retired=true;
      }
    });
    balance('9911.23',NOW-50);grant(false,NOW-40);grant(true,NOW-30);const admittedAt=NOW-20;balance('7777',admittedAt);
    const wallet=h.store.source('deepseek','b'.repeat(24),admittedAt);h.store.hold(wallet,h.owner,admittedAt);h.store.share(h.board,wallet,h.owner,admittedAt);
    h.events.flush();await flush();stop();assert.equal(retired,true);assert.equal(h.frames.some(f=>f.type==='snapshot'),false,'a prepared current batch needs no work replacement');
    const actual=h.page.get(),fresh=new Projection(h.hub).snapshot(h.alice.id,h.board,NOW)!;
    assert.deepEqual(actual.board,reduce(actual,{type:'hub',event:{type:'snapshot',data:fresh} as HubEvent}).board,'the actual transport and reducer converge to the current projection');
    assert.equal(actual.board!.workAuthority,before.workAuthority);assert.equal(h.period.get().value,work,'financial policy preserves the complete work index');
    assert.equal(actual.board!.cards[h.source].budget!.anchor,admittedAt);assert.equal(actual.board!.cards[h.source].meters![0].amount,'7777');
    assert.deepEqual(actual.board!.currencies!.sources[h.source].map(binding=>binding.at),[admittedAt]);assert.equal(sse(h.frames).includes('991123'),false);
    gate.release();await flush();assert.notEqual(h.period.tapes.get('funds'),oldTape,'a late old-grant reply cannot restore retired evidence');
    assert.equal(h.period.projectionState({range:'1h'},'funds').ready,true);assert.equal(JSON.stringify(h.period.tapes.get('funds')).includes('991123'),false);
    assert.equal(h.page.get().connection.status,'live');
  }finally{await h.close();}
});
